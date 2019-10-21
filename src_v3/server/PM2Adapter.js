'use strict';
const fs = require('fs');

/**
 * 该类将符合本库模板的服务器配置文件解析为pm2启动所需的配置信息
 * 启动命令如: pm2 start ecosystem.config.js --env development
 * pm2相关信息参考：http://pm2.keymetrics.io/docs/usage/application-declaration/
 */
class PM2Adapter {
    /**
     * 私有属性
     * @property {string} _envName
     * @property {string} _bootDir
     * @property {string} _hostName
     * @property {
     *            Object.<string, {
     *                                clusters: Object.<string, {
     *                                                              host:string,
     *                                                              inip:string,
     *                                                              port:number,
     *                                                              ssls:{key:string, cert:string},
     *                                                              links:string[],
     *                                                              PM2config:{
     *                                                                  ...pm2 parameters for ecosystem.config.js
     *                                                              }
     *                                                        }[]
     *                                                 >
     *                                defaults: {
     *                                              host:string,
     *                                              inip:string,
     *                                              port:number,
     *                                              ssls:{key:string, cert:string},
     *                                              links:string[],
     *                                              PM2config:{
     *                                                  ...pm2 parameters for ecosystem.config.js
     *                                              }
     *                                        },
     *                                hostBind: boolean,
     *                            }
     *                   >
     *           } _servers
     * @property {number} _logLevel
     * @property {string} _encode
     * 构造函数参数
     * @param processArgv {string[]} 启动进程的参数，process.argv
     * @param bootDir {string} pm2启动时ecosystem.config.js文件的绝对路径
     * @param hostNameFile {string} 主机名称文件绝对路径
     * @param serversFile {string} 服务器配置文件绝对路径
     * @param logLevel {number} 打印解析过程的日志级别：0不打印、1打印基本信息、>=2打印完整信息
     * @param encode {string} 编码默认值为utf8
     */
    constructor(processArgv, bootDir, hostNameFile, serversFile, logLevel, encode = 'utf8') {
        const envIndex = processArgv.indexOf('--env');
        if (envIndex < 0 || envIndex === processArgv.length - 1) {
            throw Error('command: pm2 start ecosystem.config.js --env xxxxxxxx');
        }
        this._envName = processArgv[envIndex + 1];//--env参数后面的值是运行环境类型
        this._bootDir = bootDir;
        this._hostName = hostNameFile ? fs.readFileSync(hostNameFile, {encoding: encode}).trim() : null;//指定文件中读取的主机名称
        let serversStr = fs.readFileSync(serversFile, {encoding: encode});
        serversStr = serversStr.replace(new RegExp('\\${opt:bootDir}', 'gm'), this._bootDir);
        serversStr = serversStr.replace(new RegExp('\\${opt:hostName}', 'gm'), this._hostName);
        this._servers = JSON.parse(serversStr);//指定文件中读取服务器配置信息
        this._logLevel = logLevel;
        this._encode = encode;
        if (this._logLevel >= 1) {
            console.log('---base info---');
            console.log('envName:', this._envName);
            console.log('bootDir:', this._bootDir);
            console.log('hostName:', this._hostName);
        }
    }
    /**
     * 返回pm2启动的apps
     * @return {Array}
     */
    getApps() {
        const clusters = this._servers[this._envName].clusters;
        const hostBind = this._servers[this._envName].hostBind || false;
        const defaults = this._servers[this._envName].defaults || {};
        if (hostBind && !this._hostName) throw Error('Cant not read hostname.');
        const apps = [];
        const nodes = {};
        const instEnvName = 'env_' + this._envName;
        for (let appName in clusters) {
            if (clusters.hasOwnProperty(appName)) {
                let cluster = clusters[appName];
                nodes[appName] = [];
                for (let i = 0; i < cluster.length; i++) {
                    let item = cluster[i];
                    //进程的pm2属性
                    let inst = {};
                    Object.assign(inst, defaults.PM2config || {});
                    Object.assign(inst, item.PM2config || {});
                    inst.name = (defaults.PM2config ? defaults.PM2config.name || 'app' : 'app') + '-' + (appName + '-' + (item.port || defaults.port || i));
                    //进程的应用参数
                    inst[instEnvName] = {
                        NODE_ENV: this._envName === 'development' ? 'development' : 'production',//nodejs运行环境(定义为production有利于提高性能)
                        MYAPP_DIR: this._bootDir,//应用启动根目录
                        MYAPP_ENV: this._envName,//应用运行环境
                        MYAPP_NAME: appName,//分组类型
                        MYAPP_HOST: (item.host === undefined ? defaults.host : item.host) || null,//外网地址
                        MYAPP_INIP: (item.inip === undefined ? defaults.inip : item.inip) || null,//内网ip
                        MYAPP_PORT: (item.port === undefined ? defaults.port : item.port) || null,//端口号码
                        MYAPP_SSLS: (item.ssls === undefined ? defaults.ssls : item.ssls) || null,//证书加载路径
                        MYAPP_LINKS: (item.links === undefined ? defaults.links : item.links) || [],//需要连接的进程分组（他妈的某些版本的pm2不支持数组）
                        MYAPP_NODES: nodes//全部节点集合
                    };
                    //集群的节点数据
                    nodes[appName].push({
                        host: inst[instEnvName].MYAPP_HOST,
                        inip: inst[instEnvName].MYAPP_INIP,
                        port: inst[instEnvName].MYAPP_PORT,
                        ssls: !!(inst[instEnvName].MYAPP_SSLS)
                    });
                    //对应主机的apps
                    if (!hostBind || inst[instEnvName].MYAPP_HOST === this._hostName) {
                        apps.push(inst);
                    }
                }
            }
        }
        //将对象属性转换为字符串
        for (let i = 0; i < apps.length; i++) {
            const inst = apps[i];
            inst[instEnvName].MYAPP_SSLS = JSON.stringify(inst[instEnvName].MYAPP_SSLS);
            inst[instEnvName].MYAPP_LINKS = JSON.stringify(inst[instEnvName].MYAPP_LINKS);
            inst[instEnvName].MYAPP_NODES = JSON.stringify(inst[instEnvName].MYAPP_NODES);
        }
        if (this._logLevel >= 2) {
            console.log('---apps info---');
            console.log('total', apps.length);
            console.log(apps);
        }
        return apps;
    }
}

module.exports = PM2Adapter;
