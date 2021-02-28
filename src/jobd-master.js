#!/usr/bin/env node
const minimist = require('minimist')
const loggerModule = require('./lib/logger')
const config = require('./lib/config')
const {Server, ResponseMessage, RequestMessage} = require('./lib/server')
const WorkersList = require('./lib/workers-list')

/**
 * @type {Logger}
 */
let logger

/**
 * @type {Server}
 */
let server

/**
 * @type WorkersList
 */
let workers


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

    if (!argv.config)
        throw new Error('--config option is required')

    // read config
    try {
        config.parseMasterConfig(argv.config)
    } catch (e) {
        console.error(`config parsing error: ${e.message}`)
        process.exit(1)
    }

    await loggerModule.init({
        file: config.get('log_file'),
        levelFile: config.get('log_level_file'),
        levelConsole: config.get('log_level_console'),
    })
    logger = loggerModule.getLogger('jobd-master')

    workers = new WorkersList()

    // start server
    server = new Server()
    server.on('new-connection', (connection) => {
        connection.on('request-message', onRequestMessage)
    })
    server.start(config.get('port'), config.get('host'))
    logger.info('server started')
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
            case 'register-worker': {
                const targets = message.requestData?.targets || []
                if (!targets.length) {
                    connection.send(
                        new ResponseMessage(message.requestNo)
                            .setError(`targets are empty`)
                    )
                    break
                }

                workers.add(connection, targets)
                connection.send(
                    new ResponseMessage(message.requestNo)
                        .setData('ok')
                )
                break
            }

            case 'poke': {
                const targets = message.requestData?.targets || []
                if (!targets.length) {
                    connection.send(
                        new ResponseMessage(message.requestNo)
                            .setError(`targets are empty`)
                    )
                    break
                }

                workers.poke(targets)
                connection.send(
                    new ResponseMessage(message.requestNo)
                        .setData('ok')
                )
                break
            }

            case 'status':
                const info = workers.getInfo()
                connection.send(
                    new ResponseMessage(message.requestNo)
                        .setData({
                            workers: info,
                            memoryUsage: process.memoryUsage()
                        })
                )
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

function usage() {
    let s = `${process.argv[1]} OPTIONS

Options:
    --config <path>
    --help`

    console.log(s)
}

function term() {
    if (logger)
        logger.info('shutdown')

    loggerModule.shutdown(function() {
        process.exit()
    })
}
