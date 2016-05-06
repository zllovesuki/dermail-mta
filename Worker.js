var _ = require('lodash'),
	Queue = require('bull'),
	knox = require('knox'),
	redis = require('redis'),
	config = require('./config'),
	Promise = require('bluebird'),
	MailParser = require('mailparser').MailParser,
	helper = require('./helper'),
	request = require('superagent'),
	fs = Promise.promisifyAll(require('fs'));

Promise.promisifyAll(redis.RedisClient.prototype);

var messageQ = new Queue('dermail-mta', config.redisQ.port, config.redisQ.host);
var redisStore = redis.createClient(config.redisQ);
var debug = !!config.debug;

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
				if (debug) console.dir(res.body);
				return reject(new Error('Cannot get S3 credentials.'));
			}

			console.log('Process ' + process.pid + ' is running as an MTA-Worker.')

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
	if (debug) console.log('set parse:', path, status);
	return redisStore.setAsync(getParseKey(path), status)
}

var getParseStatus = function(path) {
	if (debug) console.log('get parse:', path);
	return redisStore.getAsync(getParseKey(path)).then(function(res) {
		return res;
	})
}

var setAttachmentStatus = function(path, status) {
	if (debug) console.log('set attachment:', path, status);
	return redisStore.setAsync(getAttachmentKey(path), status)
}

var setSingleAttachmentStatus = function(path, filename, status) {
	if (typeof status === 'object') status = JSON.stringify(status);
	if (debug) console.log('set attachment:', path, filename, status);
	return redisStore.setAsync(getSingleAttachmentKey(path, filename), status)
}

var getAttachmentStatus = function(path) {
	if (debug) console.log('get attachment:', path);
	return redisStore.getAsync(getAttachmentKey(path)).then(function(res) {
		return res;
	})
}

var getSingleAttachmentStatus = function(path, filename) {
	if (debug) console.log('get attachment:', path, filename);
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

		switch (type) {
			case 'processMail':

			if (debug) console.log('processMail started');

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
					return done();
				})
				.catch(function(e) {
					return done(e);
				});*/

				// But if we can't set redis for status, we want to abort early
				return setParseStatus(mailPath, 'no')
				.then(function() {
					if (!hasAttachments) return
					return Promise.map(mail.attachments, function(attachment) {
						delete attachment.stream;
						return setSingleAttachmentStatus(mailPath, attachment.generatedFileName, {
							checksum: attachment.checksum,
							length: attachment.length
						});
					}, { concurrency: 3 });
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
					if (debug) console.log('processMail done');
					return done();
				})
				.catch(function(e) {
					if (debug) console.error('processMail error', e);
					return done(e);
				});

			})

			fs.createReadStream(mailPath).pipe(mailParser);

			break;

			case 'parseMail':

			if (debug) console.log('parseMail started');

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
					if (debug) console.log('parseMail done');
					return done();
				})
				.catch(function(e) {
					if (debug) console.error('parseMail error', e);
					return done(e);
				})
			});

			fs.createReadStream(mailPath).pipe(mailParser);

			break;

			case 'storeMail':

			if (debug) console.log('storeMail started');

			var mail = data;
			mail.remoteSecret = config.remoteSecret;

			var store = function(message) {
				return new Promise(function(resolve, reject) {
					request
					.post(config.rx.hook())
					.timeout(10000)
					.send(message)
					.set('Accept', 'application/json')
					.end(function(err, res){
						if (err) {
							if (debug) console.log(err);
							return reject(err);
						}
						if (res.body.ok === true) {
							return resolve();
						}else{
							if (debug) console.dir(res.body);
							return reject(res.body);
						}
					});
				});
			}

			return store(mail)
			.then(function() {
				if (debug) console.log('storeMail done');
				return done();
			})
			.catch(function(e) {
				if (debug) console.error('storeMail error', e);
				return done(e);
			})

			break;

			case 'saveAttachmentsTemporary':

			if (debug) console.log('assign uploadAttachments started');

			var connection = data;
			var mailPath = connection.tmpPath;
			var mailParser = new MailParser({
				streamAttachments: true
			});

			mailParser.on('attachment', function(attachment, mail) {

				var attachmentPath = mailPath + '-' + attachment.generatedFileName;

				var attachmentTmp = attachment.stream.pipe(fs.createWriteStream(attachmentPath));

				attachmentTmp.on('finish', function() {
					return getSingleAttachmentStatus(mailPath, attachment.generatedFileName)
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
						if (debug) console.error('assign uploadSingleAttachment error', e);
						//return done(e);
					})
				})

			});

			mailParser.on('end', function(mail) {
				if (debug) console.log('End of attachment parse');
				return done();
			})

			fs.createReadStream(mailPath).pipe(mailParser);

			break;

			case 'uploadSingleAttachment':

			var connection = data.connection;
			var mailPath = connection.tmpPath;
			var attachment = data.attachment;

			if (debug) console.log('uploadSingleAttachment started', mailPath, attachment.generatedFileName);

			var attachmentPath = mailPath + '-' + attachment.generatedFileName;

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
				return setSingleAttachmentStatus(mailPath, attachment.generatedFileName, 'yes');
			})
			.then(function() {
				return fs.unlinkAsync(attachmentPath);
			})
			.then(function() {
				if (debug) console.log('uploadSingleAttachment done', mailPath, attachment.generatedFileName);
				return done();
			})
			.catch(function(e) {
				if (debug) console.error('uploadSingleAttachment error', e);
				return done(e);
			})

			break;

			case 'checkUploadStatus':

			var connection = data.connection;
			var mailPath = connection.tmpPath;
			var attachments = data.attachments;

			var attachmentDone = true;

			return Promise.map(attachments, function(attachment) {
				return getSingleAttachmentStatus(mailPath, attachment.generatedFileName)
				.then(function(status) {
					if (debug) console.log(mailPath, attachment.generatedFileName, 'not yet uploaded');
					if (typeof status === 'object') attachmentDone = false;
				})
			}, { concurrency: 3 });
			.then(function() {
				if (attachmentDone) {
					if (debug) console.log(mailPath, 'all uploaded');
					return setAttachmentStatus(mailPath, 'yes')
					.then(function() {
						return done();
					})
				}else{
					return done(new Error('Waiting for all files to be uploaded'));
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
					if (debug) console.log(parse, attachment);
					if (parse === 'yes' && attachment === 'yes') {
						return fs.unlinkAsync(mailPath)
						.then(function() {
							if (debug) console.log('garbage collected');
							return done();
						})
						.catch(function(e) {
							if (debug) console.log('cannot unlink tmpPath');
							return done(e);
						})
					}else{
						if (debug) console.log('garbage not yet collected');
						return done(new Error('Waiting for parse and upload to finish'));
					}
				}
			)

			break;
		}
	});
})
.catch(function(e) {
	if (debug) console.log(e);
})
