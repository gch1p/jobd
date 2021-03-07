const fs = require('fs')
const ini = require('ini')
const {isNumeric} = require('./util')

let config = null

function readFile(file) {
    if (!fs.existsSync(file))
        throw new Error(`file ${file} not found`)

    return ini.parse(fs.readFileSync(file, 'utf-8'))
}

function processScheme(source, scheme) {
    const result = {}

    for (let key in scheme) {
        let opts = scheme[key]
        let ne = !(key in source) || !source[key]
        if (opts.required === true && ne)
            throw new Error(`'${key}' is not defined`)

        let value = source[key] ?? opts.default ?? null

        switch (opts.type) {
            case 'int':
                if (!isNumeric(value))
                    throw new Error(`'${key}' must be an integer`)
                value = parseInt(value, 10)
                break

            case 'float':
                if (!isNumeric(value))
                    throw new Error(`'${key}' must be a float`)
                value = parseFloat(value)
                break

            case 'object':
                if (typeof value !== 'object')
                    throw new Error(`'${key}' must be an object`)
                break

            case 'boolean':
                if (value !== null) {
                    value = value.trim()
                    value = ['true', '1'].includes(value)
                } else {
                    value = false
                }
                break
        }

        result[key] = value
    }

    return result
}

function parseWorkerConfig(file) {
    config = {}

    const raw = readFile(file)
    const scheme = {
        host:     {required: true},
        port:     {required: true, type: 'int'},
        password: {},

        master_host: {},
        master_port: {type: 'int', default: 0},
        master_reconnect_timeout: {type: 'int', default: 10},

        log_file:          {},
        log_level_file:    {default: 'warn'},
        log_level_console: {default: 'warn'},

        mysql_host:        {required: true},
        mysql_port:        {required: true, type: 'int'},
        mysql_user:        {required: true},
        mysql_password:    {required: true},
        mysql_database:    {required: true},
        mysql_table:       {required: true, default: 'jobs'},
        mysql_fetch_limit: {default: 100, type: 'int'},

        launcher:          {required: true},
        max_output_buffer: {default: 1024*1024, type: 'int'},
        targets:           {required: true, type: 'object'},
    }
    Object.assign(config, processScheme(raw, scheme))

    config.targets = {}
    for (let target in raw.targets) {
        if (target === 'null')
            throw new Error('word \'null\' is reserved, please don\'t use it as a target name')

        if (!isNumeric(raw.targets[target]))
            throw new Error(`value of target '${target}' must be a number`)

        let value = parseInt(raw.targets[target], 10)
        if (value < 1)
            throw new Error(`target '${target}' has invalid value`)

        config.targets[target] = value
    }
}

function parseMasterConfig(file) {
    config = {}

    const raw = readFile(file)
    const scheme = {
        host:     {required: true},
        port:     {required: true, type: 'int'},
        password: {},

        ping_interval:          {default: 30, type: 'int'},
        poke_throttle_interval: {default: 0.5, type: 'float'},

        log_file:          {},
        log_level_file:    {default: 'warn'},
        log_level_console: {default: 'warn'},
    }
    Object.assign(config, processScheme(raw, scheme))
}

/**
 * @param {string} file
 * @param {{
 *   master: boolean,
 *   log_level: string|undefined,
 *   host: string,
 *   port: int,
 * }} inputOptions
 */
function parseJobctlConfig(file, inputOptions) {
    config = {}
    const raw = readFile(file)

    Object.assign(config, processScheme(raw, {
        master: {type: 'boolean'},
        password: {},
        log_level: {default: 'warn'},
    }))

    if (inputOptions.master)
        config.master = inputOptions.master
    Object.assign(config, processScheme(raw, {
        host:     {default: '127.0.0.1'},
        port:     {default: config.master ? 7081 : 7080, type: 'int'}
    }))

    for (let key of ['log_level', 'host', 'port']) {
        if (inputOptions[key])
            config[key] = inputOptions[key]
    }

    // console.log('parseJobctlConfig [2]', config)
}

/**
 * @param {string|null} key
 * @return {string|number|object}
 */
function get(key = null) {
    if (key === null)
        return config

    if (typeof config !== 'object')
        throw new Error(`config is not loaded`)

    if (!(key in config))
        throw new Error(`config: ${key} not found`)

    return config[key]
}

/**
 * @param {object} opts
 */
// function set(opts) {
//     Object.assign(config, opts)
// }

module.exports = {
    parseWorkerConfig,
    parseMasterConfig,
    parseJobctlConfig,
    get,
    // set,
}