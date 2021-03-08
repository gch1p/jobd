const net = require('net')
const EventEmitter = require('events')
const {getLogger} = require('./logger')
const random = require('lodash/random')
const config = require('./config')
const {createCallablePromise} = require('./util')
const {validateObjectSchema} = require('./data-validator')

const EOT = 0x04
const REQUEST_NO_LIMIT = 999999


class Message {

    static REQUEST = 0
    static RESPONSE = 1
    static PING = 2
    static PONG = 3

    /**
     * @param {number} type
     */
    constructor(type) {
        /**
         * @type {number}
         */
        this.type = type
    }

    /**
     * @return {array}
     */
    getAsObject() {
        return [this.type]
    }
}

class ResponseMessage extends Message {
    /**
     * @param {number} requestNo
     */
    constructor(requestNo) {
        super(Message.RESPONSE)

        this.requestNo = requestNo

        /**
         * @type {null|string}
         */
        this.error = null

        /**
         * @type {null|object}
         */
        this.data = null
    }

    /**
     * @param {string} error
     * @return {ResponseMessage}
     */
    setError(error) {
        this.error = error
        return this
    }

    /**
     * @param data
     * @return {ResponseMessage}
     */
    setData(data) {
        this.data = data
        return this
    }

    /**
     * @return {array}
     */
    getAsObject() {
        let response = {
            no: this.requestNo
        }

        if (this.error !== null)
            response.error = this.error

        if (this.data !== null)
            response.data = this.data

        return [
            ...super.getAsObject(),
            response
        ]
    }
}

class RequestMessage extends Message {
    /**
     * @param {string} type
     * @param {any} data
     */
    constructor(type, data = null) {
        super(Message.REQUEST)

        /**
         * @type string
         */
        this.requestType = type

        /**
         * @type {null|string|number|object|array}
         */
        this.requestData = data

        /**
         * @type {null|string}
         */
        this.password = null

        /**
         * @type {null|number}
         */
        this.requestNo = null
    }

    /**
     * @return {array}
     */
    getAsObject() {
        let request = {
            no: this.requestNo,
            type: this.requestType
        }

        if (this.requestData)
            request.data = this.requestData

        if (this.password)
            request.password = this.password

        return [
            ...super.getAsObject(),
            request
        ]
    }

    /**
     * @param {string} password
     */
    setPassword(password) {
        this.password = password
    }

    /**
     * @param {number} no
     */
    setRequestNo(no) {
        this.requestNo = no
    }
}

class PingMessage extends Message {
    constructor() {
        super(Message.PING)
    }
}

class PongMessage extends Message {
    constructor() {
        super(Message.PONG)
    }
}


class Server extends EventEmitter {

    constructor() {
        super()

        /**
         * @type {null|module:net.Server}
         */
        this.server = null

        /**
         * @type {Logger}
         */
        this.logger = getLogger('server')
    }

    /**
     * @param {number} port
     * @param {string} host
     */
    start(port, host) {
        this.server = net.createServer()

        this.server.on('connection', this.onConnection)
        this.server.on('error', this.onError)
        this.server.on('listening', this.onListening)

        this.server.listen(port, host)
    }

    /**
     * @param {module:net.Socket} socket
     */
    onConnection = (socket) => {
        let connection = new Connection()
        connection.setSocket(socket)

        this.logger.info(`new connection from ${socket.remoteAddress}:${socket.remotePort}`)

        this.emit('new-connection', connection)
    }

    onListening = () => {
        let addr = this.server.address()
        this.logger.info(`server is listening on ${addr.address}:${addr.port}`)
    }

    onError = (error) => {
        this.logger.error('error: ', error)
    }

}


class Connection extends EventEmitter {

    constructor() {
        super()

        /**
         * @type {null|module:net.Socket}
         */
        this.socket = null

        /**
         * @type {Buffer}
         */
        this.data = Buffer.from([])

        /**
         * @type {boolean}
         * @private
         */
        this._closeEmitted = false

        /**
         * @type {null|string}
         */
        this.remoteAddress = null

        /**
         * @type {null|number}
         */
        this.remotePort = null

        /**
         * @type {boolean}
         * @private
         */
        this._isAuthorized = !config.get('password')

        /**
         * @type {boolean}
         */
        this._isOutgoing = false

        /**
         * @type {number}
         */
        this._lastOutgoingRequestNo = random(0, REQUEST_NO_LIMIT)

        /**
         * @type {object.<number, Promise>}
         * @private
         */
        this._requestPromises = {}

        /**
         * @type {Promise}
         * @private
         */
        this._connectPromise = null

        this._setLogger()
    }

