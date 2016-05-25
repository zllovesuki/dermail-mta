var _ = require('lodash'),
	Queue = require('bull'),
	knox = require('knox'),
	redis = require('redis'),
	config = require('./config'),
	Promise = require('bluebird'),
	MailParser = require('mailparser').MailParser,
	helper = require('./helper'),
	request = require('superagent'),
	fs = Promise.promisifyAll(require('fs')),
	bunyan = require('bunyan'),
	stream = require('gelf-stream'),
	log;

Promise.promisifyAll(redis.RedisClient.prototype);

var messageQ = new Queue('dermail-mta', config.redisQ.port, config.redisQ.host);
var redisStore = redis.createClient(config.redisQ);

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
		.send({
			remoteSecret: config.remoteSecret
		})
		.set('Accept', 'application/json')
		.end(function(err, res){
			if (err) {
				return reject(err);
			}
			if (res.body.ok !== true) {
				return reject(new Error('Cannot get S3 credentials.'));
			}

			log.info('Process ' + process.pid + ' is running as an MTA-Worker.')

			var s3 = knox.createClient(res.body.data);

			return resolve(s3);

		});
	});
}

var getParseKey = function(path) {
	return path + ':parse';
}

var getAttachmentKey = function(path) {
	return path + ':attachment';
}

var getSingleAttachmentKey = function(path, filename) {
	return path + ':attachment:' + filename;
}

var setParseStatus = function(path, status) {
	return redisStore.setAsync(getParseKey(path), status)
}

var getParseStatus = function(path) {
	return redisStore.getAsync(getParseKey(path));
}

var setAttachmentStatus = function(path, status) {
	return redisStore.setAsync(getAttachmentKey(path), status)
}

var setSingleAttachmentStatus = function(path, filename, status) {
	if (typeof status === 'object') status = JSON.stringify(status);
	return redisStore.setAsync(getSingleAttachmentKey(path, filename), status)
}

var getAttachmentStatus = function(path) {
	return redisStore.getAsync(getAttachmentKey(path));
}

var getGarbageKeys = function(path) {
	return redisStore.keysAsync(path + ':*')
}

var getSingleAttachmentStatus = function(path, filename) {
	return redisStore.getAsync(getSingleAttachmentKey(path, filename)).then(function(res) {
		try {
			res = JSON.parse(res);
		}catch(e) {

		}
		return res;
	})
}

var enqueue = function(type, payload) {
	return messageQ.add({
		type: type,
		payload: payload
	}, config.Qconfig);
}

start()
.then(function(s3) {
	messageQ.process(function(job, done) {

		var data = job.data;
		var type = data.type;
		data = data.payload;

		log.info({ message: 'Received Job: ' + type, payload: data });

		var callback = function(err) {
			if (err) {
				log.error(err);
			}
			return done(err);
		}

		switch (type) {
			case 'processMail':

			var connection = data;
			var mailPath = connection.tmpPath;
			var mailParser = new MailParser({
				streamAttachments: true
			});

			var hasAttachments = false;

			mailParser.on('end', function (mail) {
				if (typeof mail.attachments !== 'undefined') {
					hasAttachments = true;
				}

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
				return setParseStatus(mailPath, 'no')
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
					return enqueue('parseMail', connection);
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

			try {
				fs.createReadStream(mailPath).pipe(mailParser);
			}catch(e) {
				log.error({ message: 'Create read stream in processMail throws an error', error: e});
				return callback(e);
			}

			break;

			case 'parseMail':

			var connection = data;
			var mailPath = connection.tmpPath;
			var mailParser = new MailParser({
				streamAttachments: true
			});

			mailParser.on('end', function (mail) {

				// dermail-smtp-inbound parseMailStream()

				if (!mail.text && !mail.html) {
					mail.text = '';
					mail.html = '<div></div>';
				} else if (!mail.html) {
					mail.html = helper.convertTextToHtml(mail.text);
				} else if (!mail.text) {
					mail.text = helper.convertHtmlToText(mail.html);
				}

				// dermail-smtp-inbound processMail();

				mail.connection = connection;
				mail.cc = mail.cc || [];
				mail.attachments = mail.attachments || [];
				mail.envelopeFrom = connection.envelope.mailFrom;
				mail.envelopeTo = connection.envelope.rcptTo;
				mail._date = _.clone(mail.date);
				mail.date = new Date().toISOString(); // Server time as received time

				return enqueue('storeMail', mail)
				.then(function() {
					// Tell the garbage collector that "parsing" is done
					return setParseStatus(mailPath, 'yes');
				})
				.then(function() {
					return callback();
				})
				.catch(function(e) {
					return callback(e);
				})
			});

			try {
				fs.createReadStream(mailPath).pipe(mailParser);
			}catch(e) {
				log.error({ message: 'Create read stream in parseMail throws an error', error: e});
				return callback(e);
			}

			break;

			case 'storeMail':

			var mail = data;
			mail.remoteSecret = config.remoteSecret;

			// Extra data to help with remote debugging
			mail.MTAExtra = {
				attemptsMade: job.attemptsMade,
				maxAttempts: job.attempts,
				delay: job.delay,
				jobId: job.jobId
			};

			var store = function(message) {
				return new Promise(function(resolve, reject) {
					request
					.post(config.rx.hook())
					.timeout(10000)
					.send(message)
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

			return store(mail)
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

				var attachmentPath = mailPath + '-' + attachment.contentId;

				try {
					var stream = fs.createWriteStream(attachmentPath);
					var attachmentTmp = attachment.stream.pipe(fs.createWriteStream(attachmentPath));
					attachmentTmp.on('finish', function() {
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
							//return callback(e);
						})
					})
				}catch(e) {
					log.error({ message: 'Create write stream in saveAttachmentsTemporary throws an error', error: e});
					return callback(e);
				}

			});

			mailParser.on('end', function(mail) {
				return callback();
			})

			try {
				fs.createReadStream(mailPath).pipe(mailParser);
			}catch(e) {
				log.error({ message: 'Create read stream in saveAttachmentsTemporary throws an error', error: e});
				return callback(e);
			}

			break;

			case 'uploadSingleAttachment':

			var connection = data.connection;
			var mailPath = connection.tmpPath;
			var attachment = data.attachment;

			var attachmentPath = mailPath + '-' + attachment.contentId;

			var uploadS3Stream = function(connection, attachment) {
				return new Promise(function(resolve, reject) {
					var headers = {
						'Content-Length': attachment.length,
						'Content-Type': attachment.contentType
					};

					var fileStream = fs.createReadStream(attachmentPath);

					s3.putStream(fileStream, '/' + attachment.checksum + '/' + attachment.generatedFileName, headers, function(err, res) {
						if (err) {
							return reject(err);
						}
						return resolve();
					})
				});
			}

			return uploadS3Stream(connection, attachment)
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
				getParseStatus(mailPath),
				getAttachmentStatus(mailPath),
				function(parse, attachment) {
					if (parse === 'yes' && attachment === 'yes') {
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
						return callback(new Error('Waiting for parse and upload to finish'));
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
