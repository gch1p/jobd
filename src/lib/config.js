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
    }
    Object.assign(config, processScheme(raw, scheme))

    config.targets = {}

    // targets
    for (let target in raw) {
        if (target === 'null')
            throw new Error('word \'null\' is reserved, please don\'t use it as a target name')

        if (typeof raw[target] !== 'object')
            continue

        config.targets[target] = {slots: {}}
        for (let slotName in raw[target]) {
            let slotLimit = parseInt(raw[target][slotName], 10)
            if (slotLimit < 1)
                throw new Error(`${target}: slot ${slotName} has invalid limit`)
            config.targets[target].slots[slotName] = slotLimit
        }
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
 * @param {string} key
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

module.exports = {
    parseWorkerConfig,
    parseMasterConfig,
    get,
}