#!/usr/bin/env node
const minimist = require('minimist')
const loggerModule = require('./lib/logger')
const config = require('./lib/config')
const {Server, ResponseMessage} = require('./lib/server')
const WorkersList = require('./lib/workers-list')
const {validateObjectSchema, validateTargetsListFormat} = require('./lib/data-validator')
const RequestHandler = require('./lib/request-handler')
const package_json = require('../package.json')

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
}

/**
 * @param {object} data
 * @param {number} requestNo
 * @param {Connection} connection
 */
function onRegisterWorker(data, requestNo, connection) {
    const targets = data.targets || []

    // validate data
    try {
        validateTargetsListFormat(targets)
    } catch (e) {
        connection.send(
            new ResponseMessage(requestNo)
                .setError(e.message)
        )
        return
    }

    // register worker and reply with OK
    workers.add(connection, targets)
    connection.send(
        new ResponseMessage(requestNo)
            .setData('ok')
    )
}

/**
 * @param {object} data
 * @param {number} requestNo
 * @param {Connection} connection
 */
function onPoke(data, requestNo, connection) {
    const targets = data.targets || []

    // validate data
    try {
        validateTargetsListFormat(targets)
    } catch (e) {
        connection.send(
            new ResponseMessage(requestNo)
                .setError(e.message)
        )
        return
    }

    // poke workers
    workers.poke(targets)

    // reply to user
    connection.send(
        new ResponseMessage(requestNo)
            .setData('ok')
    )
}

/**
 * @param {object} data
 * @param {number} requestNo
 * @param {Connection} connection
 * @return {Promise<*>}
 */
async function onStatus(data, requestNo, connection) {
    const info = await workers.getInfo(data.poll_workers || false)

    let status = {
        workers: info,
        memoryUsage: process.memoryUsage()
    }

    connection.send(
        new ResponseMessage(requestNo)
            .setData(status)
    )
}

/**
 * @param {object} data
 * @param {number} requestNo
 * @param {Connection} connection
 * @return {Promise<*>}
 */
async function onRunManual(data, requestNo, connection) {
    const {jobs} = data

    // validate data
    try {
        if (!Array.isArray(jobs))
            throw new Error('jobs must be array')

        for (let job of jobs) {
            validateObjectSchema(job, [
                // name     // type  // required
                ['id',      'i',     true],
                ['target',  's',     true],
            ])
        }
    } catch (e) {
        connection.send(
            new ResponseMessage(requestNo)
                .setError(e.message)
        )
        return
    }

    // run jobs on workers
    const jobsData = await workers.runManual(jobs)

    // send result to the client
    connection.send(
        new ResponseMessage(requestNo)
            .setData(jobsData)
    )
}

/**
 * @param {object} data
 * @param {number} requestNo
 * @param {Connection} connection
 */
function onPause(data, requestNo, connection) {
    let targets
    if ((targets = validateInputTargets(data, requestNo, connection)) === false)
        return

    workers.pauseTargets(targets)
    connection.send(
        new ResponseMessage(requestNo)
            .setData('ok')
    )
}

/**
 * @param {object} data
 * @param {number} requestNo
 * @param {Connection} connection
 */
function onContinue(data, requestNo, connection) {
    let targets
    if ((targets = validateInputTargets(data, requestNo, connection)) === false)
        return

    workers.continueTargets(targets)
    connection.send(
        new ResponseMessage(requestNo)
            .setData('ok')
    )
}


/**
 * @private
 * @param data
 * @param requestNo
 * @param connection
 * @return {null|boolean|string[]}
 */
function validateInputTargets(data, requestNo, connection) {
    // null means all targets
    let targets = null

    if (data.targets !== undefined) {
        targets = data.targets

        // validate data
        try {
            validateTargetsListFormat(targets)

            // note: we don't check target names here
            // as in jobd
        } catch (e) {
            connection.send(
                new ResponseMessage(requestNo)
                    .setError(e.message)
            )
            return false
        }
    }

    return targets
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
