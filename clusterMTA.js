var	_ = require('lodash'),
	Queue = require('bull'),
	config = require('./config'),
	Promise = require('bluebird'),
	request = require('superagent'),
	cluster = require('cluster'),
	numCPUs = require('os').cpus().length;
	dns = Promise.promisifyAll(require('dns')),
	fs = Promise.promisifyAll(require('fs'));

if (cluster.isMaster) {
	var workers = [];

	var spawn = function(i) {
    	workers[i] = cluster.fork();
	};

	var resolv = fs.readFileSync('/etc/resolv.conf', {encoding: 'utf-8'});
	if (resolv.indexOf('127.0.0.1') === -1) {
		fs.writeFileSync('/etc/resolv.conf', 'nameserver 127.0.0.1')
		// Exception throw is expected here
	}

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
	var MTA = require('dermail-smtp-inbound');
	var messageQ = new Queue('dermail', config.redisQ.port, config.redisQ.host);
	var attachmentQ = new Queue('dermail-attachments', config.redisQ.port, config.redisQ.host);

	var validateRecipient = function(email, envelope) {
		return new Promise(function(resolve, reject) {
			return request
			.post(config.rx.checkRecipient())
			.timeout(5000)
			.send({to: email})
			.set('Accept', 'application/json')
			.end(function(err, res){
				if (err) {
					// Service available, we will let it slide
					return resolve();
				}
				if (res.body.hasOwnProperty('ok')) {
					return resolve();
				}else{
					return reject(new Error('Invalid'));
				}
			});
		})
	}

	var mailReady = function(mail) {
		return new Promise(function(resolve, reject) {
			mail.attachments.forEach(function (attachment) {
				var tmpAttachment = _.cloneDeep(attachment);
				delete attachment.content;
				attachmentQ.add(tmpAttachment, config.Qconfig);
			});
			messageQ.add(mail, config.Qconfig);
			return resolve();
		})
	}

	var reverseIP = function(ip) {
		var array = ip.split('.');
		array.reverse();
		return array.join('.');
	}

	var spamhausReturnCodes = {
		'127.0.0.2': 'SBL - Spamhaus Maintained',
		'127.0.0.3': '- - reserved for future use',
		'127.0.0.4': 'XBL - CBL Detected Address',
		'127.0.0.5': 'XBL - NJABL Proxies (customized)',
		'127.0.0.6': 'XBL - reserved for future use',
		'127.0.0.7': 'XBL - reserved for future use',
		'127.0.0.8': 'XBL - reserved for future use',
		'127.0.0.9': '- - reserved for future use',
		'127.0.0.10': 'PBL - ISP Maintained',
		'127.0.0.11': 'PBL - Spamhaus Maintained',
	} // http://zee.balogh.sk/?p=881

	var spamhausZen = function(ip) {
		return new Promise(function(resolve, reject) {
			ip = reverseIP(ip);
			var query = ip + '.zen.spamhaus.org';
			return dns
			.resolve4Async(query)
			.then(resolve)
			.catch(reject);
		})
	}

	var validateConnection = function(connection) {
		return new Promise(function(resolve, reject) {
			var remoteAddress = connection.remoteAddress;
			return spamhausZen(remoteAddress)
			.then(function(rejection) {
				console.log(connection, rejection)
				return reject(new Error('Your IP is Blacklisted by Spamhaus'))
			})
			.catch(function(acceptance) {
				return resolve();
			})
		})
	}

	MTA.start({
		port: process.env.PORT || 25,
		handlers: {
			validateConnection: validateConnection,
			validateRecipient: validateRecipient,
			mailReady: mailReady
		},
		smtpOptions: {
			size: 26214400, // 50 MB message limit
			banner: 'Dermail.net, by sdapi.net',
			key: fs.readFileSync(__dirname + '/ssl/key'),
			cert: fs.readFileSync(__dirname + '/ssl/chain')
		}
	});

	console.log('Process ' + process.pid + ' is listening to all incoming requests.')
}
