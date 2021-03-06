const log4js = require('log4js')
const fs = require('fs/promises')
const fsConstants = require('fs').constants
const util = require('./util')

const ALLOWED_LEVELS = ['trace', 'debug', 'info', 'warn', 'error']

module.exports = {
    /**
     * @param {string} file
     * @param {string} levelFile
     * @param {string} levelConsole
     * @param {boolean} disableTimestamps
     */
    async init({file, levelFile, levelConsole, disableTimestamps=false}) {
        const categories = {
            default: {
                appenders: ['stdout-filter'],
                level: 'trace'
            }
        }

        if (!ALLOWED_LEVELS.includes(levelConsole))
            throw new Error(`Level ${levelConsole} is not allowed.`)

        const appenders = {
            stdout: {
                type: 'stdout',
                level: 'trace',
            },
            'stdout-filter': {
                type: 'logLevelFilter',
                appender: 'stdout',
                level: levelConsole,
            }
        }
        if (disableTimestamps)
            appenders.stdout.layout = {
                type: 'pattern',
                pattern: '%[%p [%c]%] %m',
            }

        if (file) {
            if (!ALLOWED_LEVELS.includes(levelFile))
                throw new Error(`Level ${levelFile} is not allowed.`)

            let exists
            try {
                await fs.stat(file)
                exists = true
            } catch (error) {
                exists = false
            }

            // if file exists
            if (exists) {
                // see if it's writable
                try {
                    // this promise fullfills with undefined upon success
                    await fs.access(file, fsConstants.W_OK)
                } catch (error) {
                    throw new Error(`file '${file}' is not writable:` + error.message)
                }
            } else {
                // try to create an empty file
                let fd
                try {
                    fd = await fs.open(file, 'wx')
                } catch (error) {
                    throw new Error(`failed to create file '${file}': ` + error.message)
                } finally {
                    await fd?.close()
                }
            }

            categories.default.appenders.push('file-filter')
            appenders.file = {
                type: 'file',
                filename: file,
                maxLogSize: 1024 * 1024 * 50,
                debug: 'debug'
            }
            appenders['file-filter'] = {
                type: 'logLevelFilter',
                appender: 'file',
                level: levelFile
            }
        }

        log4js.configure({
            appenders,
            categories
        })
    },

    /**
     * @return {Logger}
     */
    getLogger(...args) {
        return log4js.getLogger(...args)
    },

    /**
     * @return {Promise}
     */
    shutdown() {
        return new Promise((resolve, reject) => {
            log4js.shutdown(resolve)
        })
    },

    Logger: log4js.Logger,
}
