var self = module.exports = {
	redisQ: {
		host: '127.0.0.1',
		port: 6379
	},
	Qconfig: {
		attempts: 10,
		backoff: {
			type: 'exponential',
			delay: 2000
		}
	},
	s3: require('./config.json').s3,
	base: require('./config.json').base,
	rx: {
		hook: function() {
			return self.base + '/rx/store';
		},
		checkRecipient: function() {
			return self.base + '/rx/check-recipient';
		}
	}
}
