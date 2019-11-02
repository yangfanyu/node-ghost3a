'use strict';
const ghost3a = require('../ghost3a');
//创建上下文
const envContext = ghost3a.EnvContext.createByProcessEnv(process.env);
envContext.initLog4js(__dirname + '/cfgs/log4js.json');
//设置自定义上下文参数
envContext.configure('development', 'http', () => { envContext.setContext('maxAge', '0') });
envContext.configure('production', 'http', () => { envContext.setContext('maxAge', '1h') });
//Express服务器
envContext.configure('development|production', 'http', () => {
    //创建express服务器
    const webServer = new ghost3a.WebServer(envContext, 'server', {
        uploadKey: 'file',
        uploadDir: __dirname + '/files'
    });
    //加载内置模块
    webServer.loadBaseModules();
    webServer.loadPrintModule();
    webServer.loadUploadModule('/upload', (code, data, req, resp) => {
        resp.json({code: code, data: data});
    });
    //加载静态资源
    webServer.webapp.use('/', webServer.express.static('./web', {maxAge: envContext.getContext('maxAge')}));
    webServer.webapp.use('/crypto.js', webServer.express.static('../node_modules/crypto-js/crypto-js.js', {maxAge: envContext.getContext('maxAge')}));
    webServer.webapp.use('/wssnet.js', webServer.express.static('../src_v3/client/WssClient.min.js', {maxAge: envContext.getContext('maxAge')}));
    // 注册动态请求
    // webServer.webapp.all('xxxxxxxx', (req, resp) => { });
    //启动服务器
    webServer.start();
    //监听关闭信号
    process.on('SIGINT', () => {
        webServer.close((error) => {
            process.exit(error ? 1 : 0);
        });
    });
});
//WebSocket服务器
envContext.configure('development|production', 'home|chat', () => {
    const wssServer = new ghost3a.WssServer(envContext, 'server', {pwd: '123', binary: true, cycle: 10000});
    wssServer.initClusters();
    /**
     * 添加home的路由
     * 外部服务器节点：用户专门来接收客户端的连接，可以方便的横向添加节点
     * 这里是客户端直接连接的节点，所以每一个session对应一个客户端连接
     */
    envContext.configure('development|production', 'home', () => {
        wssServer.addRouter('login', (server, session, pack) => {
            if (pack.message.uid) {
                server.bindUid(session, pack.message.uid);
                server.response(session, pack, {code: 200, data: '使用ID: ' + pack.message.uid + ' 登录成功'});
            } else {
                server.response(session, pack, {code: 500, data: 'uid不能为空'});
            }
        });
        wssServer.addRouter('logout', (server, session, pack) => {
            server.unbindUid(session);
            server.response(session, pack, {code: 200, data: '已退出登录'});
        });
        wssServer.addRouter('joinRoom', (server, session, pack) => {
            if (pack.message.gid) {
                server.joinChannel(session, pack.message.gid);
                server.response(session, pack, {code: 200, data: '已加入: ' + pack.message.gid + ' 房间'});
            } else {
                server.response(session, pack, {code: 500, data: 'gid不能为空'});
            }
        });
        wssServer.addRouter('quitRoom', (server, session, pack) => {
            if (pack.message.gid) {
                server.quitChannel(session, pack.message.gid);
                server.response(session, pack, {code: 200, data: '已退出: ' + pack.message.gid + ' 房间'});
            } else {
                server.response(session, pack, {code: 500, data: 'gid不能为空'});
            }
        });
        //下列三个路由是将消息发送到本节点的对应连接
        wssServer.addRouter('sendP2P', (server, session, pack) => {
            if (pack.message.uid) {
                server.pushSession(pack.message.uid, 'onP2PMessage', pack.message.text);
                server.response(session, pack, {code: 200, data: '发送成功'});
            } else {
                server.response(session, pack, {code: 500, data: 'uid不能为空'});
            }
        });
        wssServer.addRouter('sendGRP', (server, session, pack) => {
            if (pack.message.gid) {
                // server.pushChannel(pack.message.gid, 'onGRPMessage', pack.message.text);//每个uid都推送一样的消息
                server.pushChannelCustom(pack.message.gid, 'onGRPMessage', pack.message.text, (uid, message) => {
                    return 'custom for ' + uid + '->' + message;//推给每个uid的数据都不一样，举例场景： 棋牌房间、网游场景等
                });
                server.response(session, pack, {code: 200, data: '发送成功'});
            } else {
                server.response(session, pack, {code: 500, data: 'gid不能为空'});
            }
        });
        wssServer.addRouter('sendALL', (server, session, pack) => {
            server.broadcast('onALLMessage', pack.message.text);
            server.response(session, pack, {code: 200, data: '发送成功'});
        });
        wssServer.addRouter('rmc', (server, session, pack) => {
            server.callRemoteRoute('chat', 'rmcMethod', '是我home节点的rmc');
            server.response(session, pack, {code: 200, data: '调用成功'});
        });
        wssServer.addRouter('rmcResult', async (server, session, pack) => {
            const resp = await server.callRemoteRouteResult('chat', 'rmcMethod', '是我home节点的rmcResult');
            server.response(session, pack, resp);
        });
    });
    /**
     * 添加chat的路由
     * 内部服务器节点：用于做一些复杂处理如聊天服务器消息过滤等，可以方便的横向添加节点
     * 这里不是客户端直接连接的节点，所以session对应的不是客户端的连接，而是外部服务器节点的通讯连接
     * 内部节点可以有很多层，客户端访问路由如：aaa.bbb.ccc.xxxxxxxx; 一般两层就够用了
     */
    envContext.configure('development|production', 'chat', () => {
        //下列三个路由是将消息发送到外部服务器节点中的对应连接，
        //可以通过dispatchCallback来快速映射到指定节点，减少节点间转发数据的开销
        wssServer.addRouter('sendP2P', (server, session, pack) => {
            if (pack.message.uid) {
                server.pushClusterSession('home', pack.message.uid, 'onP2PMessage', pack.message.text);
                server.response(session, pack, {code: 200, data: 'cluster发送成功'});
            } else {
                server.response(session, pack, {code: 500, data: 'uid不能为空'});
            }
        });
        wssServer.addRouter('sendGRP', (server, session, pack) => {
            if (pack.message.gid) {
                server.pushClusterChannel('home', pack.message.gid, 'onGRPMessage', pack.message.text);
                server.response(session, pack, {code: 200, data: 'cluster发送成功'});
            } else {
                server.response(session, pack, {code: 500, data: 'gid不能为空'});
            }
        });
        wssServer.addRouter('sendALL', (server, session, pack) => {
            server.clusterBroadcast('home', 'onALLMessage', pack.message.text);
            server.response(session, pack, {code: 200, data: 'cluster发送成功'});
        });
        wssServer.addRouter('rmcMethod', (server, session, pack) => {
            server.response(session, pack, {code: 200, data: '我是chat节点的远程方法rmcMethod'});
        });
    });
    //启动服务器
    wssServer.start();
    //监听关闭信号
    process.on('SIGINT', () => {
        wssServer.close((error) => {
            process.exit(error ? 1 : 0);
        });
    });
});
//记录未捕获的全局异常日志
const globalLogger = envContext.getLogger('appglobal');
process.on('uncaughtException', (error) => {
    globalLogger.error('uncaughtException: ', error);
});
