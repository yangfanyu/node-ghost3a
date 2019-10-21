"use strict";
const WebSocket = require('ws');
const CryptoJS = require('crypto-js');
const Session = require('./session');
const HEARTICK = '$heartick$';//心跳包路由
const RESPONSE = '$response$';//响应请求路由
const NOSYNTAX = '$nosyntax$';//响应语法错误路由
const INNERP2P = '$innerp2p$';//跨进程p2p包路由
const INNERGRP = '$innergrp$';//跨进程grp路由
const INNERALL = '$innerall$';//跨进程广播路由
const INNERRMC = '$innerrmc$';//跨进程调用路由
const HEART_BT = 3;//必须满足 $timeout >= $heart * HEART_BT
const ERR_TYPE = {
    TYPE: 'type',//数据包类型不对
    SIZE: 'size',//数据包尺寸过大
    SIGN: 'sign',//数据包验签失败
    JSON: 'json',//数据包不是json格式
    PACK: 'pack',//数据包不是pack格式
    FLOW: 'flow',//数据包流量频率或ID验证失败
    DENY: 'deny',//数据包访问私有路由
    NONE: 'none',//数据包访问不存在的路由
    SOCK: 'sock',//套接字错误
    TIME: 'time',//一个心跳周期内未收到任何心跳包
    MAXC: 'maxc',//同一个ip的连接数过多
    AUTH: 'auth'//上层应用权限验证失败
};
const Router = function (app, link, sevs, cfgs) {
    this.app = app;
    this.link = typeof link === 'string' ? JSON.parse(link) : link;
    this.sevs = typeof sevs === 'string' ? JSON.parse(sevs) : sevs;
    //security start
    this.$heart = cfgs.$heart || (60 * 1000);//心跳检测速度毫秒
    this.$timeout = cfgs.$timeout || (60 * 1000 * HEART_BT);//连接未收到心跳包的最大等待时间毫秒（任意tcp连接，包括http、https、net.socket、websocket）
    this.signckKey = cfgs.signckKey || null;//签名验证密钥
    this.secretKey = cfgs.secretKey || null;//数据加密密钥
    this.maxClient = cfgs.maxClient || 64;//单个ip地址允许的最大连接数
    this.maxLength = cfgs.maxLength || (1024 * 1024);//单个数据包最大长度bytes
    this.bytesRate = cfgs.bytesRate || (16 * 1024 * 1024);//一个心跳周期内的流量限制bytes
    this.packsRate = cfgs.packsRate || 512;//一个心跳周期内的包数量限制
    this.reqsCache = cfgs.reqsCache || 32;//包id的缓冲区大小
    this.blackMill = cfgs.blackMill || (3600 * 1000);//拉黑时长毫秒
    this.whiteList = cfgs.whiteList || ['127.0.0.1'];//白名单ip列表
    this.logHtMore = cfgs.logHtMore || false;//是否在心跳日志中打印更多信息
    //security end
    this.logger = app.getLogger('router', __filename);
    this.handler = {};//自定义路由
    this.sessmap = {};//套接字集合（全部套接字的session集合，任意tcp连接，包括http、https、net.socket、websocket）
    this.clients = {};//客户端集合（绑定过uid的session集合）
    this.channel = {};//客户端分组
    this.bridges = {};//服务端分组
    this.blackip = {};//黑名单地址错误次数
    this.ticker = null;//客户端心跳检测器
    this.looper = null;//服务端心跳检测器
};
Router.prototype.start = function (hander) {
    const self = this;
    if (self.$heart < 1000) throw Error(self.app.name + '-> socket检测间隔最少为1000毫秒');
    if (self.$timeout < 10000) throw Error(self.app.name + '-> socket超时时间最少为10000毫秒');
    if (self.$heart * HEART_BT > self.$timeout) throw Error(self.app.name + '-> 必须满足 $heart * ' + HEART_BT + ' <= $timeout');
    self.handler = hander || self.handler;
    //tcpsocket
    self.app.server.on('connection', function (socket) {
        //创建会话
        const session = new Session(socket, self.app.getIPV4({ip: socket.remoteAddress, headers: {}}));
        //黑名单检测
        if (self.blackip[session.ip] && self.blackip[session.ip].cnt > 0) {
            self.logger.error('reject connection:', session.ip, session.id);
            session.destroy();
        } else {
            self.sessmap[session.id] = session;
            //注册监听器
            socket.on('close', function () {
                delete self.sessmap[session.id];
                self.logger.info('close connection:', session.ip, session.id);
            });
            socket.on('error', function () {
                delete self.sessmap[session.id];
                session.destroy();
                self.logger.error('error connection:', session.ip, session.id);
            });
            self.logger.info('accept connection:', session.ip, session.id);
        }
    });
    //websocket
    self.app.wssapp.on('connection', function (socket, request) {
        //升级会话
        const remoteIp = self.app.getIPV4({ip: request.connection.remoteAddress, headers: request.headers});
        let session = null;
        if (socket._socket && socket._socket.$session$) {
            session = socket._socket.$session$;//ws获取获取底层绑定的$session$
            session.upgrate(socket, remoteIp);//设置websocket升级标志
        } else if (socket._socket && socket._socket._parent && socket._socket._parent.$session$) {
            session = socket._socket._parent.$session$;//wss获取获取底层绑定的$session$
            session.upgrate(socket, remoteIp);//设置websocket升级标志
        } else {
            session = new Session(socket, remoteIp);
            session.upgrate(socket, remoteIp);//设置websocket升级标志
            self.logger.error('未获取到预绑定的会话，可能导致该连接被误判超时！', session.ip, session.id);
        }
        //注册监听器
        socket.on('message', function (buffer) {
            self.onSocketData(session, buffer);
        });
        socket.on('close', function (code, reason) {
            self.onSocketClose(session, code, reason);
        });
        socket.on('error', function (error) {
            self.onSocketError(session, error);
        });
        self.logger.info('upgrade connection:', session.ip, session.id);
    });
    //定时运行心跳检测
    self.ticker = setInterval(function () {
        try {
            self.onServerHeart();
        } catch (e) {
            self.logger.error('未处理的心跳异常：', e);
        }
    }, self.$heart);
    //连接到其他的服务器进程
    self.bridgesInit();
    self.logger.info('router startup success.');
};
Router.prototype.destroy = function () {
    const self = this;
    if (self.ticker) {
        clearInterval(self.ticker);
        self.ticker = null;
    }
    if (self.looper) {
        clearInterval(self.looper);
        self.looper = null;
    }
    self.logger.info('router destroy success.');
};
/**
 * 数据加密解密模块
 */
