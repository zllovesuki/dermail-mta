var	Queue = require('bull'),
	config = require('./config'),
	log;

var messageQ = new Queue('dermail-mta', config.redisQ.port, config.redisQ.host);

if (!!config.graylog) {
	log = require('bunyan').createLogger({
		name: 'MTA-GC',
		streams: [{
			type: 'raw',
			stream: require('gelf-stream').forBunyan(config.graylog.host, config.graylog.port)
		}]
	});
}else{
	log = require('bunyan').createLogger({
		name: 'MTA-GC'
	});
}

var minutes = config.cleanInterval,
	the_interval = minutes * 60 * 1000;

messageQ.on('cleaned', function (job, type) {
	log.info('Cleaned %s %s jobs', job.length, type);
});

setInterval(function() {
	messageQ.clean(5000);
}, the_interval)

log.info('Process ' + process.pid + ' is running to clean up garbage in the queue every ' + minutes + ' minutes.')
