module.exports = {
    PM2Adapter: require('./src_v3/server/PM2Adapter'),
    EnvContext: require('./src_v3/server/EnvContext'),
    WebServer: require('./src_v3/server/WebServer'),
    WssServer: require('./src_v3/server/WssServer'),
    WssSession: require('./src_v3/server/WssSession'),
    WssClient: require('./src_v3/client/WssClient'),
    MongoMan: require('./src_v3/server/MongoMan'),
    Deprecated: function () {
        return {
            context: require('./src_v2/context'),
            logx4js: require('./src_v2/logx4js'),
            mongodb: require('./src_v2/mongo'),
            router: require('./src_v2/router'),
            pm2cfg: require('./src_v2/pm2cfg'),
            wssnet: require('./src_v2/client/wssnet')
        };
    }
};
