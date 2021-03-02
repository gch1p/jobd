const Queue = require('queue')
const child_process = require('child_process')
const db = require('./db')
const {timestamp} = require('./util')
const {getLogger} = require('./logger')
const EventEmitter = require('events')
const config = require('./config')

const STATUS_WAITING  = 'waiting'
const STATUS_MANUAL   = 'manual'
const STATUS_ACCEPTED = 'accepted'
const STATUS_IGNORED  = 'ignored'
const STATUS_RUNNING  = 'running'
const STATUS_DONE     = 'done'

const RESULT_OK   = 'ok'
const RESULT_FAIL = 'fail'

const JOB_ACCEPTED = 0x01
const JOB_IGNORED  = 0x02
const JOB_NOTFOUND = 0x03

class Worker extends EventEmitter {

    constructor() {
        super()

        /**
         * @type {object.<string, {slots: object.<string, {limit: number, queue: Queue}>}>}
         */
        this.targets = {}

        /**
         * @type {boolean}
         */
        this.polling = false

        /**
         * @type {boolean}
         */
        this.nextpoll = {}

        /**
         * @type {Logger}
         */
        this.logger = getLogger('Worker')
    }

    /**
     * Creates new queue.
     *
     * @param {string} target
     * @param {string} slot
     * @param {number} limit
     */
    addSlot(target, slot, limit) {
        this.logger.debug(`addSlot: adding slot '${slot}' for target' ${target}' (limit: ${limit})`)

        if (this.targets[target] === undefined)
            this.targets[target] = {slots: {}}

        if (this.targets[target].slots[slot] !== undefined)
            throw new Error(`slot ${slot} for target ${target} has already been added`)

        let queue = Queue({
            concurrency: limit,
            autostart: true
        })
        queue.on('success', this.onJobFinished.bind(this, target, slot))
        queue.on('error', this.onJobFinished.bind(this, target, slot))
        queue.start()

        this.targets[target].slots[slot] = {limit, queue}
    }

    /**
     * Checks whether target is being served.
     *
     * @param {string} target
     * @returns {boolean}
     */
    hasTarget(target) {
        return (target in this.targets)
    }

    /**
     * Returns status of all queues.
     *
     * @return {object}
     */
    getStatus() {
        let status = {targets: {}}
        for (const targetName in this.targets) {
            let target = this.targets[targetName]
            status.targets[targetName] = {}
            for (const slotName in target.slots) {
                const {queue, limit} = target.slots[slotName]
                status.targets[targetName][slotName] = {
                    concurrency: queue.concurrency,
                    limit,
                    length: queue.length,
                }
            }
        }
        return status
    }

    /**
     * Returns list of serving targets.
     *
     * @return {string[]}
     */
    getTargets() {
        return Object.keys(this.targets)
    }

    /**
     *
     */
    poll() {
        const LOGPREFIX = `poll():`

        let targets = this.getPollTargets()
        if (!targets.length) {
            this.poller.warn(`${LOGPREFIX} no targets`)
            return
        }

        // skip and postpone the poll, if we're in the middle on another poll
        // it will be called again from the last .then() at the end of this method
        if (this.polling) {
            this.logger.debug(`${LOGPREFIX} already polling`)
            return
        }

        // skip and postpone the poll, if no free slots
        // it will be called again from onJobFinished()
        if (!this.hasFreeSlots(targets)) {
            this.logger.debug(`${LOGPREFIX} no free slots`)
            return
        }

        // set polling flag
        this.polling = true

        // clear postponed polls target list
        this.setPollTargets()

        this.logger.debug(`${LOGPREFIX} calling getTasks(${JSON.stringify(targets)})`)
        this.getTasks(targets)
            .then(({rowsCount}) => {
                let message = `${LOGPREFIX} ${rowsCount} processed`
                if (config.get('mysql_fetch_limit') && rowsCount >= config.get('mysql_fetch_limit')) {
                    // it seems, there are more, so we'll need to perform another query
                    this.setPollTargets(targets)
                    message += `, scheduling more polls (targets: ${JSON.stringify(this.getPollTargets())})`
                }
                this.logger.debug(message)
            })
            .catch((error) => {
                this.logger.error(`${LOGPREFIX}`, error)
                //this.setPollTargets(targets)
            })
            .then(() => {
                // unset polling flag
                this.polling = false

                // perform another poll, if needed
                if (this.getPollTargets().length > 0) {
                    this.logger.debug(`${LOGPREFIX} next poll scheduled, calling poll() again`)
                    this.poll()
                }
            })
    }

    /**
     * @param {string|string[]|null} target
     */
    setPollTargets(target) {
        // when called without parameter, remove all targets
        if (target === undefined) {
            this.nextpoll = {}
            return
        }

        // just a fix
        if (target === 'null')
            target = null

        if (Array.isArray(target)) {
            target.forEach(t => {
                this.nextpoll[t] = true
            })
        } else {
            if (target === null)
                this.nextpoll = {}
            this.nextpoll[target] = true
        }
    }

