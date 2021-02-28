const config = require('./config')
const {getLogger} = require('./logger')
const mysql = require('promise-mysql')

let link
const logger = getLogger('db')

async function init() {
    link = await mysql.createConnection({
        host: config.get('mysql_host'),
        user: config.get('mysql_user'),
        password: config.get('mysql_password'),
        database: config.get('mysql_database')
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