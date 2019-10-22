'use strict';
const fs = require('fs');
const path = require('path');
const log4js = require('log4js');

/**
 * 运行环境工具类
 * lo4js相关信息：https://log4js-node.github.io/log4js-node/
 * 自定义证书生成:
 * openssl genrsa -out localhost.key 2048
 * openssl req -new -sha256 -key localhost.key -out localhost.csr
 * openssl x509 -req -in localhost.csr -signkey localhost.key -out localhost.pem
 */
class EnvContext {
    /**
     * 根据环境变量创建上下文实例
     * @param processEnv {Object}
     * @param encode {string} 编码默认值为utf8
     * @return {EnvContext}
     */
    static createByProcessEnv(processEnv, encode = 'utf8') {
        return new EnvContext(
            processEnv.MYAPP_DIR,
            processEnv.MYAPP_ENV,
            processEnv.MYAPP_NAME,
            processEnv.MYAPP_HOST,
            processEnv.MYAPP_INIP,
            processEnv.MYAPP_PORT,
            JSON.parse(processEnv.MYAPP_SSLS),
            JSON.parse(processEnv.MYAPP_LINKS),
            JSON.parse(processEnv.MYAPP_NODES),
            encode
        );
    }
    /**
     * 构造函数参数
     * @param appDir {string} 节点启动时指定的一个根目录绝对路径
     * @param appEnv {string} 节点启动环境类型，如: development、production1、production2、production3...
     * @param appName {string} 节点类型名称，如 http、home、chat...
     * @param appHost {string} 节点所在主机名
     * @param appInIP {string} 节点所在主机内网IP
     * @param appPort {number} 节点所监听的端口号
     * @param appSSLs {{key:string,cert:string}} 节点SSL证书路径
     * @param appLinks {string[]} 本节点需要连接的其它节点类型名称
     * @param appNodes {Object.<string,{host:string,inip:string,port:number,ssls:boolean}[]>} 全部的节点
     * @param encode {string} 编码默认值为utf8
     */
    constructor(appDir, appEnv, appName, appHost, appInIP, appPort, appSSLs = undefined, appLinks = undefined, appNodes = undefined, encode = 'utf8') {
        this._appDir = appDir;
        this._appEnv = appEnv;
        this._appName = appName;
        this._appHost = appHost;
        this._appInIP = appInIP;
        this._appPort = Number(appPort);
        this._appSSLs = appSSLs;
        this._appLinks = appLinks;
        this._appNodes = appNodes;
        /** @type {string} **/
        this._encode = encode;
        //其它属性
        this._logcfgs = null;//log4js的配置文件信息
        this._context = {};
    }
    /**
     * 从指定文件中加载对应_envName的log4js的配置信息，初始化log4js
     * @param filepath {string} log4js的配置文件绝对路径
     */
    initLog4js(filepath) {
        let logStr = fs.readFileSync(filepath, {encoding: this._encode});
        logStr = logStr.replace(new RegExp('\\${opt:appDir}', 'gm'), this._appDir);
        logStr = logStr.replace(new RegExp('\\${opt:appEnv}', 'gm'), this._appEnv);
        logStr = logStr.replace(new RegExp('\\${opt:appName}', 'gm'), this._appName);
        logStr = logStr.replace(new RegExp('\\${opt:appHost}', 'gm'), this._appHost);
        logStr = logStr.replace(new RegExp('\\${opt:appPort}', 'gm'), String(this._appPort));
        this._logcfgs = JSON.parse(logStr)[this._appEnv];
        log4js.configure(this._logcfgs);
    }
    /**
     * 从指定文件中加载对应_envName的自定义配置信息
     * @param filepath {string} 自定义配置文件绝对路径
     * @returns {*}
     */
    loadConfig(filepath) {
        const cfgStr = fs.readFileSync(filepath, {encoding: this._encode});
        return JSON.parse(cfgStr)[this._appEnv];
    }
    /**
     *  指定环境、指定进程进行定制化回掉
     * @param appEnv {string} 指定进程启动环境类型，支持多个环境，如：development|production
     * @param appName {string|null} 指定进程类型，支持多个名称，如：gate|home|chat，传null表示全部环境
     * @param callback {function} 在这个回调函数里面定制自己的逻辑
     */
    configure(appEnv, appName, callback) {
        const envArr = appEnv.split('|');
        if (envArr.indexOf(this._appEnv) >= 0) {
            if (appName) {
                const appArr = appName.split('|');
                if (appArr.indexOf(this._appName) >= 0) {
                    callback();
                }
            } else {
                callback();
            }
        }
    }
    /**
     * 获取一个log4js实例
     * @param category {string} log4js的category
     * @returns {Logger} log4js的实例
     */
    getLogger(category) {
        if (!this._logcfgs) throw Error('log4js configuration not specified');
        const logger = log4js.getLogger(category);
        logger.addContext('env', this._appEnv);
        logger.addContext('name', this._appName);
        logger.addContext('host', this._appHost);
        logger.addContext('port', this._appPort);
        return logger;
    }
    /**
     * 缓存键值对数据
     * @param key {string}
     * @param value {*}
     */
    setContext(key, value) {
        this._context[key] = value;
    }
    /**
     * 读取键值对数据
     * @param key {string}
     * @returns {*}
     */
    getContext(key) {
        return this._context[key];
    }
    /**
     * 删除键值对数据
     * @param key {string}
     */
    delContext(key) {
        delete this._context[key];
    }
    /**
     * 创建多级文件夹
     * @param {string} dirname 文件夹路径
     * @returns {boolean} 是否创建成功
     */
    mkdirsSync(dirname) {
        if (fs.existsSync(dirname)) {
            return true;
        } else {
            if (this.mkdirsSync(path.dirname(dirname))) {
                try {
                    fs.mkdirSync(dirname);
                    return true;
                } catch (e) {
                    return false;
                }
            } else {
                return false;
            }
        }
    }
    /**
     * 获取IPV4地址
     * @param request {*} express等容器的request请求实例
     * @param headerField {string} 代理服务器的请求头字段名称
     * @returns {string} ipv4 地址
     */
    getIPV4(request, headerField = undefined) {
        let ip = (request.headers ? request.headers[headerField || 'x-forwarded-for'] : null) || request.ip;
        if (!ip || '::1' === ip) ip = '127.0.0.1';
        ip = ip.replace(/[:f]/gm, '');
        ip = ip.split(/\s*,\s*/)[0];
        ip = ip.trim() || '127.0.0.1';
        return ip;
    }
    /**
     * 读取ssl证书并返回
     * @return {{cert: string, key: string}}
     */
    readSSLKerCert() {
        return {
            key: fs.readFileSync(this._appSSLs.key, {encoding: this._encode}),
            cert: fs.readFileSync(this._appSSLs.cert, {encoding: this._encode})
        };
    }
    /**
     * 判断一个对象是否为空
     * @param obj {*}
     * @returns {boolean}
     */
    isEmptyObject(obj) {
        for (let key in obj) {
            if (obj.hasOwnProperty(key)) return false;
        }
        return true;
    }
    /**
     * 模拟休眠
     * @param time 毫秒
     * @returns {Promise<any>}
     */
    sleep(time) {
        return new Promise((resolve) => {
            setTimeout(() => {
                resolve();
            }, time);
        });
    }
    /**
     * @returns {string}
     */
    get host() {
        return this._appHost;
    }
    /**
     * @returns {number}
     */
    get port() {
        return this._appPort;
    }
    /**
     * @return {boolean}
     */
    get ssls() {
        return !!this._appSSLs;
    }
    /**
     * @return {string[]}
     */
    get links() {
        return this._appLinks;
    }
    /**
     * @return {Object<string, {host: string, inip: string, port: number, ssls: boolean}[]>}
     */
    get nodes() {
        return this._appNodes;
    }
    /**
     * @returns {string}
     */
    get encode() {
        return this._encode;
    }
}

module.exports = EnvContext;
