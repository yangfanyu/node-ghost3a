"use strict";
let increment = 1;
const Session = function (socket, ip) {
    this.id = increment++;//自增id
    this.socket = socket;//绑定的套接字
    this.ip = ip;//绑定的IP地址
    this.uid = null;//绑定的用户ID
    this.context = {};//缓存的自定义数据
    this.channel = {};//加入的自定义群组
    this.$watch = {
        wssuped: false,//是否已经升级为websocket
        tmheart: Date.now(),//最近收到心跳包的时间（初始化为创建时间）
        bytecnt: 0,//router的一个心跳周期内收到的总流量
        packcnt: 0,//router的一个心跳周期内收到的包数量
        reqList: [],//最近X个请求id（一定程度上防御不断收到重复包攻击，串改id的话router中会有签名验证）
    };//安全监控
    this.socket.$session$ = this;//最后再绑定本实例到socket
};
Session.prototype.upgrate = function (socket, ip) {
    //用来升级为websocket
    this.socket = socket;
    this.ip = ip;
    this.$watch.wssuped = true;
    this.socket.$session$ = this;
};
Session.prototype.send = function (state, data) {
    if (this.socket && this.$watch.wssuped && this.socket.readyState === state) {
        this.socket.send(data);
        return true;
    } else {
        return false;
    }
};
Session.prototype.destroy = function () {
    if (this.socket) {
        if (this.$watch.wssuped) {
            this.socket.terminate();//强制关闭连接
        } else {
            this.socket.destroy();
        }
        this.socket = null;
    }
};
Session.prototype.bindUid = function (uid) {
    this.uid = uid;
};
Session.prototype.setContext = function (key, value) {
    this.context[key] = value;
};
Session.prototype.getContext = function (key) {
    return this.context[key];
};
Session.prototype.delContext = function (key) {
    delete this.context[key];
};
Session.prototype.joinChannel = function (gid) {
    this.channel[gid] = true;
};
Session.prototype.quitChannel = function (gid) {
    delete this.channel[gid];
};
Session.prototype.eachChannel = function (callback) {
    for (let key in this.channel) callback(key);
};
Session.prototype.updateByPack = function (bytes, reqId, bytesRate, packsRate, reqsCache) {
    //异常
    if (this.$watch.bytecnt > bytesRate) return 'bytes';//包总流量超标
    if (this.$watch.packcnt > packsRate) return 'packs';//包总数量超标
    if (this.$watch.reqList.lastIndexOf(reqId) >= 0) return 'repeat';//收到重复包
    //正常
    if (this.$watch.reqList.length >= reqsCache) this.$watch.reqList = [];//及时释放掉
    this.$watch.bytecnt += bytes;
    this.$watch.packcnt += 1;
    this.$watch.reqList.push(reqId);
    return null;
};
Session.prototype.updateByTick = function () {
    this.$watch.tmheart = Date.now();
};
Session.prototype.clearBytePack = function () {
    this.$watch.bytecnt = 0;
    this.$watch.packcnt = 0;
};
Session.prototype.isWssuped = function () {
    return this.$watch.wssuped;
};
Session.prototype.isExpired = function (timeout) {
    return Date.now() > this.$watch.tmheart + timeout;
};
module.exports = Session;
