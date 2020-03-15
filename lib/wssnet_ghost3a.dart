import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'package:encrypt/encrypt.dart';

typedef PackDataCallback = String Function();
typedef ListenerCallback = void Function(dynamic message, [List<dynamic> params]);
typedef RequestCallback = void Function(Response resp, [List<dynamic> params]);
typedef Ghost3aOnopen = void Function([List<dynamic> params]);
typedef Ghost3aOnclose = void Function(int code, String reason, [List<dynamic> params]);
typedef Ghost3aOnerror = void Function(String error, [List<dynamic> params]);
typedef Ghost3aOnretry = void Function(int count, [List<dynamic> params]);
typedef Ghost3aOnsecond = void Function(int second, int delay, [List<dynamic> params]);

class PackData {
  //route
  static const ROUTE_HEARTICK = '\$heartick\$'; //心跳包路由
  static const ROUTE_RESPONSE = '\$response\$'; //响应请求路由
  //code
  static const CODE_RETRY = {'code': 4101, 'data': 'retry'};
  static const CODE_CLOSE = {'code': 4102, 'data': 'close'};
  static const CODE_ERROR = {'code': 4103, 'data': 'error'};
  static const CODE_CALL = {'code': 4104, 'data': 'call'};

  String route; //路由
  int reqId; //序号
  dynamic message; //报文数据

  PackData(this.route, this.reqId, this.message);

  static void _copyUint8List(bool swapInt32Endian, Uint8List to, Uint8List from, int toOffset) {
    if (swapInt32Endian) {
      for (int i = 0; i < from.length; i += 4) {
        to[toOffset + i + 0] = from[i + 3];
        to[toOffset + i + 1] = from[i + 2];
        to[toOffset + i + 2] = from[i + 1];
        to[toOffset + i + 3] = from[i + 0];
      }
    } else {
      for (int i = 0; i < from.length; i++) {
        to[toOffset + i] = from[i];
      }
    }
  }

  //return String|Uint8List
  static dynamic serialize(PackData pack, String pwd, bool binary) {
    try {
      String str = json.encode(pack);
      if (pwd != null) {
        //ArrayBuffer or base64 string
        Hmac hmacSha256 = Hmac(sha256, utf8.encode(pwd)); // HMAC-SHA256
        Uint8List salt = Key.fromSecureRandom(16).bytes;
        Uint8List iv = Key.fromSecureRandom(16).bytes;
        List<int> key = hmacSha256.convert(salt).bytes;
        Encrypter aesCrypto = Encrypter(AES(Key(key), mode: AESMode.cbc, padding: 'PKCS7'));
        Uint8List body = aesCrypto.encrypt(str, iv: IV(iv)).bytes;
        Uint8List encRes = Uint8List(salt.length + iv.length + body.length);
        _copyUint8List(binary, encRes, salt, 0);
        _copyUint8List(binary, encRes, iv, salt.length);
        _copyUint8List(binary, encRes, body, salt.length + iv.length);
        return binary ? encRes : base64Encode(encRes);
      } else {
        //json string
        return str;
      }
    } catch (e) {
      return null;
    }
  }

  static PackData deserialize(dynamic data, String pwd) {
    try {
      if (pwd != null) {
        //ArrayBuffer or base64 string
        Hmac hmacSha256 = Hmac(sha256, utf8.encode(pwd)); // HMAC-SHA256
        Uint8List words;
        if (data is String) {
          words = base64Decode(data);
        } else {
          words = Uint8List(data.length);
          _copyUint8List(true, words, data, 0);
        }
        Uint8List salt = words.sublist(0, 16);
        Uint8List iv = words.sublist(16, 32);
        List<int> key = hmacSha256.convert(salt).bytes;
        Uint8List body = words.sublist(32);
        Encrypter aesCrypto = Encrypter(AES(Key(key), mode: AESMode.cbc, padding: 'PKCS7'));
        String decRes = aesCrypto.decrypt(Encrypted(body), iv: IV(iv));
        Map<String, dynamic> obj = json.decode(decRes);
        return PackData(obj['route'], obj['reqId'], obj['message']);
      } else {
        //json string
        Map<String, dynamic> obj = data is String ? json.decode(data) : {};
        return PackData(obj['route'], obj['reqId'], obj['message']);
      }
    } catch (e) {
      return null;
    }
  }