Router.prototype.encriptData = function (org_str) {
    const self = this;
    if (self.signckKey && self.secretKey) {
        try {
            const body = CryptoJS.AES.encrypt(org_str, self.secretKey).toString();//先讲原始字符串进行加密
            const sign_dt = self.signckKey + body + self.signckKey;//与密钥拼接生成待签名字符串
            const sign = CryptoJS.MD5(sign_dt).toString();//得到签名
            const split_l = Math.floor(sign.length / 2);//得到签名分割长度
            const enc_str = split_l + '|' + sign.substring(0, split_l) + body + sign.substring(split_l);//拼接签名后得到加密字符串
            return enc_str;
        } catch (e) {
            return null;
        }
    } else {
        return org_str;
    }
};
Router.prototype.decriptData = function (enc_str) {
    const self = this;
    if (self.signckKey && self.secretKey) {
        try {
            const split_i = enc_str.indexOf('|');//计算签名长度索引
            const split_l = Number(enc_str.substring(0, split_i));//计算签名分割长度
            const sign = enc_str.substring(split_i + 1, split_i + 1 + split_l) + enc_str.substring(enc_str.length - split_l);//得到数据中的签名字符串
            const body = enc_str.substring(split_i + 1 + split_l, enc_str.length - split_l);//得到base64编码的原始字符串
            const sign_dt = self.signckKey + body + self.signckKey;//与密钥拼接生成待签名字符串
            if (CryptoJS.MD5(sign_dt).toString() !== sign) return null;//进行签名验证
            const dec_str = CryptoJS.AES.decrypt(body, self.secretKey).toString(CryptoJS.enc.Utf8);//得到解密后的原始字符串
            return dec_str;
        } catch (e) {
            return null;
        }
    } else {
        return enc_str;
    }
};
Router.prototype.add2BlackIp = function (session, errtype, error) {
    const self = this;
    if (self.whiteList.indexOf(session.ip) >= 0) return;//白名单的不拉黑
    if (!self.blackip[session.ip]) self.blackip[session.ip] = {type: errtype, cnt: 0, end: Date.now() + self.blackMill, err: error ? error.name || error : null};
    switch (errtype) {
        case ERR_TYPE.TYPE://数据包类型不对
        case ERR_TYPE.SIZE://数据包尺寸过大
        case ERR_TYPE.SIGN://数据包验签失败
        case ERR_TYPE.JSON://数据包不是json格式
        case ERR_TYPE.PACK://数据包不是pack格式
        case ERR_TYPE.FLOW://数据包流量、频率、ID验证失败
        case ERR_TYPE.DENY://数据包访问私有路由
        case ERR_TYPE.NONE://数据包访问不存在的路由
            self.blackip[session.ip].cnt++;
            break;
        case ERR_TYPE.SOCK://套接字错误
            if (error && error.name === 'RangeError' && error.message.toLowerCase().indexOf('payload') >= 0) self.blackip[session.ip].cnt++;
            break;
        case ERR_TYPE.TIME://一个心跳周期内未收到任何心跳包
            // self.blackip[session.ip].cnt++;//不拉黑，容易误封
            break;
        case ERR_TYPE.MAXC://同一个ip的连接数过多
        case ERR_TYPE.AUTH://上层应用权限验证失败
            self.blackip[session.ip].cnt++;
            break;
    }
    if (self.blackip[session.ip].cnt > 0) {
        self.logger.error('add2BlackIp:', errtype, session.ip, session.id, session.uid, '$watch->', session.$watch, 'blackip->', self.blackip);
    } else {
        delete self.blackip[session.ip];//不满足拉黑条件，删除此项
    }
};
Router.prototype.del2BlackIp = function () {
    const self = this;
    const current = Date.now();
    const passKey = [];
    for (let key in self.blackip) {
        if (self.blackip[key].cnt <= 0 || self.blackip[key].end < current) passKey.push(key);//封禁时间已到，移出黑名单
    }
    for (let i = 0; i < passKey.length; i++) {
        delete self.blackip[passKey[i]];
    }
};
/**
 * 单进程中通讯功能
 */
