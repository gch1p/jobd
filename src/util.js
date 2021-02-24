module.exports = {
    timestamp() {
        return parseInt(+(new Date())/1000)
    },

    isNumeric(n) {
        return !isNaN(parseFloat(n)) && isFinite(n)
    }
}