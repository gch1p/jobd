#!/usr/bin/env node
const minimist = require('minimist')
const loggerModule = require('./lib/logger')
const config = require('./lib/config')
const package_json = require('../package.json')
const os = require('os')
const path = require('path')
const fs = require('fs/promises')
const {Connection, RequestMessage} = require('./lib/server')
const {isNumeric} = require('./lib/util')
const columnify = require('columnify')
const readline = require('readline')

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.jobctl.conf')

const WORKER_COMMANDS = {
    'list-targets': workerListTargets,
    'memory-usage': workerMemoryUsage,
    'poll': workerPoll,
    'set-target-concurrency': workerSetTargetConcurrency,
    'pause': workerPause,
    'continue': workerContinue
}

const MASTER_COMMANDS = {
    'list-workers': masterListWorkers,
    // 'list-workers-memory-usage': masterListWorkersMemoryUsage,
    'memory-usage': masterMemoryUsage,
    'poke': masterPoke,

    // we can just reuse worker functions here, as they do the same
    'pause': workerPause,
    'continue': workerContinue,
}

/**
 * @type {Logger}
 */
let logger

/**
 * @type {Connection}
 */
let connection


main().catch(e => {
    console.error(e)
    process.exit(1)
})


async function main() {
    const argv = await initApp('jobctl')
    if (!argv.length)
        usage()

    const isMaster = config.get('master')

    logger.info('Working mode: ' + (isMaster ? 'master' : 'worker'))
    logger.trace('Command arguments: ', argv)

    let availableCommands = isMaster ? MASTER_COMMANDS : WORKER_COMMANDS
    let command = argv.shift()
    if (!(command in availableCommands)) {
        logger.error(`Unsupported command: '${command}'`)
        process.exit(1)
    }

    let host = config.get('host')
    let port = config.get('port')

    // connect to instance
    try {
        connection = new Connection()
        await connection.connect(host, port)

        logger.info('Successfully connected.')
    } catch (error) {
        logger.error('Connection failure:', error)
        process.exit(1)
    }

    try {
        await availableCommands[command](argv)
    } catch (e) {
        logger.error(e.message)
    }

    connection.close()

    // initWorker()
    // initRequestHandler()
    // initServer()
    // connectToMaster()
}

async function initApp(appName) {
    if (process.argv.length < 3)
        usage()

    process.on('SIGINT', term)
    process.on('SIGTERM', term)

    const argv = minimist(process.argv.slice(2), {
        boolean: ['master', 'version', 'help', 'password'],
        string: ['host', 'port', 'config', 'log-level'],
        stopEarly: true,
        default: {
            config: DEFAULT_CONFIG_PATH
        }
    })

    if (argv.help)
        usage()

    if (argv.version) {
        console.log(package_json.version)
        process.exit(0)
    }

    // read config
    if (await exists(argv.config)) {
        try {
            config.parseJobctlConfig(argv.config)
        } catch (e) {
            console.error(`config parsing error: ${e.message}`)
            process.exit(1)
        }
    }

    if (argv.master || config.get('master') === null)
        config.set('master', argv.master)

    for (let key of ['log-level', 'host', 'port']) {
        if (key in argv)
            config.set(key.replace('-', '_'), argv[key])
    }

    if (config.get('port') === null)
        config.set('port', config.get('master') ? 7081 : 7080)

    if (config.get('log_level') === null)
        config.set('log_level', 'warn')

    if (argv.password) {
        let password = await question('Enter password: ')
        config.set('password', password)
    }

    // init logger
    await loggerModule.init({
        levelConsole: config.get('log_level'),
        disableTimestamps: true
    })
    logger = loggerModule.getLogger(appName)

    process.title = appName

    ///  ///  ///
    ///  \\\  \\\
    ///  ///  ///
    ///  \\\  \\\
    ///  ///  ///
    /* * * * * */
    /*         */
    /*   ^_^   */
    /*         */
    /*   '_'   */
    /*         */
    /*   <_<   */
    /*         */
    /*   >_>   */
    /*         */
    /* * * * * */
    ///  ///  ///
    ///  \\\  \\\
    ///  ///  ///
    ///  \\\  \\\
    ///  ///  ///

    return argv['_'] || []
}

/**
 * @param {string} name
 * @param {null|object} data
 * @return {Promise<object>}
 */
async function request(name, data = null) {
    let req = new RequestMessage(name, data)
    let response = await connection.sendRequest(req)
    if (response.error)
        throw new Error(`Worker error: ${response.error}`)
    return response.data
}

async function workerListTargets() {
    try {
        let response = await request('status')
        const rows = []
        const columns = [
            'target',
            'concurrency',
            'length',
            'paused'
        ]
        for (const target in response.targets) {
            const row = [
                target,
                response.targets[target].concurrency,
                response.targets[target].length,
                response.targets[target].paused ? 'yes' : 'no'
            ]
            rows.push(row)
        }

        table(columns, rows)
    } catch (error) {
        logger.error(error.message)
        logger.trace(error)
    }
}

async function workerMemoryUsage() {
    try {
        let response = await request('status')
        const columns = ['what', 'value']
        const rows = []
        for (const what in response.memoryUsage)
            rows.push([what, response.memoryUsage[what]])
        rows.push(['pendingJobPromises', response.jobPromisesCount])
        table(columns, rows)
    } catch (error) {
        logger.error(error.message)
        logger.trace(error)
    }
}

async function workerPoll(argv) {
    return await sendCommandForTargets(argv, 'poll')
}

