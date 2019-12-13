var wssnet;
(function (wssnet) {
    var PackData = /** @class */ (function () {
        function PackData(route, reqId, message) {
            this.route = route;
            this.reqId = reqId;
            this.message = message;
        }
        PackData.serialize = function (pack, pwd, binary) {
            try {
                var str = JSON.stringify(pack);
                if (pwd) {
                    //ArrayBuffer or base64 string
                    var salt = CryptoJS.lib.WordArray.random(16);
                    var iv = CryptoJS.lib.WordArray.random(16);
                    var key = CryptoJS.HmacSHA256(salt, pwd);
                    var body = CryptoJS.AES.encrypt(str, key, {
                        iv: iv,
                        mode: CryptoJS.mode.CBC,
                        padding: CryptoJS.pad.Pkcs7
                    }).ciphertext;
                    var encRes = CryptoJS.lib.WordArray.create();
                    encRes.concat(salt).concat(iv).concat(body);
                    return binary ? new Int32Array(encRes.words).buffer : encRes.toString(CryptoJS.enc.Base64);
                }
                else {
                    //json string
                    return str;
                }
            }
            catch (e) {
                return null;
            }
        };
        PackData.deserialize = function (data, pwd) {
            try {
                if (pwd) {
                    //ArrayBuffer or base64 string
                    var words = data instanceof ArrayBuffer ? Array.prototype.slice.call(new Int32Array(data)) : CryptoJS.enc.Base64.parse(data).words;
                    var salt = CryptoJS.lib.WordArray.create(words.slice(0, 4));
                    var iv = CryptoJS.lib.WordArray.create(words.slice(4, 8));
                    var key = CryptoJS.HmacSHA256(salt, pwd);
                    var body = CryptoJS.lib.WordArray.create(words.slice(8));
                    var decRes = CryptoJS.AES.decrypt({ ciphertext: body }, key, {
                        iv: iv,
                        mode: CryptoJS.mode.CBC,
                        padding: CryptoJS.pad.Pkcs7
                    }).toString(CryptoJS.enc.Utf8);
                    var obj = JSON.parse(decRes);
                    return new PackData(obj.route, obj.reqId, obj.message);
                }
                else {
                    //json string
                    var obj = data instanceof ArrayBuffer ? {} : JSON.parse(data);
                    return new PackData(obj.route, obj.reqId, obj.message);
                }
            }
            catch (e) {
                return null;
            }
        };
        PackData.getMd5 = function (data) {
            return CryptoJS.MD5(data).toString();
        };
        //route
        PackData.ROUTE_HEARTICK = '$heartick$'; //心跳包路由
        PackData.ROUTE_RESPONSE = '$response$'; //响应请求路由
        //code
        PackData.CODE_RETRY = { code: 4101, data: 'retry' };
        PackData.CODE_CLOSE = { code: 4102, data: 'close' };
        PackData.CODE_ERROR = { code: 4103, data: 'error' };
        PackData.CODE_CALL = { code: 4104, data: 'call' };
        return PackData;
    }());
    wssnet.PackData = PackData;
    var Listener = /** @class */ (function () {
        function Listener(once, onmessage, context, params) {
            this.once = once;
            this.onmessage = onmessage;
            this.context = context || this;
            this.params = params;
        }
        Listener.prototype.callMessage = function (message) {
            if (this.onmessage) {
                this.onmessage.call(this.context, message, this.params);
            }
        };
        return Listener;
    }());
    wssnet.Listener = Listener;
    var Request = /** @class */ (function () {
        function Request(onsuccess, onerror, context, params) {
            this.time = Date.now();
            this.onsuccess = onsuccess;
            this.onerror = onerror;
            this.context = context || this;
            this.params = params;
        }
        Request.prototype.callSuccess = function (resp) {
            if (this.onsuccess) {
                this.onsuccess.call(this.context, resp, this.params);
            }
        };
        Request.prototype.callError = function (resp) {
            if (this.onerror) {
                this.onerror.call(this.context, resp, this.params);
            }
        };
        return Request;
    }());
    wssnet.Request = Request;
    var Response = /** @class */ (function () {
        function Response(code, data) {
            this.code = code;
            this.data = data;
        }
        return Response;
    }());
    wssnet.Response = Response;
    var Ghost3a = /** @class */ (function () {
        function Ghost3a(host, pwd, binary, timeout, heartick, conntick) {
            if (timeout === void 0) { timeout = 8000; }
            if (heartick === void 0) { heartick = 60; }
            if (conntick === void 0) { conntick = 3; }
            this.host = host.indexOf('https:') == 0 ? host.replace('https:', 'wss:') : (host.indexOf('http:') == 0 ? host.replace('http:', 'ws:') : host);
            this.pwd = pwd;
            this.binary = binary;
            this.timeout = timeout;
            this.heartick = heartick;
            this.conntick = conntick;
            this.timer = null;
            this.timerInc = 0;
            this.reqIdInc = 0;
            this.netDelay = 0;
            this.retryCnt = 0;
            this.listeners = {};
            this.requests = {};
            this.logLevel = Ghost3a.LOG_LEVEL_NONE;
            this.socket = null;
            this.expired = false;
        }
        Ghost3a.prototype.onSocketOpen = function (e) {
            if (this.logLevel < Ghost3a.LOG_LEVEL_NONE)
                console.log('connected', this.host);
            this.retryCnt = 0; //重置重连次数为0
            if (this.onopen)
                this.onopen.call(this.context, this.params);
        };
        Ghost3a.prototype.onSocketMessage = function (e) {
            if (this.expired)
                return;
            this.readPackData(e.data);
        };
        Ghost3a.prototype.onSocketClose = function (e) {
            if (this.expired)
                return;
            this.safeClose(PackData.CODE_CLOSE.code, PackData.CODE_CLOSE.data);
            if (this.onclose)
                this.onclose.call(this.context, e.code || 0, e.reason || 'Unknow Reason', this.params);
        };
        Ghost3a.prototype.onSocketError = function (e) {
            if (this.expired)
                return;
            this.safeClose(PackData.CODE_ERROR.code, PackData.CODE_ERROR.data);
            if (this.onerror)
                this.onerror.call(this.context, e.message || 'Unknow Error', this.params);
        };
        Ghost3a.prototype.onTimerTick = function () {
            //秒数自增
            this.timerInc++;
            //清除超时的请求
            var time = Date.now();
            var list = [];
            for (var reqId in this.requests) {
                if (this.requests.hasOwnProperty(reqId)) {
                    var request = this.requests[reqId];
                    if (time - request.time > this.timeout) {
                        request.callError(new Response(504, 'Gateway Timeout'));
                        list.push(reqId);
                    }
                }
            }
            for (var i = 0; i < list.length; i++) {
                delete this.requests[list[i]];
            }
            //心跳和断线重连
            if (this.isConnected()) {
                if (this.timerInc % this.heartick == 0) {
                    this.sendPackData(new PackData(PackData.ROUTE_HEARTICK, this.reqIdInc++, Date.now())); //发送心跳包
                }
            }
            else {
                if (this.timerInc % this.conntick == 0) {
                    this.retryCnt++; //增加重连次数
                    if (this.onretry)
                        this.onretry.call(this.context, this.retryCnt, this.params);
                    this.safeOpen(); //安全开启连接
                }
            }
            //秒钟回调
            if (this.onsecond) {
                this.onsecond.call(this.context, this.timerInc, this.netDelay, this.params);
            }
        };
        Ghost3a.prototype.sendPackData = function (pack) {
            if (this.expired)
                return;
            if (this.isConnected()) {
                var data = PackData.serialize(pack, this.pwd, this.binary);
                if (!data) {
                    if (this.onerror)
                        this.onerror.call(this.context, 'Serialize Error', this.params);
                    return;
                }
                this.socket.send(data);
                this.printPackData('sendPackData >>>', pack);
            }
        };
        Ghost3a.prototype.readPackData = function (data) {
            var pack = PackData.deserialize(data, this.pwd);
            if (!pack) {
                if (this.onerror)
                    this.onerror.call(this.context, 'Deserialize Error', this.params);
                return;
            }
            this.printPackData('readPackData <<<', pack);
            switch (pack.route) {
                case PackData.ROUTE_HEARTICK:
                    //服务端心跳响应
                    this.netDelay = Date.now() - pack.message; //更新网络延迟
                    if (this.logLevel == Ghost3a.LOG_LEVEL_ALL)
                        console.log('net delay:', this.netDelay + 'ms');
                    break;
                case PackData.ROUTE_RESPONSE:
                    //客户端请求响应
                    var request = this.requests[pack.reqId];
                    if (!request)
                        return; //超时的响应，监听器已经被_timer删除
                    this.netDelay = Date.now() - request.time; //更新网络延迟
                    if (this.logLevel == Ghost3a.LOG_LEVEL_ALL)
                        console.log('net delay:', this.netDelay + 'ms');
                    var message = pack.message || {};
                    var resp = new Response(message.code, message.data);
                    if (resp.code == 200) {
                        request.callSuccess(resp);
                    }
                    else {
                        request.callError(resp);
                    }
                    delete this.requests[pack.reqId];
                    break;
                default:
                    //服务器主动推送
                    this.triggerEvent(pack);
                    break;
            }
        };
        Ghost3a.prototype.printPackData = function (title, pack) {
            if (pack.route == PackData.ROUTE_HEARTICK) {
                if (this.logLevel == Ghost3a.LOG_LEVEL_ALL) {
                    console.group(title);
                    console.log('route:', pack.route);
                    if (pack.reqId != void 0)
                        console.log('reqId:', pack.reqId);
                    if (pack.message != void 0)
                        console.log('message:', pack.message);
                    console.groupEnd();
                }
            }
            else if (this.logLevel <= Ghost3a.LOG_LEVEL_DATA) {
                console.group(title);
                console.log('route:', pack.route);
                if (pack.reqId != void 0)
                    console.log('reqId:', pack.reqId);
                if (pack.message != void 0)
                    console.log('message:', pack.message);
                console.groupEnd();
            }
        };
        Ghost3a.prototype.safeOpen = function () {
            var _this = this;
            this.safeClose(PackData.CODE_RETRY.code, PackData.CODE_RETRY.data); //关闭旧连接
            if (this.expired)
                return;
            this.socket = new WebSocket(this.host, typeof module === 'object' ? { rejectUnauthorized: false } : void 0); //创建WebSocket对象
            this.socket.binaryType = 'arraybuffer';
            this.socket.onopen = function (e) { _this.onSocketOpen(e); }; //添加连接打开侦听，连接成功会调用此方法
            this.socket.onmessage = function (e) { _this.onSocketMessage(e); }; //添加收到数据侦听，收到数据会调用此方法
            this.socket.onclose = function (e) { _this.onSocketClose(e); }; //添加连接关闭侦听，手动关闭或者服务器关闭连接会调用此方法
            this.socket.onerror = function (e) { _this.onSocketError(e); }; //添加异常侦听，出现异常会调用此方法
        };
        Ghost3a.prototype.safeClose = function (code, reason) {
            if (this.socket) {
                this.socket.close(code, reason);
                this.socket = null;
            }
        };
        Ghost3a.prototype.connect = function (onopen, onclose, onerror, onretry, onsecond, context, params) {
            var _this = this;
            this.onopen = onopen;
            this.onclose = onclose;
            this.onerror = onerror;
            this.onretry = onretry;
            this.onsecond = onsecond;
            this.context = context || this;
            this.params = params;
            //打开
            this.safeOpen(); //安全开启连接
            this.timer = setInterval(function () { _this.onTimerTick(); }, 1000);
        };
        Ghost3a.prototype.disconnect = function () {
            if (this.logLevel < Ghost3a.LOG_LEVEL_NONE)
                console.log('disconnected', this.host);
            this.expired = true;
            //关闭
            if (this.timer) {
                clearInterval(this.timer);
                this.timer = null;
            }
            this.safeClose(PackData.CODE_CALL.code, PackData.CODE_CALL.data); //安全关闭连接
        };
        Ghost3a.prototype.request = function (route, message, onsuccess, onerror, context, params) {
            var reqId = this.reqIdInc++;
            if (onsuccess || onerror)
                this.requests[reqId] = new Request(onsuccess, onerror, context, params); //有监听器的放入请求队列
            this.sendPackData(new PackData(route, reqId, message));
        };
        Ghost3a.prototype.addListener = function (route, once, onmessage, context, params) {
            var listeners = this.listeners[route];
            if (listeners == void 0) {
                listeners = [];
                this.listeners[route] = listeners;
            }
            listeners.push(new Listener(once, onmessage, context, params));
        };
        Ghost3a.prototype.removeListener = function (route, onmessage) {
            var listeners = this.listeners[route];
            if (!listeners)
                return;
            if (onmessage == void 0) {
                delete this.listeners[route]; //删除该路由的全部监听
            }
            else {
                var list = [];
                for (var i = 0; i < listeners.length; i++) {
                    var item = listeners[i];
                    if (item.onmessage == onmessage) {
                        list.push(item);
                    }
                }
                while (list.length > 0) {
                    var index = listeners.indexOf(list.pop());
                    if (index >= 0) {
                        listeners.splice(index, 1);
                    }
                }
                if (listeners.length == 0) {
                    delete this.listeners[route];
                }
            }
        };
        Ghost3a.prototype.triggerEvent = function (pack) {
            var listeners = this.listeners[pack.route];
            if (!listeners)
                return;
            var oncelist = []; //删除只触发一次的监听
            for (var i = 0; i < listeners.length; i++) {
                var item = listeners[i];
                item.callMessage(pack.message);
                if (item.once) {
                    oncelist.push(item);
                }
            }
            for (var i = 0; i < oncelist.length; i++) {
                this.removeListener(pack.route, oncelist[i].onmessage);
            }
        };
        Ghost3a.prototype.setLogLevel = function (level) {
            this.logLevel = level;
        };
        Ghost3a.prototype.getNetDelay = function () {
            return this.netDelay;
        };
        Ghost3a.prototype.isConnected = function () {
            return this.socket && this.socket.readyState === WebSocket.OPEN;
        };
        Ghost3a.LOG_LEVEL_ALL = 1;
        Ghost3a.LOG_LEVEL_DATA = 2;
        Ghost3a.LOG_LEVEL_INFO = 3;
        Ghost3a.LOG_LEVEL_NONE = 4;
        return Ghost3a;
    }());
    wssnet.Ghost3a = Ghost3a;
})(wssnet || (wssnet = {}));
if (typeof module === 'object') {
    if (typeof CryptoJS === 'undefined') {
        CryptoJS = require('crypto-js');
    }
    if (typeof WebSocket === 'undefined') {
        WebSocket = require('ws');
    }
    module.exports = wssnet;
}
