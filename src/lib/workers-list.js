const {intersection, throttle, sample} = require('lodash')
const config = require('./config')
const {getLogger} = require('./logger')
const {RequestMessage, PingMessage} = require('./server')

const MANUAL_CALL_TYPE_RUN = 0
const MANUAL_CALL_TYPE_SIGNALS = 1

function validateManualCallType(type) {
    if (![
        MANUAL_CALL_TYPE_RUN,
        MANUAL_CALL_TYPE_SIGNALS
    ].includes(type)) {
        throw new Error('invalid manual call type')
    }
}

class WorkersList {

    constructor() {
        /**
         * @type {{connection: Connection, targets: string[]}[]}
         */
        this.workers = []

        /**
         * @type {object.<string, boolean>}
         */
        this.targetsToPoke = {}

        /**
         * @type {object.<string, boolean>}
         */
        this.targetsWaitingToPoke = {}

        /**
         * @type {NodeJS.Timeout}
         */
        this.pingInterval = setInterval(this.sendPings, config.get('ping_interval') * 1000)

        /**
         * @type {Logger}
         */
        this.logger = getLogger('WorkersList')
    }

    /**
     * @param {Connection} connection
     * @param {string[]} targets
     * @param {string} name
     */
    add(connection, {targets, name}) {
        this.logger.info(`add: connection from ${connection.remoteAddr()}, name ${name}, targets ${JSON.stringify(targets)}`)

        this.workers.push({connection, targets, name})
        connection.on('close', () => {
            this.logger.info(`connection from ${connection.remoteAddr()} closed, removing worker`)
            this.workers = this.workers.filter(worker => {
                return worker.connection !== connection
            })
        })

        let waiting = Object.keys(this.targetsWaitingToPoke)
        if (!waiting.length)
            return

        let intrs = intersection(waiting, targets)
        if (intrs.length) {
            this.logger.info('add: found intersection with waiting targets:', intrs, 'going to poke new worker')
            this._pokeWorkerConnection(connection, intrs)
            for (let target of intrs)
                delete this.targetsWaitingToPoke[target]
            this.logger.trace(`add: this.targetsWaitingToPoke:`, this.targetsWaitingToPoke)
        }
    }

    /**
     * @param {string[]} targets
     */
    poke(targets) {
        this.logger.debug('poke:', targets)

        for (let t of targets)
            this.targetsToPoke[t] = true

        this._pokeWorkers()
    }

    /**
     * @param targets
     * @return {object[]}
     */
    getWorkersByTargets(targets) {
        const found = []
        for (const worker of this.workers) {
            const intrs = intersection(worker.targets, targets)
            if (intrs.length > 0)
                found.push(worker)
        }
        return found
    }

    /**
     * @private
     */
    _pokeWorkers = throttle(() => {
        const targets = Object.keys(this.targetsToPoke)
        this.targetsToPoke = {}

        const found = {}
        for (const worker of this.workers) {
            const intrs = intersection(worker.targets, targets)
            intrs.forEach(t => {
                found[t] = true
            })
            if (intrs.length > 0)
                this._pokeWorkerConnection(worker.connection, intrs)
        }

        for (let target of targets) {
            if (!(target in found)) {
                this.logger.debug(`_pokeWorkers: worker responsible for ${target} not found. we'll remember it`)
                this.targetsWaitingToPoke[target] = true
            }
            this.logger.trace('_pokeWorkers: this.targetsWaitingToPoke:', this.targetsWaitingToPoke)
        }
    }, config.get('poke_throttle_interval') * 1000, {leading: true})

    /**
     * @param {Connection} connection
     * @param {string[]} targets
     * @private
     */
    _pokeWorkerConnection(connection, targets) {
        this.logger.debug('_pokeWorkerConnection:', connection.remoteAddr(), targets)

        connection.sendRequest(
            new RequestMessage('poll', {
                targets
            })
        )
        .catch(error => {
            this.logger.error('_pokeWorkerConnection:', error)
        })
    }

    /**
     * @return {{targets: string[], remoteAddr: string, remotePort: number}[]}
     */
    async getInfo(pollWorkers = false) {
        const promises = []

        const workers = [...this.workers]

        for (let i = 0; i < workers.length; i++) {
            let worker = workers[i]

            let P
            if (pollWorkers) {
                P = worker.connection.sendRequest(new RequestMessage('status'))
            } else {
                P = Promise.resolve()
            }

            promises.push(P)
        }

        const results = await Promise.allSettled(promises)

        let info = []
        for (let i = 0; i < results.length; i++) {
            const result = results[i]
            const worker = workers[i]
            const workerInfo = {
                remoteAddr: worker.connection.socket?.remoteAddress,
                remotePort: worker.connection.socket?.remotePort,
                targets: worker.targets,
                name: worker.name,
            }

            if (pollWorkers) {
                if (result.status === 'fulfilled') {
                    /**
                     * @type {ResponseMessage}
                     */
                    let response = result.value
                    workerInfo.workerStatus = response.data
                } else if (result.status === 'rejected') {
                    workerInfo.workerStatusError = result.reason?.message
                }
            }

            info.push(workerInfo)
        }

        return info
    }

