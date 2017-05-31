var os = require('os'),
    _ = require('lodash'),
    crypto = require('crypto'),
    Queue = require('bull'),
    Minio = require('minio'),
    redis = require('redis'),
    config = require('./config'),
    Promise = require('bluebird'),
    MailParser = require('mailparser').MailParser,
    request = require('superagent'),
    fs = Promise.promisifyAll(require('fs')),
    bunyan = require('bunyan'),
    stream = require('gelf-stream'),
    receivedBy = os.hostname(),
    log;

Promise.promisifyAll(redis.RedisClient.prototype);

var messageQ = new Queue('dermail-mta', config.redisQ.port, config.redisQ.host);
var redisStore = redis.createClient(config.redisQ);
var s3Config = {};

var s3 = {};

if (!!config.graylog) {
    log = bunyan.createLogger({
        name: 'MTA-Worker',
        streams: [{
            type: 'raw',
            stream: stream.forBunyan(config.graylog.host, config.graylog.port)
        }]
    });
}else{
    log = bunyan.createLogger({
        name: 'MTA-Worker'
    });
}

var start = function() {
    return new Promise(function(resolve, reject) {
        request
        .post(config.rx.s3())
        .timeout(10000)
        .set('X-remoteSecret', config.remoteSecret)
        .send({})
        .set('Accept', 'application/json')
        .end(function(err, res){
            if (err) {
                return reject(err);
            }
            if (res.body.ok !== true) {
                return reject(new Error('Cannot get S3 credentials.'));
            }

            log.info('Process ' + process.pid + ' is running as an MTA-Worker.')

            s3 = res.body.data;

            var minioClient = new Minio.Client({
                endPoint: s3.endpoint,
                port: 443,
                secure: true,
                accessKey: s3.key,
                secretKey: s3.secret
            });

            return resolve(minioClient);

        });
    });
}

var getRawKey = function(path) {
    return path + '-mta:raw';
}

var getAttachmentKey = function(path) {
    return path + '-mta:attachment';
}

var getSingleAttachmentKey = function(path, filename) {
    return path + ':attachment:' + filename;
}

var setRawStatus = function(path, status) {
    log.debug({ message: 'setRawStatus', path: path, status:status });
    return redisStore.setAsync(getRawKey(path), status)
}

var getRawStatus = function(path) {
    log.debug({ message: 'getRawStatus', path: path });
    return redisStore.getAsync(getRawKey(path));
}

var setAttachmentStatus = function(path, status) {
    log.debug({ message: 'setAttachmentStatus', path: path, status:status });
    return redisStore.setAsync(getAttachmentKey(path), status)
}

var setSingleAttachmentStatus = function(path, filename, status) {
    if (typeof status === 'object') status = JSON.stringify(status);
    log.debug({ message: 'setSingleAttachmentStatus', path: path, filename: filename, status:status });
    return redisStore.setAsync(getSingleAttachmentKey(path, filename), status)
}

var getAttachmentStatus = function(path) {
    log.debug({ message: 'getAttachmentStatus', path: path });
    return redisStore.getAsync(getAttachmentKey(path));
}

var getGarbageKeys = function(path) {
    log.debug({ message: 'getGarbageKeys', path: path });
    return redisStore.keysAsync(path + '-mta:*')
}

var getSingleAttachmentStatus = function(path, filename) {
    log.debug({ message: 'getSingleAttachmentStatus', path: path, filename: filename });
    return redisStore.getAsync(getSingleAttachmentKey(path, filename)).then(function(res) {
        try {
            res = JSON.parse(res);
        }catch(e) {
            log.error({ message: 'JSON.parse in getSingleAttachmentStatus throws an error', path: path, filename: filename, response: res })
        }
        return res;
    })
}

var enqueue = function(type, payload) {
    log.debug({ message: 'enqueue: ' + type, payload: payload });
    return messageQ.add({
        type: type,
        payload: payload
    }, config.Qconfig);
}

