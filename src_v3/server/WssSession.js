'use strict';
const WebSocket = require('ws');

/**
 * ws的WebSocket封装类
 * ws相关信息：https://github.com/websockets/ws
 */
class WssSession {
    static _increment = 1;
    /**
     * 构造函数参数
     * @param socket {WebSocket}
     * @param ip {string}
     */
    constructor(socket, ip) {
        this._id = WssSession._increment++;//自增id
        this._socket = socket;//绑定的套接字
        this._ip = ip;//绑定的IP地址
        this._uid = null;//绑定的用户ID
        this._context = {};//缓存的自定义数据
        this._channel = {};//加入的自定义群组
        this._reqIdList = [];//最近N个请求id（防止被重复ID的包攻击，其它类型的攻击请使用第三方安全模块）
        this._lastHeart = Date.now();//初始化最近收到心跳包的时间为创建时间
    }
    /**
     * 使用WebSocket发送数据
     * @param data {*} data The message to send
     * @param options {object} options Options object
     * @param options.compress {boolean} Specifies whether or not to compress `data`
     * @param options.binary {boolean} Specifies whether `data` is binary or text
     * @param options.fin {boolean} Specifies whether the fragment is the last one
     * @param options.mask {boolean} Specifies whether or not to mask `data`
     * @param cb {function} cb Callback which is executed when data is written out
     * @returns {boolean}
     */
    send(data, options = undefined, cb = undefined) {
        if (this._socket && this._socket.readyState === WebSocket.OPEN) {
            this._socket.send(data, options, cb);
            return true;
        } else {
            return false;
        }
    }
    /**
     * 关闭WebSocket
     * 本框架保留状态码:
     * 4001-4100 服务端保留状态码范围
     * 4101-4200 客户端保留状态码范围
     * 4201-4999 可自定义的状态码范围
     * 更多状态码资料参考： https://tools.ietf.org/html/rfc6455#section-7.4.2 和 https://github.com/websockets/ws/issues/715
     * @param code {number}
     * @param reason {string}
     */
    close(code, reason) {
        if (this._socket) {
            this._socket.close(code, reason);
            this._socket = null;
        }
    }
    /**
     * 绑定用户ID
     * @param uid {string}
     */
    bindUid(uid) {
        this._uid = uid;
    }
    /**
     * 解绑用户ID
     */
    unbindUid() {
        this._uid = null;
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
     * 加入指定推送组
     * @param gid {string}
     */
    joinChannel(gid) {
        this._channel[gid] = true;
    }
    /**
     * 退出指定推送组
     * @param gid {string}
     */
    quitChannel(gid) {
        delete this._channel[gid];
    }
    /**
     * 遍历已加入的全部推送组
     * @param callback {function(string)}
     */
    eachChannel(callback) {
        for (let gid in this._channel) {
            if (this._channel.hasOwnProperty(gid)) callback(gid);
        }
    }
    /**
     * 更新流量统计信息
     * @param reqId {number} 请求id
     * @param cacheSize {number} 缓存reqId数量上限
     * @returns {boolean} 是否收到重复包
     */
    updateReqId(reqId, cacheSize) {
        if (this._reqIdList.lastIndexOf(reqId) >= 0) {
            return false;//收到重复包
        } else {
            if (this._reqIdList.length >= cacheSize) {
                this._reqIdList.splice(0, Math.floor(cacheSize / 2));//清掉队列前的一半缓存
            }
            this._reqIdList.push(reqId);
            return true;
        }
    }
    /**
     * 更新最近收到心跳包的时间
     */
    updateHeart() {
        this._lastHeart = Date.now();
    }
    /**
     * 是否绑定了UID
     * @returns {boolean}
     */
    isBinded() {
        return !!this._uid;
    }
    /**
     * 是否已经超时未收到心跳包
     * @param timeout {number} 超时时间 ms
     * @returns {boolean}
     */
    isExpired(timeout) {
        return Date.now() > this._lastHeart + timeout;
    }

    get id() { return this._id; }

    get ip() { return this._ip; }

    get uid() { return this._uid || 'uid'; }
}

module.exports = WssSession;