    /**
     * @param {string} host
     * @param {number} port
     * @return {Promise}
     */
    connect(host, port) {
        if (this.socket !== null)
            throw new Error(`this Connection already has a socket`)

        this._isOutgoing = true

        this.logger.trace(`Connecting to ${host}:${port}`)

        this.socket = new net.Socket()
        this.socket.connect(port, host)

        this.remoteAddress = host
        this.remotePort = port

        this._setLogger()
        this._setSocketEvents()

        return this._connectPromise = createCallablePromise()
    }

    /**
     * @param {module:net.Socket} socket
     */
    setSocket(socket) {
        this.socket = socket

        this.remoteAddress = socket.remoteAddress
        this.remotePort = socket.remotePort

        if (this.remoteAddress === '127.0.0.1' && config.get('always_allow_localhost') === true)
            this._isAuthorized = true

        this._setLogger()
        this._setSocketEvents()
    }

    /**
     * @private
     */
    _setLogger() {
        let addr = this.socket ? this.remoteAddr() : '?'
        this.logger = getLogger(`<Connection ${addr}>`)
    }

    /**
     * @private
     */
    _setSocketEvents() {
        this.socket.on('connect', this.onConnect)
        this.socket.on('data', this.onData)
        this.socket.on('end', this.onEnd)
        this.socket.on('close', this.onClose)
        this.socket.on('error', this.onError)
    }

    /**
     * @param {Buffer} data
     * @private
     */
    _appendToBuffer(data) {
        this.data = Buffer.concat([this.data, data])
    }

    /**
     * @return {string}
     */
    remoteAddr() {
        return this.remoteAddress + ':' + this.remotePort
    }

    /**
     * @private
     */
    _processChunks() {
        if (!this.data.length)
            return

        this.logger.trace(`processChunks (start):`, this.data)

        /**
         * @type {Buffer[]}
         */
        let messages = []
        let offset = 0
        let eotPos
        do {
            eotPos = this.data.indexOf(EOT, offset)
            if (eotPos !== -1) {
                let message = this.data.slice(offset, eotPos)
                messages.push(message)

                this.logger.debug(`processChunks: found new message (${offset}, ${eotPos})`)
                offset = eotPos + 1
            }
        } while (eotPos !== -1 && offset < this.data.length-1)

        if (offset !== 0) {
            this.data = this.data.slice(offset)
            this.logger.trace(`processChunks: slicing data from ${offset}`)
        }

        this.logger.trace(`processChunks (after parsing):`, this.data)

        for (let rawMessage of messages) {
            try {
                let buf = rawMessage.toString('utf-8')
                this.logger.debug(buf)

                let json = JSON.parse(buf)

                // try to parse the message
                let message
                try {
                    message = this._parseMessage(json)
                } catch (e) {
                    // message is malformed
                    this.logger.error(e.message)

                    // send error to the other size
                    this.send(
                        new ResponseMessage(0).setError(e.message)
                    )

                    continue
                }

                if (message instanceof PingMessage) {
                    this.send(new PongMessage())
                    continue
                }

                if (message instanceof PongMessage)
                    continue

                if (message instanceof RequestMessage) {
                    if (!this._isAuthorized) {
                        if (message.password !== config.get('password')) {
                            this.send(new ResponseMessage(message.requestNo).setError('invalid password'))
                            this.close()
                            break
                        }

                        this._isAuthorized = true
                    }

                    this.emit('request-message', message, this)
                }

                if (message instanceof ResponseMessage) {
                    if (message.requestNo in this._requestPromises) {
                        const P = this._requestPromises[message.requestNo]
                        delete this._requestPromises[message.requestNo]

                        P.resolve(message)
                    } else {
                        this.logger.warn('received unexpected Response message:', message)
                    }
                }
            } catch (error) {
                this.logger.error('error while parsing message:', error, rawMessage.toString('utf-8'))
                this.logger.trace(rawMessage)
            }
        }
    }

