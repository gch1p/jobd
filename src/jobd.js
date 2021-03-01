#!/usr/bin/env node
const minimist = require('minimist')
const loggerModule = require('./lib/logger')
const config = require('./lib/config')
const db = require('./lib/db')
const {Server, Connection, RequestMessage, ResponseMessage} = require('./lib/server')
const {Worker, STATUS_MANUAL} = require('./lib/worker')
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
 * @type {object.<string, {connection: Connection, requestNo: number}>}
 */
let jobDoneAwaiters = {}


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
        if (jobDoneAwaiters[data.id] !== undefined) {
            const {connection, requestNo} = jobDoneAwaiters[data.id]

            connection.send(
                new ResponseMessage(requestNo)
                    .setData(data)
            )
            connection.close()

            delete jobDoneAwaiters[data.id]
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
            case 'poll':
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

            case 'status':
                const qs = worker.getStatus()
                connection.send(
                    new ResponseMessage(message.requestNo)
                        .setData({
                            queue: qs,
                            jobDoneAwaitersCount: Object.keys(jobDoneAwaiters).length,
                            memoryUsage: process.memoryUsage()
                        })
                )
                break

            case 'run-manual':
                const {id} = message.requestData
                if (id in jobDoneAwaiters) {
                    connection.send(
                        new ResponseMessage(message.requestNo)
                            .setError('another client is already waiting this job')
                    )
                    break
                }

                jobDoneAwaiters[id] = {
                    connection,
                    requestNo: message.requestNo
                }

                const {accepted, error} = await worker.getTasks(null, STATUS_MANUAL, {id})
                if (!accepted) {
                    delete jobDoneAwaiters[id]

                    let message = 'failed to run task'
                    if (typeof error === 'string')
                        message += `: ${error}`

                    connection.send(
                        new ResponseMessage(message.requestNo)
                            .setError(message)
                    )
                }

                break

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