    /**
     * @return {string[]}
     */
    getPollTargets() {
        if (null in this.nextpoll)
            return Object.keys(this.targets)

        return Object.keys(this.nextpoll)
    }

    /**
     * @param {string} target
     * @return {boolean}
     */
    hasPollTarget(target) {
        return target in this.nextpoll || null in this.nextpoll
    }

    /**
     * Get new tasks from database.
     *
     * @param {string|null|string[]} target
     * @param {string} neededStatus
     * @param {{ids: number[]}} data
     * @returns
     *  {Promise<{
     *    results: Map<number, {status: number, reason: string, slot: string, target: string}>,
     *    rowsCount: number
     *  }>}
     */
    async getTasks(target = null, neededStatus = STATUS_WAITING, data = {}) {
        const LOGPREFIX = `getTasks(${JSON.stringify(target)}, '${neededStatus}', ${JSON.stringify(data)}):`

        // get new jobs in transaction
        await db.beginTransaction()

        /**
         * @type {Map<number, {status: number, reason: string, slot: string, target: string}>}
         */
        const jobsResults = new Map()

        let sqlFields = `id, status, target, slot`
        let sql
        if (data.ids) {
            sql = `SELECT ${sqlFields} FROM ${config.get('mysql_table')} WHERE id IN(`+data.ids.map(db.escape).join(',')+`) FOR UPDATE`
        } else {
            let targets
            if (target === null) {
                targets = Object.keys(this.targets)
            } else if (!Array.isArray(target)) {
                targets = [target]
            }  else {
                targets = target
            }
            let sqlLimit = config.get('mysql_fetch_limit') !== 0 ? ` LIMIT 0, ${config.get('mysql_fetch_limit')}` : ''
            let sqlWhere = `status=${db.escape(neededStatus)} AND target IN (`+targets.map(db.escape).join(',')+`)`
            sql = `SELECT ${sqlFields} FROM ${config.get('mysql_table')} WHERE ${sqlWhere} ORDER BY id ${sqlLimit} FOR UPDATE`
        }

        /** @type {object[]} results */
        let rows = await db.query(sql)
        this.logger.trace(`${LOGPREFIX} query result:`, rows)

        for (let result of rows) {
            const id = parseInt(result.id)
            const slot = String(result.slot)
            const target = String(result.target)
            const status = String(result.status)

            if (status !== neededStatus) {
                let reason = `status = ${status} != ${neededStatus}`
                jobsResults.set(id, {
                    result: JOB_IGNORED,
                    reason
                })

                this.logger.warn(`${LOGPREFIX} ${reason}`)
                continue
            }

            if (!target || this.targets[target] === undefined) {
                let reason = `target '${target}' not found (job id=${id})`
                jobsResults.set(id, {
                    result: JOB_IGNORED,
                    reason
                })

                this.logger.error(`${LOGPREFIX} ${reason}`)
                continue
            }

            if (!slot || this.targets[target].slots[slot] === undefined) {
                let reason = `slot '${slot}' of target '${target}' not found (job id=${id})`
                jobsResults.set(id, {
                    result: JOB_IGNORED,
                    reason
                })

                this.logger.error(`${LOGPREFIX} ${reason}`)
                continue
            }

            this.logger.debug(`${LOGPREFIX} accepted target='${target}', slot='${slot}', id=${id}`)

            jobsResults.set(id, {
                result: JOB_ACCEPTED,
                target,
                slot
            })
        }

        if (data.ids) {
            for (const id of data.ids) {
                if (!jobsResults.has(id))
                    jobsResults.set(id, {
                        result: JOB_NOTFOUND
                    })
            }
        }

        let accepted = [], ignored = []
        for (const [id, jobResult] of jobsResults.entries()) {
            const {result} = jobResult
            switch (result) {
                case JOB_ACCEPTED:
                    accepted.push(id)
                    break

                case JOB_IGNORED:
                    ignored.push(id)
                    break
            }
        }

        if (accepted.length)
            await db.query(`UPDATE ${config.get('mysql_table')} SET status='accepted' WHERE id IN (`+accepted.join(',')+`)`)

        if (ignored.length)
            await db.query(`UPDATE ${config.get('mysql_table')} SET status='ignored' WHERE id IN (`+ignored.join(',')+`)`)

        await db.commit()

        for (const [id, jobResult] of jobsResults.entries()) {
            const {result} = jobResult
            if (result !== JOB_ACCEPTED)
                continue

            const {slot, target} = jobResult
            this.enqueueJob(id, target, slot)
        }

        return {
            results: jobsResults,
            rowsCount: rows.length,
        }
    }

