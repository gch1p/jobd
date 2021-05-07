#!/usr/bin/env node
const minimist = require('minimist')
const loggerModule = require('./lib/logger')
const config = require('./lib/config')
const db = require('./lib/db')
const {uniq} = require('lodash')
const {createCallablePromise} = require('./lib/util')
const {
    validateInputTargetAndConcurrency,
    validateInputTargets
} = require('./lib/data-validator')
const {RequestHandler} = require('./lib/request-handler')
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
    JOB_IGNORED
} = require('./lib/worker')
const package_json = require('../package.json')

const DEFAULT_CONFIG_PATH = "/etc/jobd.conf"

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
 * @type {RequestHandler}
 */
let requestHandler

/**
 * @type {object.<string, Promise>}
 */
let jobPromises = {}


main().catch(e => {
    console.error(e)
    process.exit(1)
})


async function main() {
    await initApp('jobd')
    await initDatabase()
    initWorker()
    initRequestHandler()
    initServer()
    connectToMaster()
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
    logger = loggerModule.getLogger(appName)

    process.title = appName
}

function initWorker() {
    worker = new Worker()

    const targets = config.get('targets')
    for (const target in targets) {
        let limit = targets[target]
        worker.addTarget(target, limit)
    }

    worker.on('job-done', (data) => {
        if (jobPromises[data.id] !== undefined) {
            const P = jobPromises[data.id]
            delete jobPromises[data.id]

            logger.trace(`job-done: resolving promise of job ${data.id}`)
            P.resolve(data)
        } else {
            // this is not an error, as there will be no promise unless it's a manual job
            // so this is totally normal situation, thus debug() and not warn() or error()
            logger.debug(`job-done: jobPromises[${data.id}] is undefined`)
        }
    })
}

function initRequestHandler() {
    requestHandler = new RequestHandler()
    requestHandler.set('poll', onPollRequest)
    requestHandler.set('status', onStatus)
    requestHandler.set('run-manual', onRunManual)
    requestHandler.set('pause', onPause)
    requestHandler.set('continue', onContinue)
    requestHandler.set('add-target', onAddTarget)
    requestHandler.set('remove-target', onRemoveTarget)
    requestHandler.set('set-target-concurrency', onSetTargetConcurrency)
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

async function initDatabase() {
    try {
        await db.init()
    } catch (error) {
        logger.error('failed to connect to MySQL', error)
        process.exit(1)
    }
    logger.info('db initialized')
}

function connectToMaster() {
    const port = config.get('master_port')
    const host = config.get('master_host')

    if (!host || !port) {
        logger.debug('connectToMaster: master host or port is not defined')
        return
    }

    async function connect() {
        const connection = new Connection()
        await connection.connect(host, port)

        try {
            let response = await connection.sendRequest(
                new RequestMessage('register-worker', {
                    targets: worker.getTargets()
                })
            )
            logger.debug('connectToMaster: response:', response)
        } catch (error) {
            logger.error('connectToMaster: error while awaiting response:', error)
        }

        connection.on('close', () => {
            logger.warn(`connectToMaster: connection closed`)
            tryToConnect()
        })

        connection.on('request-message', (message, connection) => {
            requestHandler.process(message, connection)
        })
    }

    function tryToConnect(now = false) {
        setTimeout(() => {
            connect().catch(error => {
                logger.warn(`connectToMaster: connection failed`, error)
                tryToConnect()
            })
        }, now ? 0 : config.get('master_reconnect_timeout') * 1000)
    }

    tryToConnect(true)
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
 * @return {Promise<string>}
 */
async function onPollRequest(data) {
    let targets = validateInputTargets(data, worker)

    worker.setPollTargets(targets)
    worker.poll()

    return 'ok'
}

/**
 * @param {object} data
 * @return {Promise<object>}
 */
async function onStatus(data) {
    return {
        targets: worker.getStatus(),
        jobPromisesCount: Object.keys(jobPromises).length,
        memoryUsage: process.memoryUsage()
    }
}

/**
 * @param {{ids: number[]}} data
 * @return {Promise}
 */
async function onRunManual(data) {
    let {ids: jobIds} = data
    jobIds = uniq(jobIds)

    for (const id of jobIds) {
        // if at least one item is not a number, reject
        if (typeof id !== 'number')
            throw new Error(`all ids must be numbers, got ${typeof id}`)

        // if at least one of the jobs is already being run, reject
        if (id in jobPromises)
            throw new Error(`another client is already waiting for job ${id}`)
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
    const P = Promise.allSettled(promises).then(results => {
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

        return response
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

    return P
}

/**
 * @param {{targets: string[]}} data
 */
async function onPause(data) {
    let targets = validateInputTargets(data, worker)
    worker.pauseTargets(targets)
    return 'ok'
}

/**
 * @param {{targets: string[]}} data
 */
async function onContinue(data) {
    let targets
    if ((targets = validateInputTargets(data, worker)) === false)
        return

    // continue queues
    worker.continueTargets(targets)

    // poll just in case
    worker.poll()

    return 'ok'
}

/**
 * @param {{target: string, concurrency: int}} data
 */
async function onAddTarget(data) {
    validateInputTargetAndConcurrency(data)
    worker.addTarget(data.target, data.concurrency)
    return 'ok'
}

/**
 * @param {{target: string}} data
 */
async function onRemoveTarget(data) {
    validateInputTargetAndConcurrency(data, true)
    worker.removeTarget(data.target)
    return 'ok'
}

/**
 * @param {object} data
 */
async function onSetTargetConcurrency(data) {
    validateInputTargetAndConcurrency(data)
    worker.setTargetConcurrency(data.target, data.concurrency)
    return 'ok'
}