Router.prototype.onSocketData = function (session, org_str) {
    const self = this;
    //验证数据类型是否为字符串
    if (typeof org_str !== 'string') {
        self.logger.error('onSocketData:', ERR_TYPE.TYPE, session.ip, session.id, session.uid, typeof org_str);
        self.pushData(session, NOSYNTAX, {code: 400, data: 'Bad Request'});
        self.forceClose(session, ERR_TYPE.TYPE);//强制清除会话
        return;
    }
    //验证数据长度是否<=最大值
    if (org_str.length > self.maxLength) {
        self.logger.error('onSocketData:', ERR_TYPE.SIZE, session.ip, session.id, session.uid, org_str.length);
        self.pushData(session, NOSYNTAX, {code: 400, data: 'Bad Request'});
        self.forceClose(session, ERR_TYPE.SIZE);//强制清除会话
        return;
    }
    //进行签名验证并得到解密后的json数据
    const json = self.decriptData(org_str);
    if (!json) {
        self.logger.error('onSocketData:', ERR_TYPE.SIGN, session.ip, session.id, session.uid, org_str.length, 'bytes ->', org_str);
        self.pushData(session, NOSYNTAX, {code: 400, data: 'Bad Request'});
        self.forceClose(session, ERR_TYPE.SIGN);//强制清除会话
        return;
    }
    //将解密后的json数据解析为object
    let pack = null;
    try {
        pack = JSON.parse(json);
    } catch (e) {
        self.logger.error('onSocketData:', ERR_TYPE.JSON, session.ip, session.id, session.uid, json.length, 'bytes ->', json);
        self.pushData(session, NOSYNTAX, {code: 400, data: 'Bad Request'});
        self.forceClose(session, ERR_TYPE.JSON);//强制清除会话
        return;
    }
    //空包或缺少参数
    if (!pack || typeof pack.route !== 'string' || typeof pack.reqId !== 'number') {
        self.logger.error('onSocketData:', ERR_TYPE.PACK, session.ip, session.id, session.uid, json.length, 'bytes ->', json);
        self.pushData(session, NOSYNTAX, {code: 400, data: 'Bad Request'});
        self.forceClose(session, ERR_TYPE.PACK);//强制清除会话
        return;
    }
    //流量监控与重复包验证
    let flowState = session.updateByPack(json.length, pack.reqId, self.bytesRate, self.packsRate, self.reqsCache);
    if (flowState) {
        self.logger.error('onSocketData:', ERR_TYPE.FLOW, flowState, session.ip, session.id, session.uid, json.length, 'bytes ->', json);
        self.response(session, pack, {code: 400, data: 'Bad Request'});
        self.forceClose(session, ERR_TYPE.FLOW, flowState);//强制清除会话
        return;
    }
    //验证是否为私有函数路由
    if (pack.route.indexOf('$_') === 0) {
        self.logger.error('onSocketData:', ERR_TYPE.DENY, session.ip, session.id, session.uid, json.length, 'bytes ->', json);
        self.response(session, pack, {code: 405, data: 'Method Not Allowed'});
        self.forceClose(session, ERR_TYPE.DENY);//强制清除会话
        return;
    }
    //----------------正常的包开始----------------
    //收到心跳包
    if (pack.route === HEARTICK) {
        self.logger.trace('onSocketData:', session.ip, session.id, session.uid, json.length, 'bytes ->', json);
        session.updateByTick();//更新本次心跳时间戳
        self.pushData(session, HEARTICK, pack.message);
        return;
    }
    //转发到路由对象的对应函数
    if (self.handler[pack.route]) {
        self.logger.debug('onSocketData:', session.ip, session.id, session.uid, json.length, 'bytes ->', json);
        self.handler[pack.route](session, pack);
        return;
    }
    //跨进程P2P包
    if (pack.route === INNERP2P) {
        self.logger.debug('onSocketData:', session.ip, session.id, session.uid, json.length, 'bytes ->', json);
        if (self.clients[pack.$uid$]) self.pushData(self.clients[pack.$uid$], pack.$route$, pack.message);
        return;
    }
    //跨进程GRP包
    if (pack.route === INNERGRP) {
        self.logger.debug('onSocketData:', session.ip, session.id, session.uid, json.length, 'bytes ->', json);
        self.pushChannel(pack.$gid$, pack.$route$, pack.message);
        return;
    }
    //跨进程ALL包
    if (pack.route === INNERALL) {
        self.logger.debug('onSocketData:', session.ip, session.id, session.uid, json.length, 'bytes ->', json);
        self.broadcast(pack.$route$, pack.message);
        return;
    }
    //跨进程调用包
    if (pack.route === INNERRMC) {
        self.logger.debug('onSocketData:', session.ip, session.id, session.uid, json.length, 'bytes ->', json);
        self.handler[pack.$route$](session, pack);
        return;
    }
    //----------------正常的包结束----------------
    //无对应路由
    self.logger.error('onSocketData:', ERR_TYPE.NONE, session.ip, session.id, session.uid, json.length, 'bytes ->', json);
    self.response(session, pack, {code: 501, data: 'Not Implemented'});
    self.forceClose(session, ERR_TYPE.NONE);//强制清除会话
};
Router.prototype.onSocketClose = function (session, code, reason) {
    const self = this;
    if (self.handler.$_onSocketClose) {
        self.handler.$_onSocketClose(session, code, reason);
    }
    delete self.sessmap[session.id];//从套接字集合移除
    delete self.clients[session.uid];//从客户端集合移除
    session.eachChannel(function (gid) {
        self.quitChannel(session, gid);//退出已加入的所有分组
    });
    self.logger.info('onSocketClose:', session.ip, session.id, session.uid, code, reason);
};
Router.prototype.onSocketError = function (session, error) {
    const self = this;
    if (self.handler.$_onSocketError) {
        self.handler.$_onSocketError(session, error);
    }
    self.logger.error('onSocketError:', session.ip, session.id, session.uid, error);
    self.forceClose(session, ERR_TYPE.SOCK, error);//强制清除会话
};
Router.prototype.onSocketTimeout = function (session) {
    const self = this;
    if (self.handler.$_onSocketTimeout) {
        self.handler.$_onSocketTimeout(session, self.$timeout);
    }
    self.logger.warn('onSocketTimeout:', session.ip, session.id, session.uid);
    self.forceClose(session, ERR_TYPE.TIME);//强制清除会话
};
Router.prototype.onServerHeart = function () {
    const self = this;
    if (self.handler.$_onServerHeart) {
        self.handler.$_onServerHeart(self.$heart, self.$timeout);
    }
    //关闭全部的超时未收到心跳包的连接
    let totalCnt = 0;
    let wssupCnt = 0;
    let ipClient = {};
    for (let key in self.sessmap) {
        const session = self.sessmap[key];
        if (session.isExpired(self.$timeout)) {
            self.onSocketTimeout(session);//清除超时未收到心跳包的连接（任意tcp连接，包括http、https、net.socket、websocket）
        } else {
            totalCnt++;//总连接数量
            if (session.isWssuped()) {
                wssupCnt++;//总websocket连接数量
                session.clearBytePack();//新周期清空websocket流量统计
            }
            //统计每个ip的连接数量
            ipClient[session.ip] = ipClient[session.ip] || [];
            ipClient[session.ip].push(session);
        }
    }
    //控制最大连接数
    for (let ip in ipClient) {
        const clients = ipClient[ip];
        if (clients.length > self.maxClient) {
            self.logger.error('onServerHeart:', ERR_TYPE.MAXC, ip, 'client count->', clients.length);
            for (let i = 0; i < clients.length; i++) {
                self.forceClose(clients[i], ERR_TYPE.MAXC);//强制关闭该ip的全部连接
            }
        }
    }
    self.del2BlackIp();
    self.logger.info('onServerHeart:', 'totalCnt->', totalCnt, 'wssupCnt->', wssupCnt, 'blackip->', self.blackip);
    //打印分支和连接情况
    if (self.logHtMore) {
        const channelIds = [];
        const loginedIds = [];
        for (let key in self.channel) channelIds.push(key);
        for (let key in self.clients) loginedIds.push(key);
        self.logger.info('onServerHeart:', 'channelIds->', channelIds, 'loginedIds->', loginedIds);
    }
};
Router.prototype.onUnauthorized = function (session, pack) {
    const self = this;
    self.logger.error('onUnauthorized:', session.ip, session.id, session.uid, 'pack ->', JSON.stringify(pack));
    self.forceClose(session, ERR_TYPE.AUTH);//强制清除会话
};
Router.prototype.forceClose = function (session, errtype, error) {
    const self = this;
    delete self.sessmap[session.id];//从套接字集合移除
    delete self.clients[session.uid];//从客户端列表移除
    session.eachChannel(function (gid) {
        self.quitChannel(session, gid);//退出已加入的所有分组
    });
    session.destroy();//强制关闭连接
    self.add2BlackIp(session, errtype, error);//尝试拉入黑名单
};
Router.prototype.response = function (session, pack, message) {
    const self = this;
    const json = JSON.stringify({
        route: RESPONSE,
        reqId: pack.reqId,
        message: message
    });
    const data = self.encriptData(json);
    session.send(WebSocket.OPEN, data);
    self.logger.debug('response:', session.ip, session.id, session.uid, json.length, 'bytes ->', json);
};
Router.prototype.pushData = function (session, route, message) {
    const self = this;
    const json = JSON.stringify({
        route: route,
        message: message
    });
    const data = self.encriptData(json);
    session.send(WebSocket.OPEN, data);
    if (route === HEARTICK) {
        self.logger.trace('pushData:', session.ip, session.id, session.uid, json.length, 'bytes ->', json);
    } else {
        self.logger.debug('pushData:', session.ip, session.id, session.uid, json.length, 'bytes ->', json);
    }
};
Router.prototype.bindUid = function (session, uid) {
    const self = this;
    session.bindUid(uid);
    self.clients[uid] = session;
};
Router.prototype.joinChannel = function (session, gid) {
    const self = this;
    const group = self.channel[gid] || {count: 0, clients: {}};
    if (!group.clients[session.id]) {
        group.clients[session.id] = session;
        group.count++;
        session.joinChannel(gid);
    }
    self.channel[gid] = group;
    self.logger.debug('joinChannel:', gid, session.ip, session.id, session.uid);
    self.logger.trace('joinChannel', self.channel, session.channel);
};
Router.prototype.quitChannel = function (session, gid) {
    const self = this;
    const group = self.channel[gid] || {count: 0, clients: {}};
    if (group.clients[session.id]) {
        delete group.clients[session.id];
        group.count--;
        session.quitChannel(gid);
    }
    if (group.count > 0) {
        self.channel[gid] = group;
    } else {
        delete self.channel[gid];
    }
    self.logger.debug('quitChannel:', gid, session.ip, session.id, session.uid);
    self.logger.trace('quitChannel', self.channel, session.channel);
};
Router.prototype.deleteChannel = function (gid) {
    const self = this;
    const group = self.channel[gid] || {count: 0, clients: {}};
    const clients_channels = {};
    for (let key in group.clients) {
        let session = group.clients[key];
        session.quitChannel(gid);
        clients_channels[key] = session.channel;
    }
    delete self.channel[gid];
    self.logger.debug('deleteChannel:', gid);
    self.logger.trace('deleteChannel', self.channel, clients_channels);
};
Router.prototype.pushChannel = function (gid, route, message) {
    const self = this;
    const group = self.channel[gid] || {count: 0, clients: {}};
    const json = JSON.stringify({
        route: route,
        message: message
    });
    const data = self.encriptData(json);
    for (let key in group.clients) {
        group.clients[key].send(WebSocket.OPEN, data);
    }
    self.logger.debug('pushChannel:', gid, json.length, 'byte ->', json);
};
Router.prototype.pushChannelSafe = function (gid, route, message, safecb, context) {
    const self = this;
    const group = self.channel[gid] || {count: 0, clients: {}};
    for (let key in group.clients) {
        const session = group.clients[key];
        const json = JSON.stringify({
            route: route,
            message: safecb.call(context || self, session.uid, message)
        });
        const data = self.encriptData(json);
        session.send(WebSocket.OPEN, data);
        self.logger.debug('pushChannelSafe:', gid, session.uid, json.length, 'byte ->', json);
    }
};
Router.prototype.broadcast = function (route, message) {
    const self = this;
    const json = JSON.stringify({
        route: route,
        message: message
    });
    const data = self.encriptData(json);
    let total = 0;
    let count = 0;
    for (let key in self.clients) {
        total++;
        if (self.clients[key].send(WebSocket.OPEN, data)) count++;
    }
    self.logger.debug('broadcast:' + count + '/' + total, json.length, 'bytes ->', json);
};
/**
 * 多进程间通讯功能
 */
