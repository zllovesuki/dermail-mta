var Queue = require('bull'),
	config = require('./config'),
	knox = require('knox'),
	attachmentHelper = require('./attachmentHelper'),
	request = require('superagent'),
	cluster = require('cluster'),
	numCPUs = require('os').cpus().length;

if (cluster.isMaster) {
	var workers = [];

	var spawn = function(i) {
    	workers[i] = cluster.fork();
	};

	for (var i = 0; i < numCPUs; i++) {
		spawn(i);
	}
	cluster.on('online', function(worker) {
		console.log('Worker ' + worker.process.pid + ' is online.');
    });
	cluster.on('exit', function(worker, code, signal) {
		console.log('Worker ' + worker.process.pid + ' died with code: ' + code + ', and signal: ' + signal);
	});
}else{
	var messageQ = new Queue('dermail', config.redisQ.port, config.redisQ.host);
	var attachmentQ = new Queue('dermail-attachments', config.redisQ.port, config.redisQ.host);

	request
	.post(config.rx.s3())
	.timeout(10000)
	.send({
		remoteSecret: config.remoteSecret
	})
	.set('Accept', 'application/json')
	.end(function(err, res){
		if (err) {
			throw err;
		}
		if (res.body.ok !== true) {
			console.dir(res.body);
			throw new Error('Cannot get S3 credentials.');
		}
		var s3 = knox.createClient(res.body.data);

		messageQ.process(function(job, done) {

			job.data.remoteSecret = config.remoteSecret;

			request
			.post(config.rx.hook())
			.timeout(10000)
			.send(job.data)
			.set('Accept', 'application/json')
			.end(function(err, res){
				if (err) {
					console.log(err);
					return done(err);
				}
				if (res.body.ok === true) {
					return done();
				}else{
					console.dir(res.body);
					return done(res.body)
				}
			});
		});

		attachmentQ.process(function(job, done) {
			var headers = {
				'Content-Length': job.data.length,
				'Content-Type': job.data.contentType
			};
			var fileStream = attachmentHelper.bufferToStream(job.data.content.data);

			s3.putStream(fileStream, '/' + job.data.checksum + '/' + job.data.generatedFileName, headers, function(err, res) {
				if (err) {
					return done(err);
				}
				done();
			});
		});

		console.log('Process ' + process.pid + ' is listening to all incoming requests.');

	});
}
