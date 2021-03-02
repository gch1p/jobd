#!/usr/bin/env node
const minimist = require('minimist')
const loggerModule = require('./lib/logger')
const config = require('./lib/config')
const db = require('./lib/db')
const {uniq} = require('lodash')
const {createCallablePromise} = require('./lib/util')
const {
    Server,
    Connection,
    RequestMessage,
    ResponseMessage
} = require('./lib/server')
const {
    Worker,
    STATUS_MANUAL,
    JOB_NOTFOUND,
    JOB_ACCEPTED,
    JOB_IGNORED
} = require('./lib/worker')
const package_json = require('../package.json')

/**
 * @type {Worker}
 */
let worker

/**
 * @type {Logger}
 */
let logger

/**
 * @type {Server}
 */
let server

/**
 * @type {object.<string, Promise>}
 */
let jobPromises = {}


main().catch(e => {
    console.error(e)
    process.exit(1)
})


async function main() {
    if (process.argv.length < 3) {
        usage()
        process.exit(0)
    }

    process.on('SIGINT', term)
    process.on('SIGTERM', term)

    const argv = minimist(process.argv.slice(2))

    if (argv.help) {
        usage()
        process.exit(0)
    }

    if (argv.version) {
        console.log(package_json.version)
        process.exit(0)
    }

    if (!argv.config)
        throw new Error('--config option is required')

    // read config
    try {
        config.parseWorkerConfig(argv.config)
    } catch (e) {
        console.error(`config parsing error: ${e.message}`)
        process.exit(1)
    }

    await loggerModule.init({
        file: config.get('log_file'),
        levelFile: config.get('log_level_file'),
        levelConsole: config.get('log_level_console'),
    })
    logger = loggerModule.getLogger('jobd')

    // init database
    try {
        await db.init()
    } catch (error) {
        logger.error('failed to connect to MySQL', error)
        process.exit(1)
    }
    logger.info('db initialized')

    // init queue
    worker = new Worker()
    for (let targetName in config.get('targets')) {
        let slots = config.get('targets')[targetName].slots
        // let target = new Target({name: targetName})
        // queue.addTarget(target)

        for (let slotName in slots) {
            let slotLimit = slots[slotName]
            worker.addSlot(targetName, slotName, slotLimit)
        }
    }
    worker.on('job-done', (data) => {
        if (jobPromises[data.id] !== undefined) {
            const P = jobPromises[data.id]
            delete jobPromises[data.id]

            logger.trace(`job-done: resolving promise of job ${data.id}`)
            P.resolve(data)
        } else {
            logger.warn(`job-done: jobPromises[${data.id}] is undefined`)
        }
    })
    logger.info('queue initialized')

    // start server
    server = new Server()
    server.on('new-connection', (connection) => {
        connection.on('request-message', onRequestMessage)
    })
    server.start(config.get('port'), config.get('host'))
    logger.info('server started')

    // connect to master
    if (config.get('master_port') && config.get('master_host'))
        connectToMaster()
}


/**
 * @param {RequestMessage|ResponseMessage} message
 * @param {Connection} connection
 * @return {Promise<*>}
 */
