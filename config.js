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
	s3: require('./config.json').s3,
	apiEndpoint: function() {
		var apiEndpoint = require('./config.json').apiEndpoint;
		return apiEndpoint + '/v' + self.apiVersion;
	},
	rx: {
		hook: function() {
			return self.apiEndpoint() + '/rx/store';
		},
		checkRecipient: function() {
			return self.apiEndpoint() + '/rx/check-recipient';
		}
	}
}