  static String getMD5(String data) {
    return md5.convert(utf8.encode(data)).toString();
  }

  Map<String, dynamic> toJson() => {'route': route, 'reqId': reqId, 'message': message};
}

class Listener {
  bool once; //是否只触发一次
  ListenerCallback onmessage;
  List<dynamic> params;

  Listener(this.once, this.onmessage, [this.params]);

  void callMessage(dynamic message) {
    if (onmessage != null) {
      onmessage(message, params);
    }
  }
}

class Request {
  int time; //请求的时间
  RequestCallback onsuccess;
  RequestCallback onerror;
  List<dynamic> params;

  Request(this.onsuccess, this.onerror, [this.params]) {
    time = DateTime.now().millisecondsSinceEpoch;
  }

  void callSuccess(Response resp) {
    if (onsuccess != null) {
      onsuccess(resp, params);
    }
  }

  void callError(Response resp) {
    if (onerror != null) {
      onerror(resp, params);
    }
  }
}

class Response {
  int code; //状态码
  dynamic data; //正确数据或错误描述

  Response(this.code, this.data);
}

class Ghost3a {
  static const LOG_LEVEL_ALL = 1;
  static const LOG_LEVEL_DATA = 2;
  static const LOG_LEVEL_INFO = 3;
  static const LOG_LEVEL_NONE = 4;

  String _host; //服务器地址
  String _pwd; //数据加解密口令
  bool _binary; //是否用二进制传输
  int _timeout; //请求超时（毫秒）
  int _heartick; //心跳间隔（秒）
  int _conntick; //重连间隔（秒）
  Timer _timer; //秒钟计时器
  int _timerInc; //秒数自增量
  int _reqIdInc; //请求自增量
  int _netDelay; //网络延迟
  int _retryCnt; //断线重连尝试次数
  Map<String, List<Listener>> _listeners; //监听集合
  Map<int, Request> _requests; //请求集合
  int _logLevel; //调试信息输出级别
  WebSocket _socket; //套接字
  bool _paused; //是否暂停重连
  bool _locked; //是否正在连接
  bool _expired; //是否已经销毁
  //状态监听
  Ghost3aOnopen _onopen;
  Ghost3aOnclose _onclose;
  Ghost3aOnerror _onerror;
  Ghost3aOnretry _onretry;
  Ghost3aOnsecond _onsecond;
  List<dynamic> _params;

  Ghost3a(String host, String pwd, bool binary, {int timeout = 8000, int heartick = 60, int conntick = 3}) {
    _host = host.indexOf('https:') == 0 ? host.replaceFirst('https:', 'wss:') : (host.indexOf('http:') == 0 ? host.replaceFirst('http:', 'ws:') : host);
    _pwd = pwd;
    _binary = binary;
    _timeout = timeout;
    _heartick = heartick;
    _conntick = conntick;
    _timer = null;
    _timerInc = 0;
    _reqIdInc = 0;
    _netDelay = 0;
    _retryCnt = 0;
    _listeners = {};
    _requests = {};
    _logLevel = Ghost3a.LOG_LEVEL_NONE;
    _socket = null;
    _paused = false;
    _locked = false;
    _expired = false;
  }

  void _onSocketConnect() {
    if (_logLevel < Ghost3a.LOG_LEVEL_NONE) print('connected $_host');
    _retryCnt = 0; //重置重连次数为0
    if (_onopen != null) _onopen(_params);
  }

  void _onSocketMessage(data) {
    if (_expired) return;
    _readPackData(data);
  }

  void _onSocketClose() {
    if (_expired) return;
    _safeClose(PackData.CODE_CLOSE['code'], PackData.CODE_CLOSE['data']);
    if (_onclose != null) _onclose(0, 'Unknow Reason', _params);
  }

