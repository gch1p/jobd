#!/usr/bin/env node
const minimist = require('minimist')
const loggerModule = require('./lib/logger')
const config = require('./lib/config')
const {Server, ResponseMessage} = require('./lib/server')
const WorkersList = require('./lib/workers-list')
const {
    validateObjectSchema,
    validateInputTargetsListFormat,
    validateInputTargets
} = require('./lib/data-validator')
const {RequestHandler} = require('./lib/request-handler')
const package_json = require('../package.json')

const DEFAULT_CONFIG_PATH = "/etc/jobd-master.conf"

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

/**
 * @type {RequestHandler}
 */
let requestHandler


main().catch(e => {
    console.error(e)
    process.exit(1)
})


async function main() {
    await initApp('jobd-master')
    initWorkers()
    initRequestHandler()
    initServer()
}

async function initApp(appName) {
    if (process.argv.length < 3) {
        usage()
        process.exit(0)
    }

    process.on('SIGINT', term)
    process.on('SIGTERM', term)

    const argv = minimist(process.argv.slice(2), {
        boolean: ['help', 'version'],
        default: {
            config: DEFAULT_CONFIG_PATH
        }
    })

    if (argv.help) {
        usage()
        process.exit(0)
    }

    if (argv.version) {
        console.log(package_json.version)
        process.exit(0)
    }

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
    logger = loggerModule.getLogger(appName)

    process.title = appName
}

function initServer() {
    server = new Server()
    server.on('new-connection', (connection) => {
        connection.on('request-message', (message, connection) => {
            requestHandler.process(message, connection)
        })
    })
    server.start(config.get('port'), config.get('host'))
}

function initWorkers() {
    workers = new WorkersList()
}

function initRequestHandler() {
    requestHandler = new RequestHandler()
    requestHandler.set('poke', onPoke)
    requestHandler.set('register-worker', onRegisterWorker)
    requestHandler.set('status', onStatus)
    requestHandler.set('run-manual', onRunManual)
    requestHandler.set('pause', onPause)
    requestHandler.set('continue', onContinue)
    requestHandler.set('send-signal', onSendSignal)
}

function usage() {
    let s = `${process.argv[1]} OPTIONS

Options:
    --config <path>  Path to config. Default: ${DEFAULT_CONFIG_PATH}
    --help           Show this help.
    --version        Print version.`

    console.log(s)
}

async function term() {
    if (logger)
        logger.info('shutdown')

    await loggerModule.shutdown()
    process.exit()
}



/****************************************/
/**                                    **/
/**          Request handlers          **/
/**                                    **/
/****************************************/

/**
 * @param {object} data
 * @param {Connection} connection
 */
async function onRegisterWorker(data, connection) {
    const targets = validateInputTargets(data, null)
    if (typeof data.name !== 'string')
        throw new Error('name is missing or invalid')

    workers.add(connection, {
        targets,
        name: data.name
    })
    return 'ok'
}

/**
 * @param {object} data
 */
async function onPoke(data) {
    const targets = validateInputTargets(data, null)
    workers.poke(targets)
    return 'ok'
}

/**
 * @param {object} data
 * @return {Promise<*>}
 */
async function onStatus(data) {
    const info = await workers.getInfo(data.poll_workers || false)
    return {
        workers: info,
        memoryUsage: process.memoryUsage()
    }
}

/**
 * @param {object} data
 * @return {Promise<*>}
 */
async function onRunManual(data) {
    const {jobs} = data

    // validate input
    if (!Array.isArray(jobs))
        throw new Error('jobs must be array')

    for (let job of jobs) {
        validateObjectSchema(job, [
            // name     // type  // required
            ['id',      'i',     true],
            ['target',  's',     true],
        ])
    }

    // run jobs, wait for results and send a response
    return await workers.runManual(jobs)
}

/**
 * @param {object} data
 */
function onPause(data) {
    const targets = validateInputTargets(data, null)
    workers.pauseTargets(targets)
    return 'ok'
}

/**
 * @param {object} data
 * @param {number} requestNo
 * @param {Connection} connection
 */
function onContinue(data, requestNo, connection) {
    const targets = validateInputTargets(data, null)
    workers.continueTargets(targets)
    return 'ok'
}


/**
 * @param {object} data
 * @return {Promise<*>}
 */
async function onSendSignal(data) {
    const {jobs} = data

    if (!Array.isArray(jobs))
        throw new Error('jobs must be array')

    for (let job of jobs) {
        validateObjectSchema(job, [
            // name     // type  // required
            ['id',      'i',     true],
            ['signal',  'i',     true],
            ['target',  's',     true],
        ])
    }

    return await workers.sendSignals(jobs)
}