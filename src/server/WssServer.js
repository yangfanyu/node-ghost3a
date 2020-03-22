'use strict';
const uuid = require('uuid/v1');
const WebSocket = require('ws');
const CryptoJS = require('crypto-js');
const https = require('https');
const http = require('http');
const WssSession = require('./WssSession');
const WssClient = require('../client/WssClient').Ghost3a;
/**
 * 对ws封装的类
 * ws相关信息：https://github.com/websockets/ws
 */
class WssServer {
    /**
     * @typedef {{grp:string,url:string,rmc:wssnet.Ghost3a}} ClusterNode
     */
    /**
     * @typedef {{count:number,sessions:Object.<number,WssSession>}} Channel
     */
    /**
     * @typedef {{tid:string|null,route:string,message:*,word:string,sign:*}} InnerData
     */
    /**
     * @callback ServerCyclerListener
     * @param {WssServer} server
     * @param {number} totalSocket
     * @param {number} totalSession
     */
    /**
     * @callback SessionCloseListener
     * @param {WssServer} server
     * @param {WssSession} session
     * @param {number} code
     * @param {string} reason
     */
    /**
     * @callback RouterListener
     * @param {WssServer} server
     * @param {WssSession} session
     * @param {PackData} pack
     */
    /**
     * @callback RemoteListener
     * @param {WssServer} server
     * @param {WssSession} session
     * @param {PackData} pack
     */
    /**
     * @callback PushChannelCustomCallback
     * @param {string} uid
     * @param {*} message
     * @return {*} message - custom message for target uid
     */
    /**
     * @callback ClusterDispatchCallback
     * @param {{ClusterNode}[]} cluster
     * @param {string|null} tid
     * @param {InnerData} innerData
     * @return {number} index - index of target cluster item
     */
    /**
     * @callback CloseCallback
     * @param {Error} error
     */
    /**
     * 私有属性
     * @property {EnvContext} _context
     * @property {{pwd:string|null,binary:boolean,cycle:number,timeout:number,reqIdCache:number}} _config
     * @property {Logger} _logger
     * @property {Object} _wsscfg
     * @property {WebSocket.Server} _wssapp
     * @property {http.Server|https.Server} _server
     * @property {Object.<string,RouterListener>} _routerMap - 路由监听集合
     * @property {Object.<string,RemoteListener>} _remoteMap - 远程监听集合
     * @property {Object.<string,WssSession>} _socketMap - 全部session集合，包括未绑定uid的session。（每个websocket连接对应一个session）
     * @property {Object.<string,WssSession>} _sessionMap - 已绑定uid的session集合
     * @property {Object.<string,Channel>} _channelMap - 自定义消息推送组（如：聊天室、游戏房间等）
     * @property {Object.<string,ClusterNode[]>} _clusterMap - 集群节点分组列表集合
     * @property {number} _totalSocket
     * @property {number} _totalSession
     * @property {number} _cycleTicker
     * @property {ServerCyclerListener} _serverCyclerListener - 心跳循环每次运行时的都会通知这个监听器
     * @property {SessionCloseListener} _sessionCloseListener - session关闭时的监听器，包括未绑定uid的session
     * 构造函数参数
     * @param context {EnvContext} 上下文包装类实例
     * @param category {string} 日志分类
     * @param config {Object} 配置信息
     * @param config.pwd {string} 数据加密密码，null不启用加密
     * @param config.secret {string} 内部推送数据包签名验签密钥
     * @param config.binary {boolean} true使用二进制收发数据，false使用字符串收发数据
     * @param config.cycle {number} 心跳检测周期 ms
     * @param config.timeout {number} 两个心跳包之间的最大间隔时间 ms
     * @param config.reqIdCache {number} 校验重复包的包ID缓存数量 ms
     * @param wsscfg {Object} 库ws配置信息，参考依赖库 https://github.com/websockets/ws
     * @param wsscfg.backlog {number} The maximum length of the queue of pending connections
     * @param wsscfg.clientTracking {boolean} Specifies whether or not to track clients
     * @param wsscfg.handleProtocols {function} A hook to handle protocols
     * @param wsscfg.host {string} The hostname where to bind the server（本类将过滤掉这个参数，请通过context来传入）
     * @param wsscfg.maxPayload {number} The maximum allowed message size
     * @param wsscfg.noServer {boolean} Enable no server mode（本类将过滤掉这个参数）
     * @param wsscfg.path {string} Accept only connections matching this path
     * @param wsscfg.perMessageDeflate {(boolean|Object)} Enable/disable permessage-deflate
     * @param wsscfg.port {number} The port where to bind the server（本类将过滤掉这个参数，请通过context来传入）
     * @param wsscfg.server {http.Server} A pre-created HTTP/S server to use
     * @param wsscfg.verifyClient {function} A hook to reject connections
     */
    constructor(context, category, config = {}, wsscfg = {}) {
        this._context = context;
        this._config = {
            pwd: null,
            secret: null,
            binary: false,
            cycle: 60 * 1000,
            timeout: 60 * 1000 * 3,
            reqIdCache: 32
        };
        Object.assign(this._config, config);//拷贝配置信息
        //绑定log4js实例
        this._logger = context.getLogger(category);
        //处理wsscfg
        if (wsscfg.host) this._logger.warn('ingore wsscfg.host');
        delete wsscfg.host;
        if (wsscfg.port) this._logger.warn('ingore wsscfg.port');
        delete wsscfg.port;
        if (wsscfg.noServer) this._logger.warn('ingore wsscfg.noServer');
        delete wsscfg.noServer;
        this._wsscfg = wsscfg.server ? {} : { server: context.ssls ? https.createServer(context.readSSLKerCert()) : http.createServer() };
        Object.assign(this._wsscfg, wsscfg);//拷贝ws配置信息
        //绑定app和server
        this._wssapp = new WebSocket.Server(this._wsscfg);//创建ws应用实例
        this._server = this._wsscfg.server;//绑定HTTP/S服务器实例
        //其它属性
        this._routerMap = {};
        this._remoteMap = {};
        this._socketMap = {};
        this._sessionMap = {};
        this._channelMap = {};
        this._clusterMap = {};
        this._totalSocket = 0;
        this._totalSession = 0;
        this._cycleTicker = 0;//定时器
        this._serverCyclerListener = null;
        this._sessionCloseListener = null;
    }
    /**
     * 初始化集群
     */
    initClusters() {
        const heartick = Math.floor(this._config.cycle / 1000);
        for (let i = 0; i < this._context.links.length; i++) {
            const appName = this._context.links[i];
            const address = this._context.nodes[appName];
            const cluster = [];
            for (let k = 0; k < address.length; k++) {
                const url = (address[k].ssls ? 'wss://' : 'ws://') + (address[k].inip || address[k].host) + ':' + address[k].port;
                cluster.push({
                    grp: appName,//节点分组
                    url: url,//连接地址
                    rmc: new WssClient(url, this._config.pwd, this._config.binary, 8000, heartick, 2),//远程客户端
                });
            }
            if (cluster.length > 0) {
                this._clusterMap[appName] = cluster;
            }
        }
    }
    /**
     * 设置周期监听器
     * @param serverCyclerListener {ServerCyclerListener}
     * @param sessionCloseListener {SessionCloseListener}
     */
    setListeners(serverCyclerListener, sessionCloseListener) {
        this._serverCyclerListener = serverCyclerListener;
        this._sessionCloseListener = sessionCloseListener;
    }
    /**
     * 设置路由监听器
     * @param route {string}
     * @param listener {RouterListener}
     */
    setRouter(route, listener) {
        this._routerMap[route] = listener;
    }
    /**
     * 设置远程监听器
     * @param route {string}
     * @param listener {RemoteListener}
     */
    setRemote(route, listener) {
        this._remoteMap[route] = listener;
    }
    /**
     * 绑定uid到session
     * @param session {WssSession}
     * @param uid {string}
     * @param closeOld {boolean}
     */
    bindUid(session, uid, closeOld = false) {
        this.unbindUid(session);//先解绑旧的uid
        if (this._sessionMap[uid]) {
            this.unbindUid(this._sessionMap[uid]);//再解绑旧的session
            if (closeOld) {
                this._sessionMap[uid].close(PackData.CODE_NEWBIND.code, PackData.CODE_NEWBIND.data);//关闭旧的session
            }
        }
        session.bindUid(uid);
        this._sessionMap[uid] = session;//绑定到_sessionMap
        this._logger.debug('bindUid:', session.ip, session.id, session.uid);
    };
    /**
     * 解绑session的uid
     * @param session {WssSession}
     */
    unbindUid(session) {
        if (!session.isBinded()) return;
        this._logger.debug('unbindUid:', session.ip, session.id, session.uid);
        delete this._sessionMap[session.uid];//从_sessionMap中移除
        session.unbindUid();
    }
    /**
     * 根据uid从本节点获取session
     * @param uid {string}
     * @returns {WssSession}
     */
    getSession(uid) {
        return this._sessionMap[uid];
    }
    /**
     * 加入本节点的某个消息推送组
     * @param session {WssSession}
     * @param gid {string}
     */
    joinChannel(session, gid) {
        const channel = this._channelMap[gid] || { count: 0, sessions: {} };
        if (!channel.sessions[session.id]) {
            channel.sessions[session.id] = session;
            channel.count++;
            session.joinChannel(gid);
        }
        this._channelMap[gid] = channel;
        this._logger.debug('joinChannel:', session.ip, session.id, session.uid, gid);
    }
    /**
     * 退出本节点的某个消息推送组
     * @param session {WssSession}
     * @param gid {string}
     */
    quitChannel(session, gid) {
        const channel = this._channelMap[gid];
        if (!channel) return;
        if (channel.sessions[session.id]) {
            delete channel.sessions[session.id];
            channel.count--;
            session.quitChannel(gid);
        }
        if (channel.count <= 0) delete this._channelMap[gid];
        this._logger.debug('quitChannel:', session.ip, session.id, session.uid, gid);
    }
    /**
     * 删除本节点的某个消息推送组
     * @param gid {string}
     */
    deleteChannel(gid) {
        const channel = this._channelMap[gid];
        if (!channel) return;
        for (let id in channel.sessions) {
            if (channel.sessions.hasOwnProperty(id)) {
                channel.sessions[id].quitChannel(gid);
            }
        }
        delete this._channelMap[gid];
        this._logger.debug('deleteChannel:', gid);
    }
    /**
     * 响应本节点的某个session的请求
     * @param session {WssSession}
     * @param reqPack {PackData}
     * @param message {*}
     */
    response(session, reqPack, message) {
        const pack = new PackData(PackData.ROUTE_RESPONSE, reqPack.reqId, message);
        const data = PackData.serialize(pack, this._config.pwd, this._config.binary);
        session.send(data, this._getSendOptions());
        this._logger.debug('response:', session.ip, session.id, session.uid, pack);
    }
    /**
     * 推送消息到本节点的某个session
     * @param uid {string}
     * @param route {string}
     * @param message  {*}
     */
    pushSession(uid, route, message) {
        let session = this._sessionMap[uid];
        if (!session) return;
        const pack = new PackData(route, undefined, message);
        const data = PackData.serialize(pack, this._config.pwd, this._config.binary);
        session.send(data, this._getSendOptions());
        this._logger.debug('pushSession:', session.ip, session.id, session.uid, pack);
    }
    /**
     * 推送消息到本节点的某批session
     * @param uids {string[]}
     * @param route {string}
     * @param message  {*}
     */
    pushSessionBatch(uids, route, message) {
        const pack = new PackData(route, undefined, message);
        const data = PackData.serialize(pack, this._config.pwd, this._config.binary);
        for (let i = 0; i < uids.length; i++) {
            const session = this._sessionMap[uids[i]];
            if (session) {
                session.send(data, this._getSendOptions());
            }
        }
        this._logger.debug('pushSessionBatch:', uids, pack);
    }
    /**
     * 推送消息到本节点的某个消息推送组
     * @param gid {string}
     * @param route {string}
     * @param message {*}
     */
    pushChannel(gid, route, message) {
        const channel = this._channelMap[gid];
        if (!channel) return;
        const pack = new PackData(route, undefined, message);
        const data = PackData.serialize(pack, this._config.pwd, this._config.binary);
        for (let id in channel.sessions) {
            if (channel.sessions.hasOwnProperty(id)) {
                const session = channel.sessions[id];
                session.send(data, this._getSendOptions());
            }
        }
        this._logger.debug('pushChannel:', gid, pack);
    }
    /**
     * 推送消息到本节点的某个消息推送组，每个成员的数据都进过差异处理
     * @param gid {string}
     * @param route {string}
     * @param message {*}
     * @param customCallback {PushChannelCustomCallback}
     */
    pushChannelCustom(gid, route, message, customCallback) {
        const channel = this._channelMap[gid];
        if (!channel) return;
        for (let id in channel.sessions) {
            if (channel.sessions.hasOwnProperty(id)) {
                const session = channel.sessions[id];
                const pack = new PackData(route, undefined, customCallback(session.uid, message));
                const data = PackData.serialize(pack, this._config.pwd, this._config.binary);
                session.send(data, this._getSendOptions());
                this._logger.debug('pushChannelCustom:', session.ip, session.id, session.uid, gid, pack);
            }
        }
    }
    /**
     * 推送消息到本节点的已经绑定过uid的全部session
     * @param route {string}
     * @param message {*}
     */
    broadcast(route, message) {
        const pack = new PackData(route, undefined, message);
        const data = PackData.serialize(pack, this._config.pwd, this._config.binary);
        for (let uid in this._sessionMap) {
            if (this._sessionMap.hasOwnProperty(uid)) {
                const session = this._sessionMap[uid];
                session.send(data, this._getSendOptions());
            }
        }
        this._logger.debug('broadcast:', pack);
    }
    /**
     * 推送消息到某个节点的某个session，建议通过dispatchCallback来优化推送性能
     * @param appName {string} 节点分组名
     * @param uid {string}
     * @param route {string}
     * @param message {*}
     * @param dispatchCallback {ClusterDispatchCallback} 分配节点，如果未指定该函数，则从该节点分组的全部节点中搜索对应uid的session
     */
    pushClusterSession(appName, uid, route, message, dispatchCallback = undefined) {
        const cluster = this._clusterMap[appName];
        const innerData = this._generateInnerData(uid, route, message);
        if (dispatchCallback) {
            const handle = cluster[dispatchCallback(cluster, uid, innerData)];
            handle.rmc.request(PackData.ROUTE_INNERP2P, innerData);
            this._logger.debug('pushClusterSession:', appName, handle.url, innerData);
        } else {
            for (let i = 0; i < cluster.length; i++) {
                const handle = cluster[i];
                handle.rmc.request(PackData.ROUTE_INNERP2P, innerData);
                this._logger.debug('pushClusterSession:', appName, handle.url, innerData);
            }
        }
    }
    /**
     * 推送消息到某个节点的某个消息推送组，建议通过dispatchCallback来优化推送性能
     * @param appName {string} 节点分组名
     * @param gid {string}
     * @param route {string}
     * @param message {*}
     * @param dispatchCallback {ClusterDispatchCallback} 分配节点，如果未指定该函数，则从该节点分组的全部节点中搜索对应gid的channel
     */
    pushClusterChannel(appName, gid, route, message, dispatchCallback = undefined) {
        const cluster = this._clusterMap[appName];
        const innerData = this._generateInnerData(gid, route, message);
        if (dispatchCallback) {
            const handle = cluster[dispatchCallback(cluster, gid, innerData)];
            handle.rmc.request(PackData.ROUTE_INNERGRP, innerData);
            this._logger.debug('pushClusterChannel:', appName, handle.url, innerData);
        } else {
            for (let i = 0; i < cluster.length; i++) {
                const handle = cluster[i];
                handle.rmc.request(PackData.ROUTE_INNERGRP, innerData);
                this._logger.debug('pushClusterChannel:', appName, handle.url, innerData);
            }
        }
    }
    /**
     * 推送消息到某个节点的已经绑定过uid的全部session
     * @param appName {string} 节点分组名
     * @param route {string}
     * @param message {*}
     * @param dispatchCallback {ClusterDispatchCallback} 分配节点，如果未指定该函数，将推送到该节点分组的全部节点
     */
    clusterBroadcast(appName, route, message, dispatchCallback = undefined) {
        const cluster = this._clusterMap[appName];
        const innerData = this._generateInnerData(null, route, message);
        if (dispatchCallback) {
            const handle = cluster[dispatchCallback(cluster, null, innerData)];
            handle.rmc.request(PackData.ROUTE_INNERALL, innerData);
            this._logger.debug('clusterBroadcast:', appName, handle.url, innerData);
        } else {
            for (let i = 0; i < cluster.length; i++) {
                const handle = cluster[i];
                handle.rmc.request(PackData.ROUTE_INNERALL, innerData);
                this._logger.debug('clusterBroadcast:', appName, handle.url, innerData);
            }
        }
    }
    /**
     * 节点间远程路由异步调用
     * @param appName {string} 节点分组名
     * @param route {string}
     * @param message {*}
     * @param dispatchCallback {ClusterDispatchCallback} 分配节点，如果未指定该函数，则从该节点分组的全部节点中随机选择一个节点
     */
    callRemote(appName, route, message, dispatchCallback = undefined) {
        const cluster = this._clusterMap[appName];
        const innerData = this._generateInnerData(null, route, message);
        const index = dispatchCallback ? dispatchCallback(cluster, null, innerData) : Math.min(Math.floor(Math.random() * cluster.length), cluster.length - 1);
        const handle = cluster[index];
        this._logger.debug('callRemote:', appName, handle.url, innerData);
        handle.rmc.request(PackData.ROUTE_INNERRMC, innerData);
    }
    /**
     * 节点间远程路由异步调用，并返回结果
     * @param appName {string} 节点分组名
     * @param route {string}
     * @param message {*}
     * @param dispatchCallback {ClusterDispatchCallback} 分配节点，如果未指定该函数，则从该节点分组的全部节点中随机选择一个节点
     * @return {Promise<{code:number,data:*}>}
     */
    callRemoteForResult(appName, route, message, dispatchCallback = undefined) {
        const cluster = this._clusterMap[appName];
        const msgdata = this._generateInnerData(null, route, message);
        const index = dispatchCallback ? dispatchCallback(cluster, null, msgdata) : Math.min(Math.floor(Math.random() * cluster.length), cluster.length - 1);
        const handle = cluster[index];
        this._logger.debug('callRemoteForResult:', appName, handle.url, msgdata);
        return new Promise((resolve) => {
            handle.rmc.request(PackData.ROUTE_INNERRMC, msgdata, (resp, params) => {
                resolve(resp);
            }, (resp, params) => {
                resolve(resp);
            }, this);
        });
    }
    /**
     * 开启服务器
     * @param callback {function} 服务器启动后的回调函数
     */
    start(callback = undefined) {
        //参数检测
        if (this._config.cycle < 10000) throw Error('cycle >= 10,000ms');
        if (this._config.timeout < 30000) throw Error('timeout >= 30,000ms');
        if (this._config.cycle * 3 > this._config.timeout) throw Error('timeout >= cycle * 3');
        //注册监听
        this._wssapp.on('connection', (socket, request) => {
            this._onWebSocketConnection(socket, request);
        });
        //开启心跳循环
        this._cycleTicker = setInterval(() => {
            try {
                this._onServerLifeCycle();
            } catch (e) {
                this._logger.error('Unhandled life cycle exception：', e);
            }
        }, this._config.cycle);
        //连接关联的集群节点
        for (let appName in this._clusterMap) {
            if (this._clusterMap.hasOwnProperty(appName)) {
                const cluster = this._clusterMap[appName];
                for (let i = 0; i < cluster.length; i++) {
                    this._connectForCluster(cluster[i]);
                }
            }
        }
        //启动服务器
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
        //销毁心跳循环
        if (this._cycleTicker) {
            clearInterval(this._cycleTicker);
            this._cycleTicker = 0;
        }
        //断开关联的集群节点
        for (let appName in this._clusterMap) {
            if (this._clusterMap.hasOwnProperty(appName)) {
                const cluster = this._clusterMap[appName];
                for (let i = 0; i < cluster.length; i++) {
                    cluster[i].rmc.disconnect();
                }
            }
        }
        //关闭服务器
        this._server.close((error) => {
            this._logger.info('ssls', this._context.ssls, this._context.host, this._context.port, 'was closed.');
            if (callback) callback(error);
        });
    }
    /**
     * @private
     */
    _onServerLifeCycle() {
        let totalSocket = 0;
        let totalSession = 0;
        for (let id in this._socketMap) {
            if (this._socketMap.hasOwnProperty(id)) {
                const session = this._socketMap[id];
                if (session.isExpired(this._config.timeout)) {
                    session.close(PackData.CODE_TIMEOUT.code, PackData.CODE_TIMEOUT.data);//清除超时的链接
                } else {
                    totalSocket += 1;
                    totalSession += session.isBinded() ? 1 : 0;
                }
            }
        }
        this._logger.info('_onServerLifeCycle:', 'totalSocket->', totalSocket, 'totalSession->', totalSession);
        //更新连接数量
        this._totalSocket = totalSocket;
        this._totalSession = totalSession;
        //回调上层绑定的监听器
        if (this._serverCyclerListener) {
            this._serverCyclerListener(this, this._totalSocket, this._totalSession);
        }
    }
    /**
     * @param socket {*}
     * @param request {*}
     * @private
     */
    _onWebSocketConnection(socket, request) {
        let session = new WssSession(socket, this._context.getIPV4({ headers: request.headers, ip: request.connection.remoteAddress }));
        this._socketMap[session.id] = session;//绑定到_socketMap
        socket.binaryType = 'arraybuffer';//指定读取格式为arraybuffer
        socket.on('message', (data) => {
            this._onWebSocketMessage(session, data);
        });
        socket.on('close', (code, reason) => {
            this._logger.info('on websocket close:', session.ip, session.id, session.uid, code, reason);
            //回调上层绑定的监听器
            if (this._sessionCloseListener) {
                this._sessionCloseListener(this, session, code, reason);
            }
            //统一进行内存清理操作
            session.eachChannel((gid) => { this.quitChannel(session, gid) });//退出已加入的所有分组
            this.unbindUid(session);//可能已经绑定了uid，需要进行解绑操作
            delete this._socketMap[session.id];//从_socketMap中移除
        });
        socket.on('error', (error) => {
            this._logger.error('on websocket error:', session.ip, session.id, session.uid, error.toString());
            session.close(PackData.CODE_SOCKET.code, PackData.CODE_SOCKET.data + ': ' + error.toString());
        });
        this._logger.info('on websocket connection:', session.ip, session.id);
    }
    /**
     * 收到客户端数据
     * @param session {WssSession}
     * @param data {ArrayBuffer|string}
     * @private
     */
    _onWebSocketMessage(session, data) {
        let pack = PackData.deserialize(data, this._config.pwd);
        //解析包数据
        if (!pack) {
            this._logger.error('_onWebSocketMessage:', session.ip, session.id, session.uid, PackData.CODE_PARSE.code, data);
            session.close(PackData.CODE_PARSE.code, PackData.CODE_PARSE.data);
            return;
        }
        //校验包格式
        if (typeof pack.route !== 'string' || typeof pack.reqId !== 'number' || pack.message === undefined || pack.message === null) {
            this._logger.error('_onWebSocketMessage:', session.ip, session.id, session.uid, PackData.CODE_FORMAT.code, pack);
            session.close(PackData.CODE_FORMAT.code, PackData.CODE_FORMAT.data);
            return;
        }
        //校验重复包
        if (!session.updateReqId(pack.reqId, this._config.reqIdCache)) {
            this._logger.error('_onWebSocketMessage:', session.ip, session.id, session.uid, PackData.CODE_REPEAT.code, pack);
            session.close(PackData.CODE_REPEAT.code, PackData.CODE_REPEAT.data);
            return;
        }
        //收到心跳包
        if (pack.route === PackData.ROUTE_HEARTICK) {
            this._logger.trace('_onWebSocketMessage:', session.ip, session.id, session.uid, pack);
            session.updateHeart();//更新本次心跳时间戳
            this._sendHeartick(session, pack);//按照原样发回客户端
            return;
        }
        //集群P2P包
        if (pack.route === PackData.ROUTE_INNERP2P) {
            if (this._validateInnerData(pack.message)) {
                this._logger.debug('_onWebSocketMessage:', session.ip, session.id, session.uid, pack);
                this.pushSession(pack.message.tid, pack.message.route, pack.message.message);
            } else {
                this._logger.error('_onWebSocketMessage:', session.ip, session.id, session.uid, PackData.CODE_SIGN.code, pack);
                session.close(PackData.CODE_SIGN.code, PackData.CODE_SIGN.data);
            }
            return;
        }
        //集群GRP包
        if (pack.route === PackData.ROUTE_INNERGRP) {
            if (this._validateInnerData(pack.message)) {
                this._logger.debug('_onWebSocketMessage:', session.ip, session.id, session.uid, pack);
                this.pushChannel(pack.message.tid, pack.message.route, pack.message.message);
            } else {
                this._logger.error('_onWebSocketMessage:', session.ip, session.id, session.uid, PackData.CODE_SIGN.code, pack);
                session.close(PackData.CODE_SIGN.code, PackData.CODE_SIGN.data);
            }
            return;
        }
        //集群ALL包
        if (pack.route === PackData.ROUTE_INNERALL) {
            if (this._validateInnerData(pack.message)) {
                this._logger.debug('_onWebSocketMessage:', session.ip, session.id, session.uid, pack);
                this.broadcast(pack.message.route, pack.message.message);
            } else {
                this._logger.error('_onWebSocketMessage:', session.ip, session.id, session.uid, PackData.CODE_SIGN.code, pack);
                session.close(PackData.CODE_SIGN.code, PackData.CODE_SIGN.data);
            }
            return;
        }
        //集群RMC包
        if (pack.route === PackData.ROUTE_INNERRMC) {
            if (this._validateInnerData(pack.message)) {
                if (this._remoteMap[pack.message.route]) {
                    this._logger.debug('_onWebSocketMessage:', session.ip, session.id, session.uid, pack);
                    this._remoteMap[pack.message.route](this, session, new PackData(pack.message.route, pack.reqId, pack.message.message));//调用远程方法
                } else {
                    this._logger.error('_onWebSocketMessage:', session.ip, session.id, session.uid, PackData.CODE_REMOTE.code, pack);
                    session.close(PackData.CODE_REMOTE.code, PackData.CODE_REMOTE.data);
                }
            } else {
                this._logger.error('_onWebSocketMessage:', session.ip, session.id, session.uid, PackData.CODE_SIGN.code, pack);
                session.close(PackData.CODE_SIGN.code, PackData.CODE_SIGN.data);
            }
            return;
        }
        //自定义路由
        if (this._routerMap[pack.route]) {
            this._logger.debug('_onWebSocketMessage:', session.ip, session.id, session.uid, pack);
            this._routerMap[pack.route](this, session, pack);//调用路由方法
            return;
        }
        //没找到路由
        this._logger.error('_onWebSocketMessage:', session.ip, session.id, session.uid, PackData.CODE_ROUTE.code, pack);
        session.close(PackData.CODE_ROUTE.code, PackData.CODE_ROUTE.data);
    }
    /**
     * 返回发送数据到客户端websocket的选项
     * @returns {{binary: boolean}}
     * @private
     */
    _getSendOptions() {
        return { binary: this._config.binary };
    }
    /**
     * 响应心跳包
     * @param session {WssSession}
     * @param reqPack {PackData}
     * @private
     */
    _sendHeartick(session, reqPack) {
        const pack = new PackData(PackData.ROUTE_HEARTICK, reqPack.reqId, reqPack.message);
        const data = PackData.serialize(pack, this._config.pwd, this._config.binary);
        session.send(data, this._getSendOptions());
        this._logger.trace('_sendHeartick:', session.ip, session.id, session.uid, pack);
    }
    /**
     * 连接到集群节点
     * @param node {ClusterNode}
     * @private
     */
    _connectForCluster(node) {
        node.rmc.setLogLevel(WssClient.LOG_LEVEL_NONE);
        node.rmc.connect(() => {
            this._logger.mark('cluster onopen->', node.grp, node.url);
        }, (code, reason, params) => {
            // this._logger.warn('cluster onclose->', code, reason);
        }, (error, params) => {
            // this._logger.error('cluster onerror->', error);
        }, (count, params) => {
            this._logger.debug('cluster onretry->', node.grp, node.url, count, 'times');
        }, null, this);
    }
    /**
     * 生成内部签名数据包
     * @param tid {string|null}
     * @param route {string}
     * @param message {*}
     * @return {InnerData}
     * @private
     */
    _generateInnerData(tid, route, message) {
        const data = {};
        if (tid) data.tid = tid;
        data.route = route;
        data.message = message;
        data.word = uuid();
        data.sign = this._context.getMd5(route + data.word + this._config.secret);
        return data;
    }
    /**
     * 校验内部签名数据包
     * @param data {InnerData}
     * @return {boolean}
     * @private
     */
    _validateInnerData(data) {
        return this._context.getMd5(data.route + data.word + this._config.secret) === data.sign;
    }
    /**
     * 返回Logger实例
     * @return {Logger}
     */
    get logger() { return this._logger; }
}
/**
 * crypto-js相关信息：https://cryptojs.gitbook.io/docs/
 */
