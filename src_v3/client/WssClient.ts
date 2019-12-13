// TypeScript file
declare let module;
declare let require;
declare let CryptoJS: {
    MD5: (...args) => { toString: (...args) => string, concat: (...args) => any, words: any },
    AES: {
        encrypt: (...args) => { toString: (...args) => string, ciphertext: any },
        decrypt: (...args) => { toString: (...args) => string },
    },
    HmacSHA256: (...args) => { toString: (...args) => string };
    lib: {
        WordArray: {
            random: (...args) => { toString: (...args) => string, concat: (...args) => any, words: any };
            create: (...args) => { toString: (...args) => string, concat: (...args) => any, words: any };
        }
    },
    enc: { Utf8: any, Base64: any },
    mode: { CBC: any }
    pad: { Pkcs7: any }
};
namespace wssnet {
    export class PackData {
        //route
        public static readonly ROUTE_HEARTICK = '$heartick$';//心跳包路由
        public static readonly ROUTE_RESPONSE = '$response$';//响应请求路由
        //code
        public static readonly CODE_RETRY = { code: 4101, data: 'retry' };
        public static readonly CODE_CLOSE = { code: 4102, data: 'close' };
        public static readonly CODE_ERROR = { code: 4103, data: 'error' };
        public static readonly CODE_CALL = { code: 4104, data: 'call' };

