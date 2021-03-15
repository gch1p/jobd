const {isInteger, isObject} = require('lodash')
const {getLogger} = require('./logger')

const typeNames = {
    'i': 'integer',
    'n': 'number',
    's': 'string',
    'o': 'object',
    'a': 'array',
}

const logger = getLogger('data-validator')


/**************************************/
/**        Common Functions          **/
/**************************************/

/**
 * @param {string} expectedType
 * @param value
 */
function checkType(expectedType, value) {
    switch (expectedType) {
        case 'i':
            return isInteger(value)
        case 'n':
            return typeof value === 'number'
        case 's':
            return typeof value === 'string'
        case 'o':
            return typeof value === 'object'
        case 'a':
            return Array.isArray(value)
        default:
            logger.error(`checkType: unknown type ${expectedType}`)
            return false
    }
}

/**
 * @param {object} data
 * @param {array} schema
 * @throws Error
 */
function validateObjectSchema(data, schema) {
    if (!isObject(data))
        throw new Error(`data is not an object`)

    for (const field of schema) {
        let [name, types, required] = field
        if (!(name in data)) {
            if (required)
                throw new Error(`missing required field ${name}`)

            continue
        }

        types = types.split('')

        if (!types
            .map(type => checkType(type, data[name]))
            .some(result => result === true)) {

            let error = `'${name}' must be `
            if (types.length === 1) {
                error += typeNames[types[0]]
            } else {
                error += 'any of: ' + types.map(t => typeNames[t]).join(', ')
            }

            throw new Error(error)
        }
    }
}


/********************************************/
/**      Request input data validators      */
/********************************************/

function validateInputTargetsListFormat(targets) {
    if (!Array.isArray(targets))
        throw new Error('targets must be array')

    if (!targets.length)
        throw new Error('targets are empty')

    for (const t of targets) {
        const type = typeof t
        if (type !== 'string')
            throw new Error(`all targets must be strings, ${type} given`)
    }
}

function validateInputTargetAndConcurrency(data, onlyTarget = false) {
    const schema = [
        ['target',      's',     true],
    ]

    if (!onlyTarget) {
        schema.push(
            ['concurrency', 'i', true]
        )
    }

    validateObjectSchema(data, schema)

    if (!onlyTarget && data.concurrency <= 0)
        throw new Error('Invalid concurrency value.')
}

/**
 * @param data
 * @param {Worker|null} worker
 * @return {null|string[]}
 */
function validateInputTargets(data, worker) {
    // null means all targets
    let targets = null

    if (data.targets !== undefined) {
        targets = data.targets

        validateInputTargetsListFormat(targets)

        if (worker !== null) {
            for (const t of targets) {
                if (!worker.hasTarget(t))
                    throw new Error(`invalid target '${t}'`)
            }
        }
    }

    return targets
}

module.exports = {
    validateObjectSchema,
    validateInputTargetsListFormat,
    validateInputTargetAndConcurrency,
    validateInputTargets,
}