Router.prototype.bridgesInit = function () {
    const self = this;
    //生成连接信息
    for (let i = 0; i < self.link.length; i++) {
        const group = self.link[i];
        const addrs = self.sevs[group];
        self.bridges[group] = [];
        for (let k = 0; k < addrs.length; k++) {
            self.bridges[group].push({
                name: group,
                host: addrs[k].inip || addrs[k].host,
                port: addrs[k].port,
                prot: addrs[k].ssls ? 'wss' : 'ws',
                socket: null,//该连接的引用
                counts: 0,//断线重连次数
                reqinc: 0,//请求ID自增量
            });
        }
    }
    self.logger.trace('bridgesInit:', self.bridges);
    //创建连接任务
    for (let key in self.bridges) {
        const group = self.bridges[key];
        for (let i = 0; i < group.length; i++) {
            self.bridgesConnect(group[i]);
        }
    }
    //启动连接心跳
    self.looper = setInterval(function () {
        const time = Date.now();
        for (let key in self.bridges) {
            const group = self.bridges[key];
            for (let i = 0; i < group.length; i++) {
                self.bridgesPushData(group[i], HEARTICK, time);
            }
        }
    }, Math.floor(self.$timeout / HEART_BT));
};
Router.prototype.bridgesConnect = function (bridge) {
    const self = this;
    //{rejectUnauthorized:false}解决用内网连接时证书altnames不匹配的问题
    const socket = new WebSocket(bridge.prot + '://' + bridge.host + ':' + bridge.port + '/', void 0, {rejectUnauthorized: false});
    socket.on('error', function (error) {
        if (bridge.counts > 0) self.logger.warn(error.syscall, error.code);
        bridge.socket = null;
        socket.terminate();//强制关闭连接
        self.bridgesConnect(bridge);
    });
    socket.on('open', function () {
        bridge.socket = socket;
        bridge.counts++;
        self.logger.info('内部连接:', bridge.name, bridge.host + ':' + bridge.port, '已经建立,次数:', bridge.counts);
        socket.on('close', function (code, reason) {
            bridge.socket = null;
            self.bridgesConnect(bridge);
        });
        socket.on('message', function (org_str) {
            const json = self.decriptData(org_str);
            self.logger.trace('bridgesOnData:', json.length, 'bytes ->', json);
        });
        self.bridgesPushData(bridge, HEARTICK, Date.now());//立即发送一次心跳包
    });
};
Router.prototype.bridgesPushData = function (bridge, route, message) {
    const self = this;
    const json = JSON.stringify({
        route: route,
        reqId: bridge.reqinc++,
        message: message
    });
    if (bridge.socket && bridge.socket.readyState === WebSocket.OPEN) {
        bridge.socket.send(self.encriptData(json));
    }
    if (route === HEARTICK) {
        self.logger.trace('bridgesPushData:', bridge.name, bridge.host + ':' + bridge.port, json.length, 'bytes ->', json);
    } else {
        self.logger.debug('bridgesPushData:', bridge.name, bridge.host + ':' + bridge.port, json.length, 'bytes ->', json);
    }
};
Router.prototype.bridgesPushP2P = function (name, uid, route, message, handFunc, handThis) {
    const self = this;
    const group = self.bridges[name];
    if (handFunc) {
        const bridge = group[handFunc.call(handThis || this, group, uid, message)];
        if (bridge.socket && bridge.socket.readyState === WebSocket.OPEN) {
            const json = JSON.stringify({
                route: INNERP2P,
                reqId: bridge.reqinc++,
                $uid$: uid,
                $route$: route,
                message: message
            });
            bridge.socket.send(self.encriptData(json));
            self.logger.debug('bridgesPushP2P:', name, bridge.host + ':' + bridge.port, uid, json.length, 'bytes ->', json);
        }
    } else {
        for (let i = 0; i < group.length; i++) {
            const bridge = group[i];
            if (bridge.socket && bridge.socket.readyState === WebSocket.OPEN) {
                const json = JSON.stringify({
                    route: INNERP2P,
                    reqId: bridge.reqinc++,
                    $uid$: uid,
                    $route$: route,
                    message: message
                });
                bridge.socket.send(self.encriptData(json));
                self.logger.debug('bridgesPushP2P:', name, bridge.host + ':' + bridge.port, uid, json.length, 'bytes ->', json);
            }
        }
    }
};
Router.prototype.bridgesPushGrp = function (name, gid, route, message, handFunc, handThis) {
    const self = this;
    const group = self.bridges[name];
    if (handFunc) {
        const bridge = group[handFunc.call(handThis || this, group, gid, message)];
        if (bridge.socket && bridge.socket.readyState === WebSocket.OPEN) {
            const json = JSON.stringify({
                route: INNERGRP,
                reqId: bridge.reqinc++,
                $gid$: gid,
                $route$: route,
                message: message
            });
            bridge.socket.send(self.encriptData(json));
            self.logger.debug('bridgesPushGrp:', name, bridge.host + ':' + bridge.port, gid, json.length, 'bytes ->', json);
        }
    } else {
        for (let i = 0; i < group.length; i++) {
            const bridge = group[i];
            if (bridge.socket && bridge.socket.readyState === WebSocket.OPEN) {
                const json = JSON.stringify({
                    route: INNERGRP,
                    reqId: bridge.reqinc++,
                    $gid$: gid,
                    $route$: route,
                    message: message
                });
                bridge.socket.send(self.encriptData(json));
                self.logger.debug('bridgesPushGrp:', name, bridge.host + ':' + bridge.port, gid, json.length, 'bytes ->', json);
            }
        }
    }
};
Router.prototype.bridgesPushAll = function (name, route, message, handFunc, handThis) {
    const self = this;
    const group = self.bridges[name];
    if (handFunc) {
        const bridge = group[handFunc.call(handThis || this, group, message)];
        if (bridge.socket && bridge.socket.readyState === WebSocket.OPEN) {
            const json = JSON.stringify({
                route: INNERALL,
                reqId: bridge.reqinc++,
                $route$: route,
                message: message
            });
            bridge.socket.send(self.encriptData(json));
            self.logger.debug('bridgesPushAll:', name, bridge.host + ':' + bridge.port, json.length, 'bytes ->', json);
        }
    } else {
        for (let i = 0; i < group.length; i++) {
            const bridge = group[i];
            if (bridge.socket && bridge.socket.readyState === WebSocket.OPEN) {
                const json = JSON.stringify({
                    route: INNERALL,
                    reqId: bridge.reqinc++,
                    $route$: route,
                    message: message
                });
                bridge.socket.send(self.encriptData(json));
                self.logger.debug('bridgesPushAll:', name, bridge.host + ':' + bridge.port, json.length, 'bytes ->', json);
            }
        }
    }
};
Router.prototype.bridgesPushRmc = function (name, route, message, handFunc, handThis) {
    const self = this;
    const group = self.bridges[name];
    if (handFunc) {
        const bridge = group[handFunc.call(handThis || this, group, message)];
        if (bridge.socket && bridge.socket.readyState === WebSocket.OPEN) {
            const json = JSON.stringify({
                route: INNERRMC,
                reqId: bridge.reqinc++,
                $route$: route,
                message: message
            });
            bridge.socket.send(self.encriptData(json));
            self.logger.debug('bridgesPushRmc:', name, bridge.host + ':' + bridge.port, json.length, 'bytes ->', json);
        }
    } else {
        for (let i = 0; i < group.length; i++) {
            const bridge = group[i];
            if (bridge.socket && bridge.socket.readyState === WebSocket.OPEN) {
                const json = JSON.stringify({
                    route: INNERRMC,
                    reqId: bridge.reqinc++,
                    $route$: route,
                    message: message
                });
                bridge.socket.send(self.encriptData(json));
                self.logger.debug('bridgesPushRmc:', name, bridge.host + ':' + bridge.port, json.length, 'bytes ->', json);
            }
        }
    }
};
/**
 * @param app context类实例
 * @param link 本进程需要连接的进程分组
 * @param sevs 工程的全部进程集合
 * @param cfgs 安全配置信息
 * @returns {Router} 类实例
 */
module.exports = function (app, link, sevs, cfgs) {
    return new Router(app, link, sevs, cfgs);
};
