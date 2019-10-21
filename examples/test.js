'use strict';
const {EnvContext, MongoMan} = require('../ghost3a');

function testMongoMan() {
    let envContext = new EnvContext(__dirname, 'development', 'test', 'localhost', '', 8080);
    envContext.initLog4js(__dirname + '/cfgs/log4js.json');
    let mongo = new MongoMan(envContext, 'appglobal', {
        url: "mongodb://127.0.0.1:27017/ghost3a",
        db: 'ghost3a',
        urlOptions: {
            useUnifiedTopology: true,
            // useNewUrlParser: true,
            poolSize: 8
        },
        dbOptions: {}
    });
    mongo.connect().then(async (res) => {
        const table = 'user';
        //insertOneDoc
        const user = {name: 'name-0'};
        await mongo.insertOne(table, user);
        console.log('json result:', JSON.stringify(user));
        //insertManyDocs
        const userArr = [{name: 'name-1'}, {name: 'name-2'}, {name: 'name-3'}, {name: 'name-4'}];
        await mongo.insertMany(table, userArr);
        //findOneDoc
        await mongo.findOne(table, {_id: user._id.toString()});
        await mongo.findOne(table, {_id: mongo.hexstr2ObjectID(user._id.toString())});
        //findManyDocs
        await mongo.findMany(table, {}, {
            table: table,
            fromField: '_id',
            toField: '_id',
            resField: 'refer',
            onlyOne: true
        }, {
            skip: 2,
            limit: 3
        });
        //updateOneDoc
        await mongo.updateOne(table, {}, {
            $set: {nick: 'aaa'}
        });
        //updateManyDocs
        await mongo.updateMany(table, {}, {
            $set: {info: 'bbb'}
        });
        //findOneAndUpdateDoc
        await mongo.findOneAndUpdate(table, {}, {
            $set: {info: 'ccc'}
        }, {returnOriginal: false});
        await mongo.countDocuments(table);
        //findOneAndDeleteDoc
        await mongo.findOneAndDelete(table, {info: 'ccc'});
        await mongo.countDocuments(table);
        //deleteOneDoc
        await mongo.deleteOne(table, {info: 'bbb'});
        await mongo.countDocuments(table);
        //deleteManyDocs
        await mongo.deleteMany(table, {info: 'bbb'});
        await mongo.countDocuments(table);
        //custom
        let count = await mongo.collection(table).countDocuments({});
        console.log(count);
        //close
        await mongo.close();
    });
}

testMongoMan();