    /**
     * Send run-manual() requests to workers, aggregate and return results.
     *
     * @param {{id: int, target: string}[]} jobs
     * @return {Promise<{jobs: {}, errors: {}}>}
     */
    async _runManualCall(callType, jobs) {
        validateManualCallType(callType)
        this.logger.debug(`runManualCall[${callType}]:`, jobs)

        const workers = [...this.workers]

        /**
         * @type {object.<string, int[]>}
         */
        const targetWorkers = {}

        for (let workerIndex = 0; workerIndex < workers.length; workerIndex++) {
            const worker = workers[workerIndex]

            for (let target of worker.targets) {
                if (targetWorkers[target] === undefined)
                    targetWorkers[target] = []

                targetWorkers[target].push(workerIndex)
            }
        }

        this.logger.trace(`runManualCall[${callType}]: targetWorkers:`, targetWorkers)

        /**
         * List of job IDs with unsupported targets.
         *
         * @type {int[]}
         */
        const exceptions = []
        const callMap = {}

        /**
         * @type {object.<int, string>}
         */
        const jobToTargetMap = {}

        for (const job of jobs) {
            const {id, target} = job

            jobToTargetMap[id] = target

            // if worker serving this target not found, skip the job
            if (targetWorkers[target] === undefined) {
                exceptions.push(id)
                continue
            }

            // get random worker index
            let workerIndex = sample(targetWorkers[target])
            if (callMap[workerIndex] === undefined)
                callMap[workerIndex] = []

            callMap[workerIndex].push(job)
        }

        this.logger.trace(`runManualCall[${callType}]: callMap:`, callMap)
        this.logger.trace(`runManualCall[${callType}]: exceptions:`, exceptions)

        /**
         * @type {Promise[]}
         */
        const promises = []

        /**
         * @type {int[][]}
         */
        const jobsByPromise = []

        for (const workerIndex in callMap) {
            if (!callMap.hasOwnProperty(workerIndex))
                continue

            let workerJobsData = callMap[workerIndex]
            let worker = workers[workerIndex]
            let conn = worker.connection

            let P
            switch (callType) {
                case MANUAL_CALL_TYPE_RUN:
                    P = conn.sendRequest(
                        new RequestMessage('run-manual', {ids: workerJobsData.map(j => j.id)})
                    )
                    break

                case MANUAL_CALL_TYPE_SIGNALS:
                    const data = {}
                    for (let jobData of workerJobsData)
                        data[jobData.id] = jobData.signal

                    P = conn.sendRequest(
                        new RequestMessage('send-signal', {jobs: data})
                    )
                    break
            }

            promises.push(P)
            jobsByPromise.push(workerJobsData.map(j => j.id))
        }

        this.logger.trace(`runManualCall[${callType}]: jobsByPromise:`, jobsByPromise)

        const results = await Promise.allSettled(promises)

        this.logger.trace(`runManualCall[${callType}]: Promise.allSettled results:`, results)

        const response = {}
        const setError = (id, value) => {
            if (!('errors' in response))
                response.errors = {}

            if (typeof id === 'object') {
                Object.assign(response.errors, id)
            } else {
                response.errors[id] = value
            }
        }
        const setData = (id, value) => {
            if (!('jobs' in response))
                response.jobs = {}

            if (typeof id === 'object') {
                Object.assign(response.jobs, id)
            } else {
                response.jobs[id] = value
            }
        }

        for (let i = 0; i < results.length; i++) {
            let result = results[i]
            if (result.status === 'fulfilled') {
                /**
                 * @type {ResponseMessage}
                 */
                const responseMessage = result.value

                switch (callType) {
                    case MANUAL_CALL_TYPE_RUN:
                        const {jobs, errors} = responseMessage.data
                        this.logger.trace(`[${i}]:`, jobs, errors)

                        if (jobs)
                            setData(jobs)

                        if (errors)
                            setError(errors)

                        break

                    case MANUAL_CALL_TYPE_SIGNALS:
                        Object.assign(response, responseMessage.data)
                        break
                }


            } else if (result.status === 'rejected') {
                for (let jobIds of jobsByPromise[i]) {
                    for (let jobId of jobIds)
                        setError(jobId, result.reason?.message)
                }
            }
        }

        // don't forget about skipped jobs
        if (exceptions.length) {
            for (let id of exceptions)
                setError(id, `worker serving target '${jobToTargetMap[id]}' not found`)
        }

        return response
    }

    async runManual(jobs) {
        return await this._runManualCall(MANUAL_CALL_TYPE_RUN, jobs)
    }

    async sendSignals(jobs) {
        return await this._runManualCall(MANUAL_CALL_TYPE_SIGNALS, jobs)
    }

    /**
     * @param {null|string[]} targets
     */
    pauseTargets(targets) {
        return this._pauseContinueWorkers('pause', targets)
    }

    /**
     * @param {null|string[]} targets
     */
    continueTargets(targets) {
        return this._pauseContinueWorkers('continue', targets)
    }

    /**
     * @param {string} action
     * @param {null|string[]} targets
     * @private
     */
    _pauseContinueWorkers(action, targets) {
        (targets === null ? this.workers : this.getWorkersByTargets(targets))
            .forEach(worker => {
                this.logger.debug(`${action}Targets: sending ${action} request to ${worker.connection.remoteAddr()}`)

                let data = {}
                if (targets !== null)
                    data.targets = intersection(worker.targets, targets)

                worker.connection.sendRequest(
                    new RequestMessage(action, data)
                ).catch(this.onWorkerRequestError.bind(this, `${action}Targets`))
            })
    }

    /**
     * @private
     */
    sendPings = () => {
        this.workers
            .forEach(w => {
                this.logger.trace(`sending ping to ${w.connection.remoteAddr()}`)
                w.connection.send(new PingMessage())
            })
    }

    onWorkerRequestError = (from, error) => {
        this.logger.error(`${from}:`, error)
    }

}

module.exports = WorkersList