  void _onSocketError(e) {
    if (_expired) return;
    _safeClose(PackData.CODE_ERROR['code'], PackData.CODE_ERROR['data']);
    if (_onerror != null) _onerror(e != null ? e.toString() : 'Unknow Error', _params);
  }

  void _onTimerTick() {
    //秒数自增
    _timerInc++;
    //清除超时的请求
    int time = DateTime.now().millisecondsSinceEpoch;
    List<int> list = [];
    _requests.forEach((reqId, request) {
      if (time - request.time > _timeout) {
        request.callError(Response(504, 'Gateway Timeout'));
        list.add(reqId);
      }
    });
    for (int i = 0; i < list.length; i++) {
      _requests.remove(list[i]);
    }
    //心跳和断线重连
    if (isConnected()) {
      if (_timerInc % _heartick == 0) {
        _sendPackData(PackData(PackData.ROUTE_HEARTICK, _reqIdInc++, DateTime.now().millisecondsSinceEpoch)); //发送心跳包
      }
    } else {
      if (_timerInc % _conntick == 0 && !_paused && !_locked) {
        _retryCnt++; //增加重连次数
        if (_onretry != null) _onretry(_retryCnt, _params);
        _safeOpen(); //安全开启连接
      }
    }
    //秒钟回调
    if (_onsecond != null) {
      _onsecond(_timerInc, _netDelay, _params);
    }
  }

  void _sendPackData(PackData pack) {
    if (_expired) return;
    if (this.isConnected()) {
      dynamic data = PackData.serialize(pack, _pwd, _binary);
      if (data == null) {
        if (_onerror != null) _onerror('Serialize Error', _params);
        return;
      }
      _socket.add(data);
      _printPackData('sendPackData >>>', pack);
    }
  }

  void _readPackData(dynamic data) {
    PackData pack = PackData.deserialize(data, _pwd);
    if (pack == null) {
      if (_onerror != null) _onerror('Deserialize Error', _params);
      return;
    }
    _printPackData('readPackData <<<', pack);
    switch (pack.route) {
      case PackData.ROUTE_HEARTICK:
        //服务端心跳响应
        _netDelay = DateTime.now().millisecondsSinceEpoch - pack.message; //更新网络延迟
        if (_logLevel == Ghost3a.LOG_LEVEL_ALL) print('net delay: ${_netDelay}ms');
        break;
      case PackData.ROUTE_RESPONSE:
        //客户端请求响应
        Request request = _requests[pack.reqId];
        if (request == null) return; //超时的响应，监听器已经被_timer删除
        _netDelay = DateTime.now().millisecondsSinceEpoch - request.time; //更新网络延迟
        if (_logLevel == Ghost3a.LOG_LEVEL_ALL) print('net delay: ${_netDelay}ms');
        dynamic message = pack.message == null ? {} : pack.message;
        Response resp = Response(message['code'], message['data']);
        if (resp.code == 200) {
          request.callSuccess(resp);
        } else {
          request.callError(resp);
        }
        _requests.remove(pack.reqId);
        break;
      default:
        //服务器主动推送
        triggerEvent(pack);
        break;
    }
  }

  void _printPackData(String title, PackData pack) {
    if (pack.route == PackData.ROUTE_HEARTICK) {
      if (_logLevel == Ghost3a.LOG_LEVEL_ALL) {
        print('$title');
        print('\troute: ${pack.route}');
        if (pack.reqId != null) print('\treqId: ${pack.reqId}');
        if (pack.message != null) print('\tmessage: ${pack.message}');
      }
    } else if (_logLevel <= Ghost3a.LOG_LEVEL_DATA) {
      print('$title');
      print('\troute: ${pack.route}');
      if (pack.reqId != null) print('\treqId: ${pack.reqId}');
      if (pack.message != null) print('\tmessage: ${pack.message}');
    }
  }

