'use strict';
const express = require('express');
const helmet = require('helmet');
const compress = require('compression');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const multer = require('multer');
const uuid = require('uuid/v1');
const https = require('https');
const http = require('http');
/**
 * 对express及其常用插件封装的类
 * express相关信息：https://github.com/expressjs/express
 * helmet相关信息：https://github.com/helmetjs/helmet
 * compression相关信息：https://github.com/expressjs/compression
 * cookie-parser相关信息：https://github.com/expressjs/cookie-parser
 * body-parser相关信息：https://github.com/expressjs/body-parser
 * multer相关信息：https://github.com/expressjs/multer
 */
class WebServer {
    /**
     * @callback UploadCallback
     * @param {number} code 成功时code为200
     * @param {string|{}} data
     * @param {Request} req
     * @param {Response} resp
     */
    /**
     * @callback CloseCallback
     * @param {Error} error
     */
    /**
     * 构造函数参数
     * @param context {EnvContext} 上下文包装类实例
     * @param category {string} 日志分类
     * @param config {Object} 配置信息
     * @param config.helmet {Object} helmet插件配置，null不启用该插件，参考依赖库 https://github.com/helmetjs/helmet
     * @param config.compress {Object} compress插件配置，null不启用该插件，参考依赖库 https://github.com/expressjs/compression
     * @param config.cookieSecret {string|array} cookie-parser插件密钥，null不启用该插件，参考依赖库 https://github.com/expressjs/cookie-parser
     * @param config.cookieOptions {Object} cookie-parser插件配置，设置cookieSecret后生效，参考依赖库 https://github.com/expressjs/cookie-parser
     * @param config.bodyParserJson {Object} cookie-parser.json插件配置，null不启用该插件，参考依赖库 https://github.com/expressjs/body-parser
     * @param config.bodyParserForm {Object} cookie-parser.urlencoded插件配置，null不启用该插件，参考依赖库 https://github.com/expressjs/body-parser
     * @param config.uploadKey {string} 上传表单'文件字段'，本类封装的是单文件上传功能，批量上传可同时创建多个请求
     * @param config.uploadDir {string} 上传文件的保存位置
     * @param config.uploadMimeTypes: {Object} 允许上传的mimeType，默认为{'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/bmp': 'bmp'}
     */
    constructor(context, category, config = {}) {
        this._context = context;
        this._config = {
            helmet: {},
            compress: {},
            cookieSecret: uuid(),
            cookieOptions: {},
            bodyParserJson: {},
            bodyParserForm: { extended: true },
            uploadKey: null,
            uploadDir: null,
            uploadMimeTypes: { 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/bmp': 'bmp' }
        };
        Object.assign(this._config, config);//拷贝配置信息
        //绑定log4js实例
        this._logger = context.getLogger(category);
        //绑定app和server
        this._express = express;
        this._webapp = express();//创建express应用实例
        this._server = context.ssls ? https.createServer(context.readSSLKerCert(), this._webapp) : http.createServer(this._webapp);//创建HTTP/S服务器实例
        //其它属性
        this._upload = null;//文件上传处理实例
    }
    /**
     * 加载比较常用的几个第三方模块
     */
    loadBaseModules() {
        //启用helmet插件
        if (this._config.helmet) {
            this._webapp.use(helmet(this._ensureObject(this._config.helmet)));
            this._logger.info('helmet module was loaded');
        }
        //启用compress插件（放在最前面可以保证后面的所有内容都经过压缩）
        if (this._config.compress) {
            this._webapp.use(compress(this._ensureObject(this._config.compress)));
            this._logger.info('compression module was loaded');
        }
        //启用cookie-parser插件
        if (this._config.cookieSecret) {
            this._webapp.use(cookieParser(this._config.cookieSecret, this._ensureObject(this._config.cookieOptions)));
            this._logger.info('cookie-parser module was loaded');
        }
        //启用cookie-parser插件，解析application/json
        if (this._config.bodyParserJson) {
            this._webapp.use(bodyParser.json(this._ensureObject(this._config.bodyParserJson)));
            this._logger.info('body-parser.json module was loaded');
        }
        //启用cookie-parser插件，解析application/x-www-form-urlencoded
        if (this._config.bodyParserForm) {
            this._webapp.use(bodyParser.urlencoded(this._ensureObject(this._config.bodyParserForm)));
            this._logger.info('body-parser.urlencoded module was loaded');
        }
    }
    /**
     * 加载打印全部请求信息的模块
     * @param logHeaders {boolean} 是否打印请求头信息
     * @param logArgs {boolean} 是否打印参数信息
     */
    loadPrintModule(logHeaders = false, logArgs = false) {
        this._webapp.all('*', (req, resp, next) => {
            this._logger.info(this._context.getIPV4(req), req.originalUrl);//打印出所有请求路径
            if (logHeaders) this._logger.debug('req.headers ->', req.headers);
            if (logArgs) {
                if (!this._context.isEmptyObject(req.params)) this._logger.debug('req.params ->', req.params);
                if (!this._context.isEmptyObject(req.body)) this._logger.debug('req.body ->', req.body);
                if (!this._context.isEmptyObject(req.query)) this._logger.debug('req.query ->', req.query);
                if (!this._context.isEmptyObject(req.cookies)) this._logger.debug('req.cookies ->', req.cookies);
                if (!this._context.isEmptyObject(req.signedCookies)) this._logger.debug('req.signedCookies ->', req.signedCookies);
            }
            next();
        });
        this._logger.info('inner-print module was loaded');
    }
    /**
     * 加载文件上传模块，具体属性参考依赖库 https://github.com/expressjs/multer
     * @param url {string} 上传请求的url
     * @param callback {UploadCallback} 上传成功或失败的回调，第一个回调参数code=200为成功，其它为失败
     * @param storage {Object} 上传储存配置
     * @param limits {Object} 上传限制
     * @param fileFilter {function} 上传过滤器
     * @param preservePath {boolean} 是否保留文件的完整路径
     */
    loadUploadModule(url, callback, storage = undefined, limits = undefined, fileFilter = undefined, preservePath = undefined) {
        if (!this._config.uploadKey || !this._config.uploadDir) {
            throw Error('upload configuration not specified');
        }
        this._upload = multer({
            storage: storage || multer.diskStorage({
                destination: (req, file, callback) => {
                    const date = new Date();
                    const folder = this._config.uploadDir + '/' + date.getFullYear() + '_' + (date.getMonth() + 1) + '_' + date.getDate() + '/';
                    if (this._context.mkdirsSync(folder)) {
                        callback(null, folder);
                    } else {
                        callback(new Error('创建文件夹出错'));
                    }
                },
                filename: (req, file, callback) => {
                    const suffix = this._config.uploadMimeTypes[file.mimetype.toLowerCase()];
                    if (suffix) {
                        callback(null, uuid() + '.' + suffix);
                    } else {
                        callback(new Error('不支持的文件格式'));
                    }
                }
            }),
            limits: limits || {
                fileSize: 1024 * 1024 * 10
            },
            fileFilter: fileFilter,
            preservePath: preservePath
        });
        //实际使用时,必须为POST请求才能收到文件
        this._webapp.all(url, (req, resp) => {
            this._upload.single(this._config.uploadKey)(req, resp, (error) => {
                if (req.file) {
                    this._logger.debug('req.file ->', req.file);
                    if (error) {
                        callback(500, 'Internal Server Error, ' + error.toString(), req, resp);
                    } else {
                        const data = {};
                        Object.assign(data, req.body);
                        data._path = req.file.path.replace(new RegExp('\\\\', 'gm'), '/').replace(this._config.uploadDir, '');//windows系统下分隔符为'\'
                        data._size = req.file.size;
                        data._mimetype = req.file.mimetype;
                        data._orgname = req.file.originalname;
                        this._logger.debug('success data ->', data);
                        callback(200, data, req, resp);
                    }
                } else {
                    callback(400, 'Bad Request, ' + (error ? error.toString() : new Error('没有收到文件').toString()), req, resp);
                }
            });
        });
        this._logger.info('inner-upload module was loaded');
    }
    /**
     * 开启服务器
     * @param callback {function} 服务器启动后的回调函数
     */
    start(callback = undefined) {
        this._server.listen(this._context.port, () => {
            this._logger.info('ssls', this._context.ssls, this._context.host, this._context.port, 'is listening...');
            if (callback) callback();
        });
    }
    /**
     * 关闭服务器
     * @param callback {CloseCallback} 服务器关闭后的回调函数
     */
    close(callback = undefined) {
        this._server.close((error) => {
            this._logger.info('ssls', this._context.ssls, this._context.host, this._context.port, 'was closed.');
            if (callback) callback(error);
        });
    }
    /**
     * 返回Logger实例
     * @return {Logger}
     */
    get logger() { return this._logger; }
    /**
     * 返回express
     * @returns {import('express')}
     */
    get express() { return this._express; }
    /**
     * 返回express实例
     * @returns {Express}
     */
    get webapp() { return this._webapp; }
    /**
     * 返回HTTP/S服务器实例
     * @returns {Server | any}
     */
    get server() { return this._server; }
    /**
     * 确保返回一个object类型
     * @param config
     * @returns {Object}
     * @private
     */
    _ensureObject(config) {
        return config && typeof config === 'object' ? config : {};
    }
}
module.exports = WebServer;
