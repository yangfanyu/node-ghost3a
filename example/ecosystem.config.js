'use strict';
const ghost3a = require('../ghost3a');
const bootDir = __dirname.replace(new RegExp('\\\\', 'gm'), '/');//适配windows文件系统
module.exports = {
    apps: new ghost3a.PM2Adapter(process.argv, bootDir, bootDir + '/cfgs/hostname.txt', bootDir + '/cfgs/servers.json', 2).getApps()
};
