var self = module.exports = {
	apiVersion: 2,
	redisQ: require('./config.json').redisQ,
	Qconfig: {
		attempts: 50,
		backoff: {
			type: 'exponential',
			delay: 2000
		}
	},
	debug: require('./config.json').debug,
	remoteSecret: require('./config.json').remoteSecret,
	s3: require('./config.json').s3,
	apiEndpoint: function() {
		var apiEndpoint = require('./config.json').apiEndpoint;
		return apiEndpoint + '/v' + self.apiVersion;
	},
	rx: {
		s3: function() {
			return self.apiEndpoint() + '/rx/get-s3';
		},
		hook: function() {
			return self.apiEndpoint() + '/rx/store';
		},
		checkRecipient: function() {
			return self.apiEndpoint() + '/rx/check-recipient';
		}
	}
}