        public route: string;//路由
        public reqId: number;//序号
        public message: any;//报文数据
        public constructor(route: string, reqId: number, message: any) {
            this.route = route;
            this.reqId = reqId;
            this.message = message;
        }
        public static serialize(pack: PackData, pwd: string, binary: boolean): ArrayBuffer | string {
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
        public static deserialize(data: ArrayBuffer | string, pwd: string): PackData {
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
        public static getMd5(data): string {
            return CryptoJS.MD5(data).toString();
        }
    }
    export class Listener {
        public once: boolean;//是否只触发一次
        public onmessage: (message: any, params?: any[]) => void;
        public context: any;
        public params: any[];

        public constructor(once: boolean, onmessage: (message: any, params?: any[]) => void, context?: any, params?: any[]) {
            this.once = once;
            this.onmessage = onmessage;
            this.context = context || this;
            this.params = params;
        }

        public callMessage(message: any) {
            if (this.onmessage) {
                this.onmessage.call(this.context, message, this.params);
            }
        }
    }
    export class Request {
        public time: number;//请求的时间
        public onsuccess: (resp: Response, params?: any[]) => void;
        public onerror: (resp: Response, params?: any[]) => void;
        public context: any;
        public params: any[];

        public constructor(onsuccess?: (resp: Response, params?: any[]) => void, onerror?: (resp: Response, params?: any[]) => void, context?: any, params?: any[]) {
            this.time = Date.now();
            this.onsuccess = onsuccess;
            this.onerror = onerror;
            this.context = context || this;
            this.params = params;
        }

        public callSuccess(resp: Response) {
            if (this.onsuccess) {
                this.onsuccess.call(this.context, resp, this.params);
            }
        }

        public callError(resp: Response) {
            if (this.onerror) {
                this.onerror.call(this.context, resp, this.params);
            }
        }
    }
    export class Response {
        public code: number;//状态码
        public data: any;//正确数据或错误描述

        public constructor(code: number, data: any) {
            this.code = code;
            this.data = data;
        }
    }
    export class Ghost3a {
        public static readonly LOG_LEVEL_ALL = 1;
        public static readonly LOG_LEVEL_DATA = 2;
        public static readonly LOG_LEVEL_INFO = 3;
        public static readonly LOG_LEVEL_NONE = 4;

        private host: string;//服务器地址
        private pwd: string;//数据加解密口令
        private binary: boolean;//是否用二进制传输
        private timeout: number;//请求超时（毫秒）
        private heartick: number;//心跳间隔（秒）
        private conntick: number;//重连间隔（秒）
        private timer: any;//秒钟计时器
        private timerInc: number;//秒数自增量
        private reqIdInc: number;//请求自增量
        private netDelay: number;//网络延迟
        private retryCnt: number;//断线重连尝试次数
        private listeners: any;//监听集合
        private requests: any;//请求集合
        private logLevel: number;//调试信息输出级别
        private socket: WebSocket;//套接字
        private expired: boolean;//是否已经销毁
        //状态监听
        private onopen: (params?: any[]) => void;
        private onclose: (code: number, reason: string, params?: any[]) => void;
        private onerror: (error: any, params?: any[]) => void;
        private onretry: (count: number, params?: any[]) => void;
        private onsecond: (second: number, delay: number, params?: any[]) => void;
        private context: any;
        private params: any[];

        public constructor(host: string, pwd: string, binary: boolean, timeout: number = 8000, heartick: number = 60, conntick: number = 3) {
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

        private onSocketOpen(e: any) {
            if (this.logLevel < Ghost3a.LOG_LEVEL_NONE) console.log('connected', this.host);
            this.retryCnt = 0;//重置重连次数为0
            if (this.onopen) this.onopen.call(this.context, this.params);
        }

        private onSocketMessage(e: any): void {
            if (this.expired) return;
            this.readPackData(e.data);
        }

        private onSocketClose(e: any) {
            if (this.expired) return;
            this.safeClose(PackData.CODE_CLOSE.code, PackData.CODE_CLOSE.data);
            if (this.onclose) this.onclose.call(this.context, e.code || 0, e.reason || 'Unknow Reason', this.params);
        }

        private onSocketError(e: any) {
            if (this.expired) return;
            this.safeClose(PackData.CODE_ERROR.code, PackData.CODE_ERROR.data);
            if (this.onerror) this.onerror.call(this.context, e.message || 'Unknow Error', this.params);
        }

        private onTimerTick() {
            //秒数自增
            this.timerInc++;
            //清除超时的请求
            let time: number = Date.now();
            let list: string[] = [];
            for (let reqId in this.requests) {
                if (this.requests.hasOwnProperty(reqId)) {
                    let request: Request = this.requests[reqId];
                    if (time - request.time > this.timeout) {
                        request.callError(new Response(504, 'Gateway Timeout'));
                        list.push(reqId);
                    }
                }
            }
            for (let i = 0; i < list.length; i++) {
                delete this.requests[list[i]];
            }
            //心跳和断线重连
            if (this.isConnected()) {
                if (this.timerInc % this.heartick == 0) {
                    this.sendPackData(new PackData(PackData.ROUTE_HEARTICK, this.reqIdInc++, Date.now()));//发送心跳包
                }
            } else {
                if (this.timerInc % this.conntick == 0) {
                    this.retryCnt++;//增加重连次数
                    if (this.onretry) this.onretry.call(this.context, this.retryCnt, this.params);
                    this.safeOpen();//安全开启连接
                }
            }
            //秒钟回调
            if (this.onsecond) {
                this.onsecond.call(this.context, this.timerInc, this.netDelay, this.params);
            }
        }

        private sendPackData(pack: PackData) {
            if (this.expired) return;
            if (this.isConnected()) {
                let data = PackData.serialize(pack, this.pwd, this.binary);
                if (!data) {
                    if (this.onerror) this.onerror.call(this.context, 'Serialize Error', this.params);
                    return;
                }
                this.socket.send(data);
                this.printPackData('sendPackData >>>', pack);
            }
        }

        private readPackData(data: any) {
            let pack = PackData.deserialize(data, this.pwd);
            if (!pack) {
                if (this.onerror) this.onerror.call(this.context, 'Deserialize Error', this.params);
                return;
            }
            this.printPackData('readPackData <<<', pack);
            switch (pack.route) {
                case PackData.ROUTE_HEARTICK:
                    //服务端心跳响应
                    this.netDelay = Date.now() - pack.message;//更新网络延迟
                    if (this.logLevel == Ghost3a.LOG_LEVEL_ALL) console.log('net delay:', this.netDelay + 'ms');
                    break;
                case PackData.ROUTE_RESPONSE:
                    //客户端请求响应
                    let request: Request = this.requests[pack.reqId];
                    if (!request) return;//超时的响应，监听器已经被_timer删除
                    this.netDelay = Date.now() - request.time;//更新网络延迟
                    if (this.logLevel == Ghost3a.LOG_LEVEL_ALL) console.log('net delay:', this.netDelay + 'ms');
                    let message = pack.message || {};
                    let resp = new Response(message.code, message.data);
                    if (resp.code == 200) {
                        request.callSuccess(resp);
                    } else {
                        request.callError(resp);
                    }
                    delete this.requests[pack.reqId];
                    break;
                default:
                    //服务器主动推送
                    this.triggerEvent(pack);
                    break;
            }
        }

        private printPackData(title: string, pack: PackData) {
            if (pack.route == PackData.ROUTE_HEARTICK) {
                if (this.logLevel == Ghost3a.LOG_LEVEL_ALL) {
                    console.group(title);
                    console.log('route:', pack.route);
                    if (pack.reqId != void 0) console.log('reqId:', pack.reqId);
                    if (pack.message != void 0) console.log('message:', pack.message);
                    console.groupEnd();
                }
            } else if (this.logLevel <= Ghost3a.LOG_LEVEL_DATA) {
                console.group(title);
                console.log('route:', pack.route);
                if (pack.reqId != void 0) console.log('reqId:', pack.reqId);
                if (pack.message != void 0) console.log('message:', pack.message);
                console.groupEnd();
            }
        }

        private safeOpen() {
            this.safeClose(PackData.CODE_RETRY.code, PackData.CODE_RETRY.data);//关闭旧连接
            if (this.expired) return;
            this.socket = new WebSocket(this.host, typeof module === 'object' ? <any>{ rejectUnauthorized: false } : void 0);//创建WebSocket对象
            this.socket.binaryType = 'arraybuffer';
            this.socket.onopen = (e) => { this.onSocketOpen(e)};//添加连接打开侦听，连接成功会调用此方法
            this.socket.onmessage = (e) => { this.onSocketMessage(e) };//添加收到数据侦听，收到数据会调用此方法
            this.socket.onclose = (e) => { this.onSocketClose(e) };//添加连接关闭侦听，手动关闭或者服务器关闭连接会调用此方法
            this.socket.onerror = (e) => { this.onSocketError(e) };//添加异常侦听，出现异常会调用此方法
        }

        private safeClose(code: number, reason: string) {
            if (this.socket) {
                this.socket.close(code, reason);
                this.socket = null;
            }
        }

        public connect(
            onopen: (params?: any[]) => void,
            onclose: (code: number, reason: string, params?: any[]) => void,
            onerror: (error: any, params?: any[]) => void,
            onretry: (count: number, params?: any[]) => void,
            onsecond: (second: number, delay: number, params?: any[]) => void,
            context?: any, params?: any[]) {
            this.onopen = onopen;
            this.onclose = onclose;
            this.onerror = onerror;
            this.onretry = onretry;
            this.onsecond = onsecond;
            this.context = context || this;
            this.params = params;
            //打开
            this.safeOpen();//安全开启连接
            this.timer = setInterval(() => { this.onTimerTick() }, 1000);
        }

        public disconnect() {
            if (this.logLevel < Ghost3a.LOG_LEVEL_NONE) console.log('disconnected', this.host);
            this.expired = true;
            //关闭
            if (this.timer) {
                clearInterval(this.timer);
                this.timer = null;
            }
            this.safeClose(PackData.CODE_CALL.code, PackData.CODE_CALL.data);//安全关闭连接
        }

        public request(route: string, message: any, onsuccess?: (resp: Response, params?: any[]) => void, onerror?: (resp: Response, params?: any[]) => void, context?: any, params?: any[]) {
            let reqId = this.reqIdInc++;
            if (onsuccess || onerror) this.requests[reqId] = new Request(onsuccess, onerror, context, params);//有监听器的放入请求队列
            this.sendPackData(new PackData(route, reqId, message));
        }

        public addListener(route: string, once: boolean, onmessage: (message: any, params?: any[]) => void, context?: any, params?: any[]) {
            let listeners: Listener[] = this.listeners[route];
            if (listeners == void 0) {
                listeners = [];
                this.listeners[route] = listeners;
            }
            listeners.push(new Listener(once, onmessage, context, params));
        }

        public removeListener(route: string, onmessage?: (message: any, params?: any[]) => void) {
            let listeners: Listener[] = this.listeners[route];
            if (!listeners) return;
            if (onmessage == void 0) {
                delete this.listeners[route];//删除该路由的全部监听
            } else {
                let list: Listener[] = [];
                for (let i = 0; i < listeners.length; i++) {
                    let item = listeners[i];
                    if (item.onmessage == onmessage) {
                        list.push(item);
                    }
                }
                while (list.length > 0) {
                    let index = listeners.indexOf(list.pop());
                    if (index >= 0) {
                        listeners.splice(index, 1);
                    }
                }
                if (listeners.length == 0) {
                    delete this.listeners[route];
                }
            }
        }

        public triggerEvent(pack: PackData) {
            let listeners: Listener[] = this.listeners[pack.route];
            if (!listeners) return;
            let oncelist: Listener[] = [];//删除只触发一次的监听
            for (let i = 0; i < listeners.length; i++) {
                let item = listeners[i];
                item.callMessage(pack.message);
                if (item.once) {
                    oncelist.push(item);
                }
            }
            for (let i = 0; i < oncelist.length; i++) {
                this.removeListener(pack.route, oncelist[i].onmessage);
            }
        }

        public setLogLevel(level: number) {
            this.logLevel = level;
        }

        public getNetDelay(): number {
            return this.netDelay;
        }

        public isConnected(): boolean {
            return this.socket && this.socket.readyState === WebSocket.OPEN;
        }
    }
}
if (typeof module === 'object') {
    if (typeof CryptoJS === 'undefined') {
        CryptoJS = require('crypto-js');
    }
    if (typeof WebSocket === 'undefined') {
        WebSocket = require('ws');
    }
    module.exports = wssnet;
}
