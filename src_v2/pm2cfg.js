"use strict";
const fs = require('fs');
const path = require('path');
const Pm2cfg = function (processArgv, bootfile, configfile, hostFile, logLevel) {
    const envIndex = processArgv.indexOf('--env');
    if (envIndex < 0 || envIndex === processArgv.length - 1) return;
    this.logLevel = logLevel;
    this.env = processArgv[envIndex + 1];//--env参数后面的值是运行环境类型
    try {
        this.host = hostFile ? fs.readFileSync(hostFile, 'utf8').trim() : null;//指定文件中读取的主机名称
    } catch (e) {
        this.host = null;
    }
    this.base = path.dirname(bootfile);
    this.data = JSON.parse(fs.readFileSync(configfile.replace('${base}', this.base), 'utf8'));
    if (this.logLevel > 0) console.log('env:', this.env);
    if (this.logLevel > 0) console.log('host:', this.host);
    if (this.logLevel > 0) console.log('base:', this.base);
};

Pm2cfg.prototype.getPm2Apps = function () {
    if (!this.env) throw Error('启动命令: pm2 start ecosystem.config.js --env xxxxxxxx');
    if (this.env === 'project') return null;
    const cfg = this.data[this.env];
    if (!cfg) return null;
    const pro = this.data['project'] || {};
    const apps = [];
    const sevs = {};
    for (let key in cfg) {
        let group = cfg[key];
        sevs[key] = [];
        for (let i = 0; i < group.length; i++) {
            let item = group[i];
            if (pro.bind && pro.bind.indexOf(this.env) >= 0) {
                if (!this.host) {
                    throw Error('未读取到主机名!');
                }
                if (item.host === '${hostname}') {
                    item.host = this.host;//替换为当前主机域名
                } else if (item.host !== this.host) {
                    continue;//过滤掉主机名不匹配的进程
                }
            }
            //pm2进程属性
            let inst = {
                name: item.name || ((pro.name ? pro.name + '-' : "") + key),
                script: item.script || pro.script || 'app.js',
                instances: item.instances || pro.instances || '1',
                exec_mode: item.exec_mode || pro.exec_mode || 'cluster',
                output: item.output || pro.output || '/dev/null',
                error: item.error || pro.error || (this.base + '/logs/pm2-error.log')
            };
            //app进行属性
            inst['env_' + this.env] = {
                NODE_ENV: this.env === 'development' ? this.env : 'production',//nodejs运行环境(定义为production有利于提高性能)
                MYAPP_ENV: this.env,//应用运行环境
                MYAPP_NAME: key,//分组类型
                MYAPP_HOST: item.host,//外网地址
                MYAPP_PORT: item.port,//端口号码
                MYAPP_INIP: item.inip || '',//内网ip
                MYAPP_LINK: item.link || [],//需要连接的进程分组（他妈的某些版本的pm2不支持数组）
                MYAPP_SEVS: sevs//同种分组类型的地址列表（他妈的某些版本的pm2不支持对象）
            };
            sevs[key].push({
                host: item.host,
                inip: item.inip || '',
                port: item.port,
                ssls: pro.ssls[this.env].indexOf(key) >= 0
            });
            apps.push(inst);
        }
    }
    //将MYAPP_LINK和MYAPP_SEVS属性转换为字符串
    for (let i = 0; i < apps.length; i++) {
        let inst = apps[i];
        inst['env_' + this.env].MYAPP_LINK = JSON.stringify(inst['env_' + this.env].MYAPP_LINK);
        inst['env_' + this.env].MYAPP_SEVS = JSON.stringify(inst['env_' + this.env].MYAPP_SEVS);
    }
    if (this.logLevel > 1) console.log('apps:\n', apps);
    return apps;
};
module.exports = {
    /**
     * @param processArgv 进程启动命令参数列表
     * @param bootfile PM2启动文件ecosystem.config.js的绝对路径
     * @param configfile 服务器配置文件绝对路径
     * @param hostFile 当前主机域名配置绝对路径
     * @param logLevel 打印调试信息级别
     * @returns {Pm2cfg} 类实例
     */
    create: function (processArgv, bootfile, configfile, hostFile, logLevel) {
        return new Pm2cfg(processArgv, bootfile, configfile, hostFile, logLevel);
    }
};