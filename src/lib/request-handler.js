const {getLogger} = require('./logger')
const {ResponseMessage} = require('./server')

class RequestHandler {

    constructor() {
        /**
         * @type {Map<string, Function>}
         */
        this.handlers = new Map()

        /**
         * @type {Logger}
         */
        this.logger = getLogger('RequestHandler')
    }

    /**
     * @param {string} requestType
     * @param {Function} handler
     */
    set(requestType, handler) {
        if (this.handlers.has(requestType))
            throw new Error(`handler for '${requestType}' has already been set`)

        this.handlers.set(requestType, handler)
    }

    /**
     * @param {RequestMessage} message
     * @param {Connection} connection
     */
    process(message, connection) {
        this.logger.info('process:', message)

        if (this.handlers.has(message.requestType)) {
            const f = this.handlers.get(message.requestType)
            const result = f(message.requestData || {}, message.requestNo, connection)
            if (result instanceof Promise) {
                result.catch(error => {
                    this.logger.error(`${message.requestType}:`, error)

                    connection.send(
                        new ResponseMessage(message.requestNo)
                            .setError('server error: ' + error?.message)
                    )
                })
            }
        } else {
            connection.send(
                new ResponseMessage(message.requestNo)
                    .setError(`unknown request type: '${message.requestType}'`)
            )
        }
    }

}

module.exports = RequestHandler