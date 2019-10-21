"use strict";
const path = require('path');
const helmet = require('helmet');
const compress = require('compression');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const multer = require('multer');
const websocket = require('ws');
const fs = require('fs');
const crypto = require('crypto');
const logx4js = require('./logx4js');
const Context = function (base, env, name, port) {
    this.base = path.dirname(base);
    this.env = env;
    this.name = name;
    this.port = port;
    this.config = {
        serverConfig: {
            ssl: false,
            wss: false,
            webGzip: false,
            webApiRoot: '/default',
            webCookieKey: false,
            webUploadDir: this.base + '/files',
            webUploadMax: 1024 * 1024 * 10 //byte
        }
    };
    this.logcfg = null;
    this.logger = null;
    this.express = null;
    this.webapp = null;
    this.wssapp = null;
    this.server = null;
    this.mongo = null;
    this.access = null;
    this.upload = null;
};
Context.prototype.loadLogx4js = function (filepath) {
    let logStr = fs.readFileSync(filepath, 'utf8');
    logStr = logStr.replace(new RegExp('\\$\\{opts\\:base\\}', 'gm'), this.getBase());
    logStr = logStr.replace(new RegExp('\\$\\{opts\\:name\\}', 'gm'), this.name);
    logStr = logStr.replace(new RegExp('\\$\\{opts\\:port\\}', 'gm'), this.port);
    this.logcfg = JSON.parse(logStr)[this.env];
    logx4js.configure(this.logcfg);
    this.logger = this.getLogger('context', __filename);
};
Context.prototype.loadConfig = function (key, filepath) {
    this.set(key, JSON.parse(fs.readFileSync(filepath, 'utf8'))[this.env]);
};
Context.prototype.configure = function (env, name, callback) {
    if (typeof name === 'function') {
        callback = name;
        name = null;
    }
    const envArr = env.split('|');
    if (envArr.indexOf(this.env) >= 0) {
        if (name) {
            const typeArr = name.split('|');
            if (typeArr.indexOf(this.name) >= 0) {
                callback();
            }
        } else {
            callback();
        }
    }
};
Context.prototype.getLogger = function (category, filepath) {
    return logx4js.getLogger(category, {
        file: filepath,
        base: this.base,
        env: this.env,
        name: this.name,
        port: this.port
    });
};
Context.prototype.getBase = function () {
    return this.base;
};
Context.prototype.set = function (key, value) {
    if (key === 'serverConfig') {
        if (typeof value === 'object') {
            for (let k in value) {
                this.config.serverConfig[k] = value[k];
            }
        } else {
            this.logger.error('value of serverConfig must be an object');
        }
    } else {
        this.config[key] = value;
    }
};
Context.prototype.get = function (key) {
    return this.config[key];
};
Context.prototype.getIPV4 = function (req) {
    let ip = req.headers['x-forwarded-for'] || req.ip;
    if (!ip || '::1' === ip) {
        ip = '127.0.0.1';
    }
    ip = ip.replace(/[:f]/gm, '');
    ip = ip.split(/\s*,\s*/)[0];
    ip = ip.trim() || '127.0.0.1';
    return ip;
};
Context.prototype.getMd5 = function (strData, strCode) {
    const buf = Buffer.from(strData);
    const str = buf.toString(strCode);//strCode='binary'可解决md5加密的中文编码不一致问题
    return crypto.createHash('md5').update(str).digest('hex').toUpperCase();
};
Context.prototype.start = function (mongo, access, onLoadModule, onRegisterApi) {
    const self = this;
    const logger = this.logger;
    const config = this.config.serverConfig;
    this.express = require('express');
    this.webapp = this.express();
    this.webapp.use(helmet());
    this.server = config.ssl ? require('https').createServer({
        key: fs.readFileSync(config.ssl.key, 'utf8'),
        cert: fs.readFileSync(config.ssl.cert, 'utf8')
    }, this.webapp) : require('http').createServer(this.webapp);
    if (config.wss) {
        const wsscfg = {};
        if (typeof config.wss === 'object') {
            for (let key in config.wss) {
                wsscfg[key] = config.wss[key];
            }
        }
        wsscfg.server = this.server;
        this.wssapp = new websocket.Server(wsscfg);
    }
    this.mongo = mongo;
    this.access = access;
    this.registerUpload();
    if (config.webGzip) {
        this.webapp.use(compress(typeof config.webGzip === 'object' ? config.webGzip : {}));//放在最前面可以保证后面的所有内容都经过压缩
    }
    if (config.webCookieKey) {
        this.webapp.use(cookieParser(typeof config.webCookieKey === 'string' ? config.webCookieKey : mongo.genID()));//若使用签名则传入或生成一个key字符串
    }
    this.webapp.use(bodyParser.json());//用于解析application/json
    this.webapp.use(bodyParser.urlencoded({extended: true}));//用户解析application/x-www-form-urlencoded
    this.webapp.all('/*', function (req, res, next) {
        logger.info(self.getIPV4(req), req.originalUrl);//打印出所有请求路径
        next();
    });
    if (onLoadModule) {
        onLoadModule.call(this);//加载自定义模块或静态资源
    }
    this.registerApi();
    if (onRegisterApi) {
        onRegisterApi.call(this);//加载自定义接口
    }
    this.server.listen(this.port, function () {
        logger.info(self.env, 'server', self.port, 'is listening...');
    });
};
Context.prototype.registerUpload = function () {
    const self = this;
    const logger = this.logger;
    const config = this.config.serverConfig;
    const storage = multer.diskStorage({
        destination: function (req, file, callback) {
            const store = req.params.store;
            const date = new Date();
            const folder = config.webUploadDir + '/' + store + '/' + date.getFullYear() + '_' + (date.getMonth() + 1) + '_' + date.getDate() + '/';
            self.makeDirs(folder, null, function (dirpath) {
                logger.debug('makeDirs after:', dirpath);
                callback(null, dirpath);
            });
        },
        filename: function (req, file, callback) {
            const store = req.params.store;
            const privilege = self.access.store[store];
            if (privilege && privilege.mimeType) {
                const suffix = privilege.mimeType[file.mimetype.toLowerCase()];
                if (suffix) {
                    callback(null, self.mongo.genID() + '.' + suffix);
                } else {
                    callback(new Error('不支持的文件格式'));
                }
            } else {
                callback(new Error('服务端未配置文件格式'));
            }
        }
    });
    this.upload = multer({
        storage: storage,
        limits: {
            fileSize: config.webUploadMax
        }
    });
};
Context.prototype.registerApi = function () {
    const self = this;
    const logger = this.logger;
    const config = this.config.serverConfig;
    this.webapp.all(config.webApiRoot + '/:store/:method', function (req, res, next) {
        logger.debug('req.params -> \n', req.params);
        logger.debug('req.body -> \n', req.body);
        logger.debug('req.query -> \n', req.query);
        logger.debug('req.cookies -> \n', req.cookies);
        logger.debug('req.signedCookies -> \n', req.signedCookies);
        if (self.access) {
            const store = req.params.store;
            const method = req.params.method;
            const privilege = self.access.store[store];
            if (method === 'fields' || method === 'mimeType' || !privilege || !privilege[method]) {
                res.json({
                    code: 405,
                    data: 'Method Not Allowed'
                });
            } else {
                self.access.authorize(store, method, req, function () {
                    next();
                }, function (code, data) {
                    res.json({
                        code: code || 401,
                        data: data || 'Unauthorized'
                    });
                });
            }
        } else {
            res.json({
                code: 501,
                data: 'Not Implemented'
            });
        }
    });
    this.webapp.all(config.webApiRoot + '/:store/upload', function (req, res) {
        const store = req.params.store;
        self.upload.single('file')(req, res, function (error) {
            if (req.file) {
                logger.debug('req.file -> \n', req.file);
                if (!error) {
                    const data = req.body;
                    data._path = req.file.path.replace(new RegExp('\\\\', 'gm'), '/').replace(config.webUploadDir, '');//windows系统下分隔符为'\'
                    data._size = req.file.size;
                    data._mimetype = req.file.mimetype;
                    data._orgname = req.file.originalname;
                    logger.debug('data -> \n', data);
                    self.mongo.insertOneDoc(store, data, null, function (obj, n) {
                        res.json({
                            code: 200,
                            data: obj
                        });
                    }, function (error) {
                        res.json({
                            code: 500,
                            data: 'Internal Server Error, ' + error.toString()
                        });
                    });
                } else {
                    res.json({
                        code: 500,
                        data: 'Internal Server Error, ' + error.toString()
                    });
                }
            } else {
                res.json({
                    code: 400,
                    data: 'Bad Request, ' + (error ? error.toString() : 'Error: 没有收到文件')
                });
            }
        });
    });//实际使用时,必须为POST请求才能收到文件
};
Context.prototype.makeDirs = function (dirpath, mode, callback) {
    const self = this;
    const logger = this.logger;
    fs.exists(dirpath, function (exists) {
        logger.debug('makeDirs check:', dirpath, exists);
        if (exists) {
            callback(dirpath);
        } else {
            self.makeDirs(path.dirname(dirpath), mode, function (parentPath) {
                logger.debug('makeDirs after:', parentPath);
                fs.mkdir(dirpath, mode, function () {
                    callback(dirpath);
                });
            });
        }
    });
};
Context.prototype.printInfo = function (printConfig, printLogCfg) {
    this.logger.info('server info ->\n', JSON.stringify({
        base: this.base,
        env: this.env,
        name: this.name,
        port: this.port
    }, null, 2));
    if (printConfig) {
        this.logger.info('context config ->\n', JSON.stringify(this.config, null, 2));
    }

    if (printLogCfg) {
        this.logger.info('logx4js config ->\n', JSON.stringify(this.logcfg, null, 2));
    }
};

module.exports = {
    /**
     * @param base 服务器入口文件路径（通过解析该值得到来到根目录）
     * @param env 服务器环境类型（如：development、production等自由定义）
     * @param name 服务器名称（如：master、slave等自由定义）
     * @param port 服务器端口号
     * @returns {Context} 类实例
     */
    create: function (base, env, name, port) {
        return new Context(base, env, name, port);
    }
};