async function onRequestMessage(message, connection) {
    try {
        logger.info('onMessage:', message)

        switch (message.requestType) {
            case 'poll': {
                const targets = message.requestData?.targets || []
                if (!targets.length) {
                    connection.send(
                        new ResponseMessage(message.requestNo)
                            .setError('empty targets')
                    )
                    break
                }

                for (const t of targets) {
                    if (!worker.hasTarget(t)) {
                        connection.send(
                            new ResponseMessage(message.requestNo)
                                .setError(`invalid target '${t}'`)
                        )
                        break
                    }
                }

                worker.setPollTargets(targets)
                worker.poll()

                connection.send(
                    new ResponseMessage(message.requestNo)
                        .setData('ok')
                )
                break
            }

            case 'status': {
                const qs = worker.getStatus()
                connection.send(
                    new ResponseMessage(message.requestNo)
                        .setData({
                            queue: qs,
                            jobDoneAwaitersCount: Object.keys(jobPromises).length,
                            memoryUsage: process.memoryUsage()
                        })
                )
                break
            }

            case 'run-manual': {
                let {ids: jobIds} = message.requestData
                jobIds = uniq(jobIds)

                // if at least one of the jobs is already being run, reject
                // if at least one item is not a number, reject
                for (const id of jobIds) {
                    if (typeof id !== 'number') {
                        connection.send(
                            new ResponseMessage(message.requestNo)
                                .setError(`all ids must be numbers, got ${typeof id}`)
                        )
                        return
                    }

                    if (id in jobPromises) {
                        connection.send(
                            new ResponseMessage(message.requestNo)
                                .setError(`another client is already waiting for job ${id}`)
                        )
                        return
                    }
                }

                // create a bunch of promises, one per job
                let promises = []
                for (const id of jobIds) {
                    const P = createCallablePromise()
                    jobPromises[id] = P
                    promises.push(P)
                }

                // get jobs from database and enqueue for execution
                const {results} = await worker.getTasks(null, STATUS_MANUAL, {ids: jobIds})

                // wait till all jobs are done (or failed), then send a response
                Promise.allSettled(promises).then(results => {
                    const response = {}

                    for (let i = 0; i < results.length; i++) {
                        let jobId = jobIds[i]
                        let result = results[i]

                        if (result.status === 'fulfilled') {
                            if (!('jobs' in response))
                                response.jobs = {}

                            if (result.value?.id !== undefined)
                                delete result.value.id

                            response.jobs[jobId] = result.value
                        } else if (result.status === 'rejected') {
                            if (!('errors' in response))
                                response.errors = {}

                            response.errors[jobId] = result.reason?.message
                        }
                    }

                    connection.send(
                        new ResponseMessage(message.requestNo)
                            .setData(response)
                    )
                })

                // reject all ignored / non-found jobs
                for (const [id, value] of results.entries()) {
                    if (!(id in jobPromises)) {
                        this.logger.error(`run-manual: ${id} not found in jobPromises`)
                        continue
                    }

                    if (value.result === JOB_IGNORED || value.result === JOB_NOTFOUND) {
                        const P = jobPromises[id]
                        delete jobPromises[id]

                        if (value.result === JOB_IGNORED)
                            P.reject(new Error(value.reason))

                        else if (value.result === JOB_NOTFOUND)
                            P.reject(new Error(`job ${id} not found`))
                    }
                }

                break
            }

            default:
                connection.send(
                    new ResponseMessage(message.requestNo)
                        .setError(`unknown request type: '${message.requestType}'`)
                )
                break
        }
    } catch (error) {
        logger.error(`error while handling message:`, message, error)
        connection.send(
            new ResponseMessage(message.requestNo)
                .setError('server error: ' + error?.message)
        )
    }
}


function connectToMaster() {
    const connection = new Connection()
    connection.connect(config.get('master_host'), config.get('master_port'))

    connection.on('connect', function() {
        connection.sendRequest(
            new RequestMessage('register-worker', {
                targets: worker.getTargets()
            })
        )
        .then(response => {
            logger.debug('connectToMaster: response:', response)
        })
        .catch(error => {
            logger.error('connectToMaster: error while awaiting response:', error)
        })
    })

    connection.on('close', () => {
        logger.warn(`connectToMaster: connection closed`)
        setTimeout(() => {
            connectToMaster()
        }, config.get('master_reconnect_timeout') * 1000)
    })

    connection.on('request-message', onRequestMessage)
}


function usage() {
    let s = `${process.argv[1]} OPTIONS

Options:
    --config <path>
    --help
    --version`

    console.log(s)
}


function term() {
    if (logger)
        logger.info('shutdown')

    loggerModule.shutdown(function() {
        process.exit()
    })
}