async function workerPause(argv) {
    return await sendCommandForTargets(argv, 'pause')
}

async function workerContinue(argv) {
    return await sendCommandForTargets(argv, 'continue')
}

async function workerSetTargetConcurrency(argv) {
    if (argv.length !== 2)
        throw new Error('Invalid number of arguments.')

    let [target, concurrency] = argv
    if (!isNumeric(concurrency))
        throw new Error(`'concurrency' must be a number.`)

    concurrency = parseInt(concurrency, 10)

    try {
        let response = await request('set-target-concurrency', {target, concurrency})
        console.log(response)
    } catch (error) {
        logger.error(error.message)
        logger.trace(error)
    }
}

async function masterPoke(argv) {
    return await sendCommandForTargets(argv, 'poke')
}

async function masterMemoryUsage() {
    try {
        let response = await request('status')
        const columns = ['what', 'value']
        const rows = []
        for (const what in response.memoryUsage)
            rows.push([what, response.memoryUsage[what]])
        table(columns, rows)
    } catch (error) {
        logger.error(error.message)
        logger.trace(error)
    }
}

async function masterListWorkers() {
    try {
        let response = await request('status', {poll_workers: true})
        const columns = ['worker', 'targets', 'concurrency', 'length', 'paused']
        const rows = []
        for (const worker of response.workers) {
            let remoteAddr = `${worker.remoteAddr}:${worker.remotePort}`
            let targets = Object.keys(worker.workerStatus.targets)
            let concurrencies = targets.map(t => worker.workerStatus.targets[t].concurrency)
            let lengths = targets.map(t => worker.workerStatus.targets[t].length)
            let pauses = targets.map(t => worker.workerStatus.targets[t].paused ? 'yes' : 'no')
            rows.push([
                remoteAddr,
                targets.join("\n"),
                concurrencies.join("\n"),
                lengths.join("\n"),
                pauses.join("\n")
            ])
        }
        table(columns, rows)
    } catch (error) {
        logger.error(error.message)
        logger.trace(error)
    }
}

async function sendCommandForTargets(targets, command) {
    if (!targets.length)
        throw new Error('No targets specified.')

    try {
        let response = await request(command, {targets})
        //console.log(response)
    } catch (error) {
        logger.error(error.message)
        logger.trace(error)
    }
}


function usage(exitCode = 0) {
    let s = `${process.argv[1]} [OPTIONS] COMMAND 

Worker commands:
    list-targets          Print list of targets, their length and inner state.
    memory-usage          Print info about memory usage of the worker.
    poll <...TARGETS>     Ask worker to get tasks for specified targets.
    
                          Example:
                          $ jobctl poke t1 t2 t3
                          
    set-target-concurrency <target> <concurrency>
                          Set concurrency of the target.
                          
    pause <...TARGETS>    Pause specified or all targets.
    continue <...TARGETS> Pause specified or all targets.
    
Master commands:
    list-workers           Print list of connected workers and their state.
    memory-usage           Print info about memory usage.
    poke <...TARGETS>      Poke specified targets.
    pause <...TARGETS>     Send pause() to all workers serving specified targets.
                           If no targets specified, just sends pause() to all
                           connected workers.
    continue <...TARGETS>  Send continue() to all workers serving specified
                           targets. If no targets specified, just sends pause()
                           to all connected workers.
                          
Options:
    --master              Connect to jobd-master instance.
    --host                Address of jobd or jobd-master instance.
    --port                Port. Default: 7080 when --master is not used,
                          7081 otherwise.
    --config <path>       Path to config. Default: ~/.jobctl.conf
    --password            Ask for a password before launching a command.
    --log-level <level>   'error', 'warn', 'info', 'debug' or 'trace'.
                          Default: warn
    --help:               Show this help.
    --version:            Print version. 
    
Configuration file    
    Example of possible ~/.jobctl.conf file:
    
    ;password = 
    hostname = 1.2.3.4
    port = 7080
    log_level = warn
    master = true
`

    console.log(s)
    process.exit(exitCode)
}

function term() {
    if (logger)
        logger.info('shutdown')

    loggerModule.shutdown(function() {
        process.exit()
    })
}

async function exists(file) {
    let exists
    try {
        await fs.stat(file)
        exists = true
    } catch (error) {
        exists = false
    }
    return exists
}

function table(columns, rows) {
    const maxColumnSize = {}
    for (const c of columns)
        maxColumnSize[c] = c.length

    rows = rows.map(values => {
        if (!Array.isArray(values))
            throw new Error('row must be array, got', values)

        let row = {}
        for (let i = 0; i < columns.length; i++) {
            let value = String(values[i])
            row[columns[i]] = value

            let width
            if (value.indexOf('\n') !== -1) {
                width = Math.max(...value.split('\n').map(s => s.length))
            } else {
                width = value.length
            }

            if (width > maxColumnSize[columns[i]])
                maxColumnSize[columns[i]] = width
        }

        return row
    })

    console.log(columnify(rows, {
        columns,
        preserveNewLines: true,
        columnSplitter: ' | ',
        headingTransform: (text) => {
            const repeat = () => '-'.repeat(maxColumnSize[text])
            return `${text.toUpperCase()}\n${repeat()}`
        }
    }))
}

/**
 * @param prompt
 * @return {Promise<string>}
 */
function question(prompt) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    })
    return new Promise((resolve, reject) => {
        rl.question(prompt, (answer) => {
            rl.close()
            resolve(answer)
        })
    })
}
