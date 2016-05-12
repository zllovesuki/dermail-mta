var	Queue = require('bull'),
	config = require('./config');

var messageQ = new Queue('dermail-mta', config.redisQ.port, config.redisQ.host);

var minutes = config.cleanInterval,
	the_interval = minutes * 60 * 1000;

setInterval(function() {
	messageQ.clean(5000);
	messageQ.on('cleaned', function (job, type) {
		console.log('Cleaned %s %s jobs on', job.length, type, new Date().toISOString());
	});
}, the_interval)

console.log('Process ' + process.pid + ' is running to clean up garbase in the queue every ' + minutes + ' minutes.')
