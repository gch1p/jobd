#!/usr/bin/env node
const minimist = require('minimist')
const loggerModule = require('./logger')
const configModule = require('./config')
const db = require('./db')
const {Server, Connection, RequestMessage, ResponseMessage} = require('./server')
const {Worker, STATUS_MANUAL} = require('./worker')

const {workerConfig} = configModule


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
 * @type {object.<string, Connection>}
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
    if (!argv.config)
        throw new Error('--config option is required')

    // read config
    try {
        configModule.parseWorkerConfig(argv.config)
    } catch (e) {
        console.error(`config parsing error: ${e.message}`)
        process.exit(1)
    }

    await loggerModule.init({
        file: workerConfig.log_file,
        levelFile: workerConfig.log_level_file,
        levelConsole: workerConfig.log_level_console,
    })
    logger = loggerModule.getLogger('jobd')

    // console.log(workerConfig)

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
    for (let targetName in workerConfig.targets) {
        let slots = workerConfig.targets[targetName].slots
        // let target = new Target({name: targetName})
        // queue.addTarget(target)

        for (let slotName in slots) {
            let slotLimit = slots[slotName]
            worker.addSlot(targetName, slotName, slotLimit)
        }
    }
    worker.on('job-done', (data) => {
        if (jobDoneAwaiters[data.id] !== undefined) {
            jobDoneAwaiters[data.id].send(new ResponseMessage().setData(data))
            jobDoneAwaiters[data.id].close()
            delete jobDoneAwaiters[data.id]
        }
    })
    logger.info('queue initialized')

    // start server
    server = new Server()
    server.on('message', onMessage)
    server.start(workerConfig.port, workerConfig.host)
    logger.info('server started')

    // connect to master
    if (workerConfig.master_port && workerConfig.master_host)
        connectToMaster()
}


/**
 * @param {RequestMessage|ResponseMessage} message
 * @param {Connection} connection
 * @return {Promise<*>}
 */
async function onMessage({message, connection}) {
    try {
        if (!(message instanceof RequestMessage)) {
            logger.debug('ignoring message', message)
            return
        }

        if (message.requestType !== 'ping')
            logger.info('onMessage:', message)

        if (workerConfig.password && message.password !== workerConfig.password) {
            connection.send(new ResponseMessage().setError('invalid password'))
            return connection.close()
        }

        switch (message.requestType) {
            case 'ping':
                connection.send(new ResponseMessage().setData('pong'))
                break

            case 'poll':
                const targets = message.requestData?.targets || []
                if (!targets.length) {
                    connection.send(new ResponseMessage().setError('empty targets'))
                    break
                }

                for (const t of targets) {
                    if (!worker.hasTarget(t)) {
                        connection.send(new ResponseMessage().setError(`invalid target '${t}'`))
                        break
                    }
                }

                worker.setPollTargets(targets)
                worker.poll()

                connection.send(new ResponseMessage().setData('ok'));
                break

            case 'status':
                const qs = worker.getStatus()
                connection.send(
                    new ResponseMessage().setData({
                        queue: qs,
                        jobDoneAwaitersCount: Object.keys(jobDoneAwaiters).length,
                        memoryUsage: process.memoryUsage()
                    })
                )
                break

            case 'run-manual':
                const {id} = message.requestData
                if (id in jobDoneAwaiters) {
                    connection.send(new ResponseMessage().setError('another client is already waiting this job'))
                    break
                }

                jobDoneAwaiters[id] = connection

                const {accepted, error} = await worker.getTasks(null, STATUS_MANUAL, {id})
                if (!accepted) {
                    delete jobDoneAwaiters[id]

                    let message = 'failed to run task'
                    if (typeof error === 'string')
                        message += `: ${error}`
                    connection.send(new ResponseMessage().setError(message))
                }

                break

            default:
                connection.send(new ResponseMessage().setError(`unknown request type: '${message.requestType}'`))
                break
        }
    } catch (error) {
        logger.error(`error while handling message:`, message, error)
        connection.send(new ResponseMessage().setError('server error: ' + error?.message))
    }
}


function connectToMaster() {
    const connection = new Connection()
    connection.connect(workerConfig.master_host, workerConfig.master_port)

    connection.on('connect', function() {
        connection.send(
            new RequestMessage('register-worker', {
                targets: worker.getTargets()
            })
        )
    })

    connection.on('close', () => {
        logger.warn(`connectToMaster: connection closed`)
        setTimeout(() => {
            connectToMaster()
        }, workerConfig.master_reconnect_timeout * 1000)
    })

    connection.on('message', (message) => {
        if (!(message instanceof RequestMessage)) {
            logger.debug('message from master is not a request, hmm... skipping', message)
            return
        }

        onMessage({message, connection})
            .catch((error) => {
                logger.error('connectToMaster: onMessage:', error)
            })
    })
}


function usage() {
    let s = `${process.argv[1]} OPTIONS

Options:
    --config <path>`
    console.log(s)
}


function term() {
    if (logger)
        logger.info('shutdown')

    loggerModule.shutdown(function() {
        process.exit()
    })
}