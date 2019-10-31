'use strict';
const {MongoClient, ObjectID} = require('mongodb');

/**
 * 对node-mongodb-native封装的类
 * node-mongodb-native相关信息：http://mongodb.github.io/node-mongodb-native/
 */
class MongoMan {
    /**
     * 私有属性
     * @property {EnvContext} _context
     * @property {{url:string,urlOptions:Object,db:string,dbOptions:Object}} _config
     * @property {Logger} _logger
     * @property {MongoClient} _client
     * @property {Db} _db
     * 构造函数参数
     * @param context {EnvContext} 上下文包装类实例
     * @param category {string} 日志分类
     * @param config {Object} 驱动node-mongodb-native配置信息，参考依赖库 http://mongodb.github.io/node-mongodb-native/
     * @param config.url {string} MongoClient地址
     * @param config.urlOptions {Object} MongoClient选项
     * @param config.db {string} 数据库名
     * @param config.dbOptions {Object} 数据库参数
     */
    constructor(context, category, config = {}) {
        this._context = context;
        this._config = config;
        //绑定log4js实例
        this._logger = context.getLogger(category);
        //mongo相关引用
        this._client = null;//客户端实例
        this._db = null;//数据库实例
    }
    /**
     * @return {Promise<void>}
     */
    async connect() {
        try {
            this._client = new MongoClient(this._config.url, this._config.urlOptions);
            await this._client.connect();
            this._db = this._client.db(this._config.db, this._config.dbOptions);
            this._logger.info(this._config.url, this._config.db, 'connected');
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'connect error,', e);
        }
    }
    /**
     * @param force {boolean}
     * @return {Promise<void>}
     */
    async close(force = false) {
        try {
            if (this._client) {
                await this._client.close(force);
                this._client = null;
                this._db = null;
            }
            this._logger.info(this._config.url, this._config.db, 'closed');
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'close error,', e);
        }
    }
    /**
     * @param table {string}
     * @param doc {Object}
     * @param insertOptions {Object}
     * @param tableOptions {Object}
     * @return {Promise<number>}
     */
    async insertOne(table, doc, insertOptions = undefined, tableOptions = undefined) {
        try {
            const result = await this._db.collection(table, tableOptions).insertOne(doc, insertOptions);
            this._logger.debug(this._config.url, this._config.db, 'insertOne', ...arguments, result.insertedCount);
            return result.insertedCount;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'insertOne', ...arguments, e.toString());
            return 0;
        }
    }
    /**
     * @param table {string}
     * @param docs {Object[]}
     * @param insertOptions {Object}
     * @param tableOptions {Object}
     * @return {Promise<number>}
     */
    async insertMany(table, docs, insertOptions = undefined, tableOptions = undefined) {
        try {
            const result = await this._db.collection(table, tableOptions).insertMany(docs, insertOptions);
            this._logger.debug(this._config.url, this._config.db, 'insertMany', ...arguments, result.insertedCount);
            return result.insertedCount;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'insertMany', ...arguments, e.toString());
            return 0;
        }
    }
    /**
     * @param table {string}
     * @param query {Object}
     * @param findOptions {Object}
     * @param tableOptions {Object}
     * @return {Promise<Object>}
     */
    async findOne(table, query, findOptions = undefined, tableOptions = undefined) {
        try {
            const result = await this._db.collection(table, tableOptions).findOne(query, findOptions);
            this._logger.debug(this._config.url, this._config.db, 'findOne', ...arguments, result);
            return result;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'findOne', ...arguments, e.toString());
            return null;
        }
    }
    /**
     * @param table {string}
     * @param query {Object}
     * @param join {{
     *                  fromField:string,
     *                  toField:string,
     *                  resField:string,
     *                  onlyOne:boolean,
     *                  table:string,
     *                  query:Object|undefined,
     *                  findOptions:Object|undefined,
     *                  tableOptions:Object|undefined
     *             }}
     * @param findOptions {Object}
     * @param tableOptions {Object}
     * @return {Promise<Object[]>}
     */
    async findMany(table, query, join = undefined, findOptions = undefined, tableOptions = undefined) {
        try {
            const result = await this._db.collection(table, tableOptions).find(query, findOptions).toArray();
            if (result.length > 0 && join) {
                //模拟单表左外连接
                let equalsId = false;
                join.query = join.query || {};
                join.query.$or = [];
                for (let i = 0; i < result.length; i++) {
                    const param = {};
                    param[join.toField] = result[i][join.fromField];
                    equalsId = typeof param[join.toField] === 'object';
                    join.query.$or.push(param);
                }
                const joinResult = await this._db.collection(join.table, join.tableOptions).find(join.query, join.findOptions).toArray();
                for (let i = 0; i < result.length; i++) {
                    const doc = result[i];
                    doc[join.resField] = join.onlyOne ? {} : [];
                    for (let k = 0; k < joinResult.length; k++) {
                        const item = joinResult[k];
                        if ((equalsId && doc[join.fromField].equals(item[join.toField])) || (!equalsId && doc[join.fromField] === item[join.toField])) {
                            if (join.onlyOne) {
                                doc[join.resField] = item;
                                break;
                            } else {
                                doc[join.resField].push(item);
                            }
                        }
                    }
                }
            }
            this._logger.debug(this._config.url, this._config.db, 'findMany', ...arguments, result);
            return result;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'findMany', ...arguments, e.toString());
            return null;
        }
    };
    /**
     * @param table {string}
     * @param filter {Object}
     * @param update {Object}
     * @param updateOptions {Object}
     * @param tableOptions {Object}
     * @return {Promise<number>}
     */
    async updateOne(table, filter, update, updateOptions = undefined, tableOptions = undefined) {
        try {
            const result = await this._db.collection(table, tableOptions).updateOne(filter, update, updateOptions);
            this._logger.debug(this._config.url, this._config.db, 'updateOne', ...arguments, result.matchedCount, result.modifiedCount);
            return result.matchedCount;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'updateOne', ...arguments, e.toString());
            return 0;
        }
    };
    /**
     * @param table {string}
     * @param filter {Object}
     * @param update {Object}
     * @param updateOptions {Object}
     * @param tableOptions {Object}
     * @return {Promise<number>}
     */
    async updateMany(table, filter, update, updateOptions = undefined, tableOptions = undefined) {
        try {
            const result = await this._db.collection(table, tableOptions).updateMany(filter, update, updateOptions);
            this._logger.debug(this._config.url, this._config.db, 'updateMany', ...arguments, result.matchedCount, result.modifiedCount);
            return result.matchedCount;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'updateMany', ...arguments, e.toString());
            return 0;
        }
    };
    /**
     * @param table {string}
     * @param filter {Object}
     * @param deleteOptions {Object}
     * @param tableOptions {Object}
     * @return {Promise<number>}
     */
    async deleteOne(table, filter, deleteOptions = undefined, tableOptions = undefined) {
        try {
            const result = await this._db.collection(table, tableOptions).deleteOne(filter, deleteOptions);
            this._logger.debug(this._config.url, this._config.db, 'deleteOne', ...arguments, result.deletedCount);
            return result.deletedCount;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'deleteOne', ...arguments, e.toString());
            return 0;
        }
    };
    /**
     * @param table {string}
     * @param filter {Object}
     * @param deleteOptions {Object}
     * @param tableOptions {Object}
     * @return {Promise<number>}
     */
    async deleteMany(table, filter, deleteOptions = undefined, tableOptions = undefined) {
        try {
            const result = await this._db.collection(table, tableOptions).deleteMany(filter, deleteOptions);
            this._logger.debug(this._config.url, this._config.db, 'deleteMany', ...arguments, result.deletedCount);
            return result.deletedCount;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'deleteMany', ...arguments, e.toString());
            return 0;
        }
    };
    /**
     * @param table {string}
     * @param query {Object}
     * @param countOptions {Object}
     * @param tableOptions {Object}
     * @return {Promise<number>}
     */
    async countDocuments(table, query = undefined, countOptions = undefined, tableOptions = undefined) {
        try {
            const result = await this._db.collection(table, tableOptions).countDocuments(query, countOptions);
            this._logger.debug(this._config.url, this._config.db, 'countDocuments', ...arguments, result);
            return result;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'countDocuments', ...arguments, e.toString());
            return 0;
        }
    };
    /**
     * 这个是原子操作
     * @param table {string}
     * @param filter {Object}
     * @param update {Object}
     * @param findUpdateOptions {Object}
     * @param tableOptions {Object}
     * @return {Promise<Object>}
     */
    async findOneAndUpdate(table, filter, update, findUpdateOptions = undefined, tableOptions = undefined) {
        try {
            const result = await this._db.collection(table, tableOptions).findOneAndUpdate(filter, update, findUpdateOptions);
            this._logger.debug(this._config.url, this._config.db, 'findOneAndUpdate', ...arguments, result.value);
            return result.value;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'findOneAndUpdate', ...arguments, e.toString());
            return null;
        }
    };
    /**
     * 这个是原子操作
     * @param table {string}
     * @param filter {Object}
     * @param findDeleteOptions {Object}
     * @param tableOptions {Object}
     * @return {Promise<Object>}
     */
    async findOneAndDelete(table, filter, findDeleteOptions = undefined, tableOptions = undefined) {
        try {
            const result = await this._db.collection(table, tableOptions).findOneAndDelete(filter, findDeleteOptions);
            this._logger.debug(this._config.url, this._config.db, 'findOneAndDelete', ...arguments, result.value);
            return result.value;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'findOneAndDelete', ...arguments, e.toString());
            return 0;
        }
    };
    /**
     * @param table
     * @param tableOptions {Object}
     * @return {Collection}
     */
    collection(table, tableOptions = undefined) {
        return this._db.collection(table);
    }
    /**
     * @param hexstr {string}
     * @return {MongoClient.connect.ObjectID}
     */
    hexstr2ObjectID(hexstr) {
        return new ObjectID(hexstr);
    }
}

module.exports = MongoMan;
