module.exports = {
    timestamp() {
        return parseInt(+(new Date())/1000)
    },

    isNumeric(n) {
        return !isNaN(parseFloat(n)) && isFinite(n)
    },

    /**
     * Creates a Promise that can be resolved or rejected from the outside
     *
     * @param {Function} abortCallback
     * @return {Promise}
     */
    createCallablePromise(abortCallback = null) {
        let promise, resolve, reject
        promise = new Promise(function(_resolve, _reject) {
            resolve = _resolve
            reject = _reject
        })
        promise.resolve = function(result) {
            resolve(result)
        }
        promise.reject = function(result) {
            reject(result)
        }
        return promise
    }
}