  void _safeOpen() {
    _safeClose(PackData.CODE_RETRY['code'], PackData.CODE_RETRY['data']); //关闭旧连接
    if (_expired) return;
    /**
     * dart版本的_socket是连接建立后异步赋值的，所以必须要加锁来保证同时只有一个连接在尝试建立
     * 否则WebSocket.connect调用了多少次就会then或catchError多少次，且同时尝试多个连接很混乱
     */
    if (_locked) return;
    _locked = true; //加锁
    WebSocket.connect(_host).timeout(Duration(milliseconds: _timeout)).then((socket) {
      _socket = socket;
      _locked = false; //解锁
      //手动回调，添加监听，与JS保持一致
      _onSocketConnect();
      _socket.listen(_onSocketMessage, onError: _onSocketError, onDone: _onSocketClose);
    }).catchError((e) {
      _locked = false; //解锁
      _onSocketError(e);
    });
  }

  void _safeClose(int code, String reason) {
    if (_socket != null) {
      _socket.close(code, reason).catchError((e) {});
      _socket = null;
    }
  }

  void connect(Ghost3aOnopen onopen, Ghost3aOnclose onclose, Ghost3aOnerror onerror, Ghost3aOnretry onretry, Ghost3aOnsecond onsecond, [List<dynamic> params]) {
    _onopen = onopen;
    _onclose = onclose;
    _onerror = onerror;
    _onretry = onretry;
    _onsecond = onsecond;
    _params = params;
    //打开
    _safeOpen(); //安全开启连接
    _timer = Timer.periodic(Duration(seconds: 1), (Timer timer) => _onTimerTick());
  }

  void disconnect() {
    if (_logLevel < Ghost3a.LOG_LEVEL_NONE) print('disconnected $_host');
    _expired = true;
    //关闭
    if (_timer != null) {
      _timer.cancel();
      _timer = null;
    }
    _safeClose(PackData.CODE_CALL['code'], PackData.CODE_CALL['data']); //安全关闭连接
  }

  void request(String route, dynamic message, RequestCallback onsuccess, RequestCallback onerror, [List<dynamic> params]) {
    int reqId = _reqIdInc++;
    if (onsuccess != null || onerror != null) _requests[reqId] = Request(onsuccess, onerror, params);
    _sendPackData(PackData(route, reqId, message));
  }

  void addListener(String route, bool once, ListenerCallback onmessage, [List<dynamic> params]) {
    List<Listener> listeners = _listeners[route];
    if (listeners == null) {
      listeners = [];
      _listeners[route] = listeners;
    }
    listeners.add(Listener(once, onmessage, params));
  }

  void removeListener(String route, [ListenerCallback onmessage]) {
    List<Listener> listeners = _listeners[route];
    if (listeners == null) return;
    if (onmessage == null) {
      _listeners.remove(route); //删除该路由的全部监听
    } else {
      List<Listener> list = [];
      for (int i = 0; i < listeners.length; i++) {
        Listener item = listeners[i];
        if (item.onmessage == onmessage) {
          list.add(item);
        }
      }
      while (list.isNotEmpty) {
        listeners.remove(list.removeLast());
      }
      if (listeners.isEmpty) {
        _listeners.remove(route);
      }
    }
  }

  void triggerEvent(PackData pack) {
    List<Listener> listeners = _listeners[pack.route];
    if (listeners == null) return;
    List<Listener> oncelist = []; //删除只触发一次的监听
    for (int i = 0; i < listeners.length; i++) {
      Listener item = listeners[i];
      item.callMessage(pack.message);
      if (item.once) {
        oncelist.add(item);
      }
    }
    for (int i = 0; i < oncelist.length; i++) {
      removeListener(pack.route, oncelist[i].onmessage);
    }
  }

  void pauseReconnect() => _paused = true;

  void resumeReconnect() => _paused = false;

  void setLogLevel(int level) => _logLevel = level;

  int getNetDelay() => _netDelay;

  bool isConnected() => _socket != null && _socket.readyState == WebSocket.open;
}
