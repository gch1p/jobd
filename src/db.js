const {workerConfig} = require('./config')
const {getLogger} = require('./logger')
const mysql = require('promise-mysql')

let link
const logger = getLogger('db')

async function init() {
    link = await mysql.createConnection({
        host: workerConfig.mysql_host,
        user: workerConfig.mysql_user,
        password: workerConfig.mysql_password,
        database: workerConfig.mysql_database
    })
}

function wrap(method, isAsync = true, log = true) {
    return isAsync ? async function(...args) {
        if (log)
            logger.trace(`${method}: `, args)

        try {
            return await link[method](...args)
        } catch (error) {
            logger.error(`db.${method}:`, error, link)

            if (       error.code === 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR'
                    || error.code === 'PROTOCOL_CONNECTION_LOST'
                    || error.fatal === true) {
                // try to reconnect and call it again, once
                await init()
                return await link[method](...args)
            }
        }
    } : function(...args) {
        if (log)
            logger.trace(`${method}: `, args)

        return link[method](...args)
    }
}

module.exports = {
    init,
    query: wrap('query'),
    beginTransaction: wrap('beginTransaction'),
    commit: wrap('commit'),
    escape: wrap('escape', false, false)
}