start()
.then(function(minioClient) {
    messageQ.process(3, function(job, done) {

        var data = job.data;
        var type = data.type;
        data = data.payload;

        log.info({ message: 'Received Job: ' + type, payload: data, job: {
            attemptsMade: job.attemptsMade,
            maxAttempts: job.attempts,
            delay: job.delay,
            jobId: job.jobId
        }});

        var callback = function(e) {
            if (e) {
                log.error({ message: 'Job ' + type + ' returns an error.', error: '[' + e.name + '] ' + e.message, stack: e.stack });
            }
            return done(e);
        }

        switch (type) {
            case 'processMail':

            var connection = data;
            var mailPath = connection.tmpPath;
            var mailParser = new MailParser({
                streamAttachments: true
            });

            var hasAttachments = false;

            mailParser.on('error', function(e) {
                // Probably errors related to "Error: Encoding not recognized"
                log.error({ message: 'MailParser stream throws an error', error: '[' + e.name + '] ' + e.message, stack: e.stack });
                return callback(e);
            });

            mailParser.on('end', function (mail) {
                if (typeof mail.attachments !== 'undefined') {
                    hasAttachments = true;
                }

                connection.receivedBy = receivedBy;

                // This is ideal
                /*return Promise.all([
                    setParseStatus(mailPath, task.parseDone),
                    setAttachmentStatus(mailPath, task.attachmentDone),
                    enqueue('garbageCollection', mailPath),
                    enqueue('parseMail', mailPath),
                    enqueue('uploadAttachments', mailPath)
                ])
                .then(function(results) {
                    return callback();
                })
                .catch(function(e) {
                    return callback(e);
                });*/

                // But if we can't set redis for status, we want to abort early
                return setRawStatus(mailPath, 'no')
                .then(function() {
                    if (!hasAttachments) return
                    return Promise.map(mail.attachments, function(attachment) {
                        delete attachment.stream;
                        return setSingleAttachmentStatus(mailPath, attachment.contentId, {
                            checksum: attachment.checksum,
                            length: attachment.length
                        });
                    }, { concurrency: 3 })
                })
                .then(function() {
                    return setAttachmentStatus(mailPath, hasAttachments ? 'no' : 'yes');
                })
                .then(function() {
                    return enqueue('saveRaw', connection);
                })
                .then(function() {
                    if (!hasAttachments) return;
                    return enqueue('saveAttachmentsTemporary', connection);
                })
                .then(function() {
                    if (!hasAttachments) return;
                    return enqueue('checkUploadStatus', {
                        connection: connection,
                        attachments: mail.attachments
                    });
                })
                .then(function() {
                    return enqueue('garbageCollection', connection);
                })
                .then(function(results) {
                    return callback();
                })
                .catch(function(e) {
                    return callback(e);
                });

            })

            var readStream = fs.createReadStream(mailPath);

            readStream.on('error', function(e) {
                log.error({ message: 'Create read stream in processMail throws an error', error: '[' + e.name + '] ' + e.message, stack: e.stack });
                return callback(e);
            })

            readStream.pipe(mailParser);

            break;

            case 'storeMail':

            var connection = data;

            var store = function(payload) {
                return new Promise(function(resolve, reject) {
                    request
                    .post(config.rx.hook())
                    .timeout(10000)
                    .set('X-remoteSecret', config.remoteSecret)
                    .send(payload)
                    .set('Accept', 'application/json')
                    .end(function(err, res){
                        if (err) {
                            return reject(err);
                        }
                        if (res.body.ok === true) {
                            return resolve();
                        }else{
                            return reject(res.body);
                        }
                    });
                });
            }

            return store(connection)
            .then(function() {
                return callback();
            })
            .catch(function(e) {
                return callback(e);
            })

            break;

            case 'saveAttachmentsTemporary':

            var connection = data;
            var mailPath = connection.tmpPath;
            var mailParser = new MailParser({
                streamAttachments: true
            });

            mailParser.on('attachment', function(attachment, mail) {

                var attachmentPath = mailPath + '-' + crypto.createHash('md5').update(attachment.contentId).digest("hex");

                var writeStream = fs.createWriteStream(attachmentPath);

                writeStream.on('error', function(e) {
                    log.error({ message: 'Create write stream in saveAttachmentsTemporary throws an error', error: '[' + e.name + '] ' + e.message, stack: e.stack });
                    return callback(e);
                })

                writeStream.on('finish', function() {
                    return getSingleAttachmentStatus(mailPath, attachment.contentId)
                    .then(function(obj) {
                        attachment.length = obj.length;
                        attachment.checksum = obj.checksum;
                    })
                    .then(function() {
                        return enqueue('uploadSingleAttachment', {
                            connection: connection,
                            attachment: attachment
                        });
                    })
                    .catch(function(e) {
                        log.error({ message: 'writeStream (finish) in saveAttachmentsTemporary throws an error', error: '[' + e.name + '] ' + e.message, stack: e.stack });
                        //return callback(e);
                    })
                })

                attachment.stream.pipe(writeStream);

            });

            mailParser.on('end', function(mail) {
                return callback();
            })

            var readStream = fs.createReadStream(mailPath);

            readStream.on('error', function(e) {
                log.error({ message: 'Create read stream in saveAttachmentsTemporary throws an error', error: '[' + e.name + '] ' + e.message, stack: e.stack });
                return callback(e);
            })

            readStream.pipe(mailParser);

            break;

            case 'saveRaw':

            var connection = data;
            var mailPath = connection.tmpPath;

            var filename = crypto.createHash('md5').update(mailPath).digest("hex");

            var getUploadPolicy = function(filename) {
                return new Promise(function(resolve, reject) {
                    var policy = minioClient.newPostPolicy()
                    policy.setBucket(s3.bucket)
                    policy.setKey(['raw', filename].join('/'))
                    var expires = new Date
                    expires.setSeconds(24 * 60 * 60 * 10)
                    policy.setExpires(expires)
                    policy.setContentType('text/plain')
                    minioClient.presignedPostPolicy(policy, function(err, postURL, formData) {
                        if (err) return reject(err);
                        return resolve([
                            postURL,
                            formData
                        ])
                    })
                });
            }

            var uploadRaw = function(mailPath, filename) {
                return new Promise(function(resolve, reject) {
                    getUploadPolicy(filename)
                    .spread(function(postURL, formData) {
                        var req = request.post(postURL)
                        Object.keys(formData).forEach(function(key) {
                            req.field(key, formData[key])
                        })
                        req.attach('file', mailPath, filename)
                        req.end(function(err, res) {
                            if (err) return reject(err)
                            resolve();
                        })
                    })
                    .catch(function(e) {
                        return reject(e);
                    })
                });
            }

            return uploadRaw(mailPath, filename)
            .then(function() {
                return setRawStatus(mailPath, 'yes');
            })
            .then(function() {
                return enqueue('storeMail', connection)
            })
            .then(function() {
                return callback();
            })
            .catch(function(e) {
                return callback(e);
            })

            break;

            case 'uploadSingleAttachment':

            var connection = data.connection;
            var mailPath = connection.tmpPath;
            var attachment = data.attachment;

            var attachmentPath = mailPath + '-' + crypto.createHash('md5').update(attachment.contentId).digest("hex");

            var getUploadPolicy = function(checksum, filename, contentType) {
                return new Promise(function(resolve, reject) {
                    var policy = minioClient.newPostPolicy()
                    policy.setBucket(s3.bucket)
                    policy.setKey([checksum, filename].join('/'))
                    var expires = new Date
                    expires.setSeconds(24 * 60 * 60 * 10)
                    policy.setExpires(expires)
                    policy.setContentType(contentType)
                    minioClient.presignedPostPolicy(policy, function(err, postURL, formData) {
                        if (err) return reject(err);
                        return resolve([
                            postURL,
                            formData
                        ])
                    })
                });
            }

            var uploadAttachment = function(connction, attachment) {
                return new Promise(function(resolve, reject) {
                    getUploadPolicy(attachment.checksum, attachment.generatedFileName, attachment.contentType)
                    .spread(function(postURL, formData) {
                        var req = request.post(postURL)
                        Object.keys(formData).forEach(function(key) {
                            req.field(key, formData[key])
                        })
                        req.attach('file', attachmentPath, attachment.generatedFileName)
                        req.end(function(err, res) {
                            if (err) return reject(err)
                            resolve();
                        })
                    })
                    .catch(function(e) {
                        return reject(e);
                    })
                });
            }

            return uploadAttachment(connection, attachment)
            .then(function() {
                return setSingleAttachmentStatus(mailPath, attachment.contentId, 'yes');
            })
            .then(function() {
                return fs.unlinkAsync(attachmentPath);
            })
            .then(function() {
                return callback();
            })
            .catch(function(e) {
                return callback(e);
            })

            break;

            case 'checkUploadStatus':

            var connection = data.connection;
            var mailPath = connection.tmpPath;
            var attachments = data.attachments;

            var attachmentDone = true;

            return Promise.map(attachments, function(attachment) {
                return getSingleAttachmentStatus(mailPath, attachment.contentId)
                .then(function(status) {
                    if (typeof status === 'object') attachmentDone = false;
                })
            }, { concurrency: 3 })
            .then(function() {
                if (attachmentDone) {
                    return setAttachmentStatus(mailPath, 'yes')
                    .then(function() {
                        return callback();
                    })
                }else{
                    return callback(new Error('Waiting for all files to be uploaded'));
                }
            })

            break;

            case 'garbageCollection':

            var connection = data;
            var mailPath = connection.tmpPath;

            return Promise.join(
                getRawStatus(mailPath),
                getAttachmentStatus(mailPath),
                function(raw, attachment) {
                    if (raw === 'yes' && attachment === 'yes') {
                        return fs.unlinkAsync(mailPath)
                        .then(function() {
                            return getGarbageKeys(mailPath);
                        })
                        .then(function(rows) {
                            return Promise.map(rows, function(key) {
                                return redisStore.delAsync(key);
                            }, { concurrency: 3 })
                        })
                        .then(function() {
                            return callback();
                        })
                        .catch(function(e) {
                            return callback(e);
                        })
                    }else{
                        return callback(new Error('Waiting for raw, and upload to finish'));
                    }
                }
            )

            break;
        }
    });
})
.catch(function(e) {
    log.error(e);
})
