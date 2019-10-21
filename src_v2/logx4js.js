"use strict";
const log4js = require('log4js');
let lineDebug = false;
const Logx4js = function (category, contexts) {
    this.logger = log4js.getLogger(category);
    if (contexts) {
        for (let key in contexts) {
            this.logger.addContext(key, contexts[key]);
        }
    }
};
Logx4js.prototype.trace = function () {
    this.resetLine();
    this.logger.trace.apply(this.logger, arguments);
};
Logx4js.prototype.debug = function () {
    this.resetLine();
    this.logger.debug.apply(this.logger, arguments);
};
Logx4js.prototype.info = function () {
    this.resetLine();
    this.logger.info.apply(this.logger, arguments);
};
Logx4js.prototype.warn = function () {
    this.resetLine();
    this.logger.warn.apply(this.logger, arguments);
};
Logx4js.prototype.error = function () {
    this.resetLine();
    this.logger.error.apply(this.logger, arguments);
};
Logx4js.prototype.fatal = function () {
    this.resetLine();
    this.logger.fatal.apply(this.logger, arguments);
};
Logx4js.prototype.resetLine = function () {
    if (lineDebug) {
        this.logger.addContext('line', new Error().stack.split('\n')[3].split(':')[1]);
    }
};

module.exports = {
    /**
     * @param cfg 日志配置文件
     */
    configure: function (cfg) {
        lineDebug = !!cfg.lineDebug;
        log4js.configure(cfg);
    },
    /**
     * @param category 日志分类
     * @param contexts 格式化内容
     * @returns {Logx4js} 类实例
     */
    getLogger: function (category, contexts) {
        return new Logx4js(category, contexts);
    }
};