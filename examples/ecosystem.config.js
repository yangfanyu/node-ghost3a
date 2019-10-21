'use strict';
const ghost3a = require('../ghost3a');
module.exports = {
    apps: new ghost3a.PM2Adapter(process.argv, __dirname, __dirname + '/cfgs/hostname.txt', __dirname + '/cfgs/servers.json', 2).getApps()
};