    /**
     * Parse incoming message
     *
     * @param {object} json
     * @return {Message}
     * @private
     * @throws Error
     */
    _parseMessage(json) {
        if (!Array.isArray(json))
            throw new Error('JSON array expected, got: ' + json)

        let type = json.shift()
        let message
        switch (type) {
            case Message.REQUEST: {
                let data = json.shift()

                try {
                    validateObjectSchema(data, [
                        // name      type    required
                        ['type',     's',    true],
                        ['no',       'i',    true],
                        ['password', 's',    false],
                        ['data',     'snoa', false]
                    ])
                } catch (e) {
                    throw new Error(`malformed REQUEST message: ${e.message}`)
                }

                message = new RequestMessage(data.type, data.data || null)
                message.setRequestNo(data.no)
                if (data.password)
                    message.setPassword(data.password)

                return message
            }

            case Message.RESPONSE: {
                let data = json.shift()

                try {
                    validateObjectSchema(data, [
                        // name   type     required
                        ['no',    'i',     true],
                        ['data',  'snoa',  false],
                        ['error', 's',     false],
                    ])
                } catch (e) {
                    throw new Error(`malformed RESPONSE message: ${e.message}`)
                }

                message = new ResponseMessage(data.no)
                message.setError(data.error || null)
                    .setData(data.data || null)

                return message
            }

            case Message.PING:
                return new PingMessage()

            case Message.PONG:
                return new PongMessage()

            default:
                throw new Error(`unexpected type ${type}`)
        }
    }

    /**
     * Send request
     *
     * @param {RequestMessage} message
     * @return {Promise<ResponseMessage>}
     */
    sendRequest(message) {
        if (!(message instanceof RequestMessage))
            throw new Error('sendRequest only accepts RequestMessage, got:', message)

        // send password once (when talking to jobd-master)
        if (!this._isAuthorized) {
            message.setPassword(config.get('password') || '')
            this._isAuthorized = true
        }

        // assign request number
        const no = this._getNextOutgoingRequestNo()
        if (this._requestPromises[no] !== undefined) {
            this.logger.error(`sendRequest: next request's No is ${no}, found a promise awaiting response with the same no, rejecting...`)
            this._requestPromises[no].reject(new Error(`this should not happen, but another request needs this number (${no})`))
            delete this._requestPromises[no]
        }

        message.setRequestNo(no)

        // send it
        this.send(message)

        // create and return promise
        const P = createCallablePromise()
        this._requestPromises[no] = P

        return P
    }

    /**
     * Send any Message
     *
     * @type {Message} data
     * @param message
     */
    send(message) {
        if (!(message instanceof Message))
            throw new Error('send expects Message, got: ' + message)

        let json = JSON.stringify(message.getAsObject())
        let buf = Buffer.concat([
            Buffer.from(json),
            Buffer.from([EOT])
        ])

        this.logger.debug('send:', json)
        this.logger.trace('send:', buf)

        try {
            this.socket.write(buf)
        } catch (error) {
            this.logger.error(`processChunks: failed to write response ${JSON.stringify(message)} to a socket`, error)
        }
    }

    _getNextOutgoingRequestNo() {
        this._lastOutgoingRequestNo++;
        if (this._lastOutgoingRequestNo >= REQUEST_NO_LIMIT)
            this._lastOutgoingRequestNo = 1
        return this._lastOutgoingRequestNo
    }

    /**
     */
    close() {
        try {
            this.socket.end()
            this.socket.destroy()
            this._handleClose()
        } catch (error) {
            this.logger.error('close:', error)
        }
    }

    /**
     * @private
     */
    _handleClose() {
        if (!this._closeEmitted) {
            this._closeEmitted = true
            this.emit('close')
        }

        for (const no in this._requestPromises) {
            this._requestPromises[no].reject(new Error('Socket is closed'))
        }

        this._requestPromises = {}
    }

    onConnect = () => {
        if (this._connectPromise) {
            this._connectPromise.resolve()
            this._connectPromise = null
        }

        this.logger.debug('Connection established.')
        this.emit('connect')
    }

    onData = (data) => {
        this.logger.trace('onData', data)
        this._appendToBuffer(data)
        this._processChunks()
    }

    onEnd = (data) => {
        if (data)
            this._appendToBuffer(data)

        this._processChunks()
    }

    onClose = (hadError) => {
        this._handleClose()
        this.logger.debug(`Socket closed` + (hadError ? ` with error` : ''))
    }

    onError = (error) => {
        if (this._connectPromise) {
            this._connectPromise.reject(error)
            this._connectPromise = null
        }
        this._handleClose()
        this.logger.warn(`Socket error:`, error)
    }

}

module.exports = {
    Server,
    Connection,
    RequestMessage,
    ResponseMessage,
    PingMessage,
    PongMessage,
}