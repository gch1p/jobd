const intersection = require('lodash/intersection')
const {masterConfig} = require('./config')
const {getLogger} = require('./logger')
const {RequestMessage} = require('./server')
const throttle = require('lodash/throttle')

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
        this.pingInterval = setInterval(this.sendPings, masterConfig.ping_interval * 1000)

        /**
         * @type {Logger}
         */
        this.logger = getLogger('WorkersList')
    }

    /**
     * @param {Connection} connection
     * @param {string[]} targets
     */
    add(connection, targets) {
        this.logger.info(`add: connection from ${connection.remoteAddr()}, targets ${JSON.stringify(targets)}`)

        this.workers.push({connection, targets})
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
        if (!Array.isArray(targets))
            throw new Error('targets must be Array')

        for (let t of targets)
            this.targetsToPoke[t] = true

        this._pokeWorkers()
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
                this._pokeWorkerConnection(worker.connection, targets)
        }

        for (let target of targets) {
            if (!(target in found)) {
                this.logger.debug(`_pokeWorkers: worker responsible for ${target} not found. we'll remember it`)
                this.targetsWaitingToPoke[target] = true
            }
            this.logger.trace('_pokeWorkers: this.targetsWaitingToPoke:', this.targetsWaitingToPoke)
        }
    }, masterConfig.poke_throttle_interval * 1000, {leading: true})

    /**
     * @param {Connection} connection
     * @param {string[]} targets
     * @private
     */
    _pokeWorkerConnection(connection, targets) {
        this.logger.debug('_pokeWorkerConnection:', connection.remoteAddr(), targets)
        connection.send(
            new RequestMessage('poll', {
                targets
            })
        )
    }

    /**
     * @return {{targets: string[], remoteAddr: string, remotePort: number}[]}
     */
    getInfo() {
        return this.workers.map(worker => {
            return {
                remoteAddr: worker.connection.socket?.remoteAddress,
                remotePort: worker.connection.socket?.remotePort,
                targets: worker.targets
            }
        })
    }

    /**
     * @private
     */
    sendPings = () => {
        this.workers
            .forEach(w => {
                this.logger.trace(`sending ping to ${w.connection.remoteAddr()}`)
                w.connection.send(new RequestMessage('ping'))
            })
    }

}

module.exports = WorkersList