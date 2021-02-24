const net = require('net')
const EventEmitter = require('events')
const {getLogger} = require('./logger')
const isObject = require('lodash/isObject')

const EOT = 0x04

class Message {

    static REQUEST = 0
    static RESPONSE = 1

    /**
     * @param {number} type
     */
    constructor(type) {
        /**
         * @type {number}
         */
        this.type = type
    }

    getAsObject() {
        return [this.type]
    }

}

class ResponseMessage extends Message {
    constructor() {
        super(Message.RESPONSE)

        this.error = null
        this.data = null
    }

    setError(error) {
        this.error = error
        return this
    }

    setData(data) {
        this.data = data
        return this
    }

    getAsObject() {
        return [
            ...super.getAsObject(),
            [
                this.error,
                this.data
            ]
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
         * @type any
         */
        this.requestData = data

        /**
         * @type {null|string}
         */
        this.password = null
    }

    getAsObject() {
        let request = {
            type: this.requestType
        }

        if (this.requestData)
            request.data = this.requestData

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
        connection.on('message', (message) => {
            this.emit('message', {
                message,
                connection
            })
        })

        this.logger.info(`new connection from ${socket.remoteAddress}:${socket.remotePort}`)
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
         * @type {null|number}
         */
        this.id = null

        this._setLogger()
    }

    /**
     * @param {string} host
     * @param {number} port
     */
    connect(host, port) {
        if (this.socket !== null)
            throw new Error(`this Connection already has a socket`)

        this.socket = new net.Socket()
        this.socket.connect({host, port})

        this.remoteAddress = host
        this.remotePort = port

        this._setId()
        this._setLogger()
        this._setSocketEvents()
    }

    /**
     * @param {module:net.Socket} socket
     */
    setSocket(socket) {
        this.socket = socket

        this.remoteAddress = socket.remoteAddress
        this.remotePort = socket.remotePort

        this._setId()
        this._setLogger()
        this._setSocketEvents()
    }

    /**
     * @private
     */
    _setLogger() {
        let addr = this.socket ? this.remoteAddr() : '?'
        this.logger = getLogger(`<Connection ${this.id} ${addr}>`)
    }

    /**
     * @private
     */
    _setId() {
        this.id = Math.floor(Math.random() * 10000)
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

        for (let message of messages) {
            try {
                let buf = message.toString('utf-8')
                this.logger.debug(buf)

                let json = JSON.parse(buf)
                this._emitMessage(json)
            } catch (error) {
                this.logger.error('failed to parse data as JSON')
                this.logger.debug(message)
            }
        }
    }

    /**
     * @param {object} json
     * @private
     */
    _emitMessage(json) {
        if (!Array.isArray(json)) {
            this.logger.error('malformed message, JSON array expected', json)
            return
        }

        let type = json.shift()
        let message
        switch (type) {
            case Message.REQUEST: {
                let data = json.shift()
                if (!data || !isObject(data)) {
                    this.logger.error('malformed REQUEST message')
                    return
                }

                message = new RequestMessage(data.type, data.data || null)
                if (data.password)
                    message.setPassword(data.password)
                break
            }

            case Message.RESPONSE: {
                let data = json.shift()
                if (!data || !Array.isArray(data) || data.length < 2) {
                    this.logger.error('malformed RESPONSE message')
                    return
                }

                message = new ResponseMessage()
                message.setError(data[0]).setData(data[1])

                break
            }

            default:
                this.logger.error(`malformed message, unexpected type ${type}`)
                return
        }

        this.emit('message', message)
    }

    /**
     * @type {Message} data
     * @param message
     */
    send(message) {
        if (!(message instanceof Message))
            throw new Error('send expects Message, got', message)

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

    /**
     */
    close() {
        try {
            this.socket.end()
            this.socket.destroy()
            this._emitClose()
        } catch (error) {
            this.logger.error('close:', error)
        }
    }

    /**
     * @private
     */
    _emitClose() {
        if (this._closeEmitted)
            return

        this._closeEmitted = true
        this.emit('close')
    }

    onConnect = () => {
        this.logger.debug('connection established')
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
        this._emitClose()
        this.logger.debug(`socket closed` + (hadError ? ` with error` : ''))
    }

    onError = (error) => {
        this._emitClose()
        this.logger.warn(`socket error:`, error)
    }
    
}

module.exports = {
    Server,
    Connection,
    RequestMessage,
    ResponseMessage
}