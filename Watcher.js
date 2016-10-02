var	config = require('./config'),
    fs = require('fs'),
    pm2 = require('pm2'),
	log;

if (!!config.graylog) {
	log = require('bunyan').createLogger({
		name: 'MTA-Watcher',
		streams: [{
			type: 'raw',
			stream: require('gelf-stream').forBunyan(config.graylog.host, config.graylog.port)
		}]
	});
}else{
	log = require('bunyan').createLogger({
		name: 'MTA-Watcher'
	});
}

var letsencrypt = config.letsencrypt;

pm2.connect(function(err) {
    if (err) {
        log.error('Cannot connect to pm2 daemon');
    }
    log.info('Process ' + process.pid + ' is running to watch for let\'s encrypt cert changes.')
    fs.watch('/etc/letencrypt/live/' + letsencrypt, function(event, filename) {
        log.info('/etc/letencrypt/live/' + letsencrypt, 'changes detected, restarting MTA...')
        pm2.restart('MTA', function(proc, err) {
            if (err) {
                log.error('Cannot restart MTA.')
            }
        })
    })
})
