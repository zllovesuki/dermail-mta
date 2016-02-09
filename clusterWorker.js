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
		console.log('Starting a new worker...');
		spawn(i);
	});
}else{
	var messageQ = new Queue('dermail', config.redisQ.port, config.redisQ.host);
	var attachmentQ = new Queue('dermail-attachments', config.redisQ.port, config.redisQ.host);
	var s3 = knox.createClient(config.s3);

	messageQ.process(function(job, done) {
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

	console.log('Process ' + process.pid + ' is listening to all incoming requests.')
}