class PackData {
    //route
    static ROUTE_HEARTICK = '$heartick$';//心跳包路由
    static ROUTE_RESPONSE = '$response$';//响应请求路由
    static ROUTE_INNERP2P = '$innerP2P$';//集群点对点消息路由
    static ROUTE_INNERGRP = '$innerGRP';//集群分组消息路由
    static ROUTE_INNERALL = '$innerALL$';//集群广播消息路由
    static ROUTE_INNERRMC = '$innerRMC$';//集群远程方法路由
    /**
     * 状态码范围参考： https://tools.ietf.org/html/rfc6455#section-7.4.2
     * 以及：https://github.com/websockets/ws/issues/715
     * @type {{code: number, data: string}}
     */
    static CODE_PARSE = { code: 4001, data: 'parse error' };
    static CODE_FORMAT = { code: 4002, data: 'format error' };
    static CODE_REPEAT = { code: 4003, data: 'repeat error' };
    static CODE_SIGN = { code: 4004, data: 'sign error' };
    static CODE_REMOTE = { code: 4005, data: 'remote error' };
    static CODE_ROUTE = { code: 4006, data: 'route error' };
    static CODE_SOCKET = { code: 4007, data: 'socket error' };
    static CODE_TIMEOUT = { code: 4008, data: 'timeout error' };
    static CODE_NEWBIND = { code: 4009, data: 'newbind error' };
    /**
     * 数据包
     * @param route {string}
     * @param reqId {number}
     * @param message {*}
     */
    constructor(route, reqId, message) {
        this.route = route;
        this.reqId = reqId;
        this.message = message;
    }
    /**
     * 将数据包进行序列化，采用随机生成iv和key的AES加密算法，CBC、Pkcs7
     * @param pack {PackData} 要序列化的数据包
     * @param pwd {string} 加密的密码
     * @param binary {boolean} 是否返回二进制结果，设置了pwd时生效
     * @returns {ArrayBuffer|string}
     */
    static serialize(pack, pwd, binary) {
        try {
            const str = JSON.stringify(pack);
            if (pwd) {
                //ArrayBuffer or base64 string
                const salt = CryptoJS.lib.WordArray.random(16);
                const iv = CryptoJS.lib.WordArray.random(16);
                const key = CryptoJS.HmacSHA256(salt, pwd);
                const body = CryptoJS.AES.encrypt(str, key, {
                    iv: iv,
                    mode: CryptoJS.mode.CBC,
                    padding: CryptoJS.pad.Pkcs7
                }).ciphertext;
                const encRes = CryptoJS.lib.WordArray.create();
                encRes.concat(salt).concat(iv).concat(body);
                return binary ? new Int32Array(encRes.words).buffer : encRes.toString(CryptoJS.enc.Base64);
            } else {
                //json string
                return str;
            }
        } catch (e) {
            return null;
        }
    }
    /**
     * 将收到的数据进行反序列化，采用随机生成iv和key的AES解密算法，CBC、Pkcs7
     * @param data {ArrayBuffer|string} 要解密的数据
     * @param pwd {string} 解密的密码
     * @returns {PackData}
     */
    static deserialize(data, pwd) {
        try {
            if (pwd) {
                //ArrayBuffer or base64 string
                const words = data instanceof ArrayBuffer ? Array.prototype.slice.call(new Int32Array(data)) : CryptoJS.enc.Base64.parse(data).words;
                const salt = CryptoJS.lib.WordArray.create(words.slice(0, 4));
                const iv = CryptoJS.lib.WordArray.create(words.slice(4, 8));
                const key = CryptoJS.HmacSHA256(salt, pwd);
                const body = CryptoJS.lib.WordArray.create(words.slice(8));
                const decRes = CryptoJS.AES.decrypt({ ciphertext: body }, key, {
                    iv: iv,
                    mode: CryptoJS.mode.CBC,
                    padding: CryptoJS.pad.Pkcs7
                }).toString(CryptoJS.enc.Utf8);
                const obj = JSON.parse(decRes);
                return new PackData(obj.route, obj.reqId, obj.message);
            } else {
                //json string
                const obj = data instanceof ArrayBuffer ? {} : JSON.parse(data);
                return new PackData(obj.route, obj.reqId, obj.message);
            }
        } catch (e) {
            return null;
        }
    }
    /**
     * 计算md5
     * @param data {string} 要计算编码的字符串
     * @returns {string}
     */
    static getMd5(data) {
        return CryptoJS.MD5(data).toString();
    }
}
module.exports = WssServer;