    /**
     * Enqueue job.
     *
     * @param {int} id
     * @param {string} target
     * @param {string} slot
     */
    enqueueJob(id, target, slot) {
        const queue = this.targets[target].slots[slot].queue
        queue.push(async (cb) => {
            let data = {
                code: null,
                signal: null,
                stdout: '',
                stderr: ''
            }
            let result = RESULT_OK

            try {
                await this.setJobStatus(id, STATUS_RUNNING)

                Object.assign(data, (await this.run(id)))
                if (data.code !== 0)
                    result = RESULT_FAIL
            } catch (error) {
                this.logger.error(`job ${id}: error while run():`, error)
                result = RESULT_FAIL
                data.stderr = (error instanceof Error) ? (error.message + '\n' + error.stack) : (error + '')
            } finally {
                this.emit('job-done', {
                    id,
                    result,
                    ...data
                })

                try {
                    await this.setJobStatus(id, STATUS_DONE, result, data)
                } catch (error) {
                    this.logger.error(`setJobStatus(${id})`, error)
                }

                cb()
            }
        })
    }

    /**
     * Run job.
     *
     * @param {number} id
     */
    async run(id) {
        let command = config.get('launcher').replace(/\{id\}/g, id)
        let args = command.split(/ +/)
        return new Promise((resolve, reject) => {
            this.logger.info(`run(${id}): launching`, args)

            let process = child_process.spawn(args[0], args.slice(1), {
                maxBuffer: config.get('max_output_buffer')
            })

            let stdoutChunks = []
            let stderrChunks = []

            process.on('exit',
                /**
                 * @param {null|number} code
                 * @param {null|string} signal
                 */
                (code, signal) => {
                    let stdout = stdoutChunks.join('')
                    let stderr = stderrChunks.join('')

                    stdoutChunks = undefined
                    stderrChunks = undefined

                    resolve({
                        code,
                        signal,
                        stdout,
                        stderr
                    })
                })

            process.on('error', (error) => {
                reject(error)
            })

            process.stdout.on('data', (data) => {
                if (data instanceof Buffer)
                    data = data.toString('utf-8')
                stdoutChunks.push(data)
            })

            process.stderr.on('data', (data) => {
                if (data instanceof Buffer)
                    data = data.toString('utf-8')
                stderrChunks.push(data)
            })
        })
    }

    /**
     * Write job status to database.
     *
     * @param {number} id
     * @param {string} status
     * @param {string} result
     * @param {object} data
     * @return {Promise<void>}
     */
    async setJobStatus(id, status, result = RESULT_OK, data = {}) {
        let update = {
            status,
            result
        }
        switch (status) {
            case STATUS_RUNNING:
            case STATUS_DONE:
                update[status === STATUS_RUNNING ? 'time_started' : 'time_finished'] = timestamp()
                break
        }
        if (data.code !== undefined)
            update.return_code = data.code
        if (data.signal !== undefined)
            update.sig = data.signal
        if (data.stderr !== undefined)
            update.stderr = data.stderr
        if (data.stdout !== undefined)
            update.stdout = data.stdout

        let list = []
        for (let field in update) {
            let val = update[field]
            if (val !== null)
                val = db.escape(val)
            list.push(`${field}=${val}`)
        }

        await db.query(`UPDATE ${config.get('mysql_table')} SET ${list.join(', ')} WHERE id=?`, [id])
    }

    /**
     * @param {string[]} inTargets
     * @returns {boolean}
     */
    hasFreeSlots(inTargets = []) {
        const LOGPREFIX = `hasFreeSlots(${JSON.stringify(inTargets)}):`

        this.logger.debug(`${LOGPREFIX} entered`)

        for (const target in this.targets) {
            if (!inTargets.includes(target))
                continue

            for (const slot in this.targets[target].slots) {
                const {limit, queue} = this.targets[target].slots[slot]
                this.logger.debug(LOGPREFIX, limit, queue.length)
                if (queue.length < limit)
                    return true
            }
        }

        return false
    }

    /**
     * @param {string} target
     * @param {string} slot
     */
    onJobFinished = (target, slot) => {
        this.logger.debug(`onJobFinished: target=${target}, slot=${slot}`)

        const {queue, limit} = this.targets[target].slots[slot]
        if (queue.length < limit && this.hasPollTarget(target)) {
            this.logger.debug(`onJobFinished: ${queue.length} < ${limit}, calling poll(${target})`)
            this.poll()
        }
    }

}

module.exports = {
    Worker,

    STATUS_WAITING,
    STATUS_MANUAL,
    STATUS_ACCEPTED,
    STATUS_IGNORED,
    STATUS_RUNNING,
    STATUS_DONE,

    JOB_ACCEPTED,
    JOB_IGNORED,
    JOB_NOTFOUND,
}