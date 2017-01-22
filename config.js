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
    graylog: require('./config.json').graylog || null,
    cleanInterval: require('./config.json').cleanInterval || 10,
    tmpDir: require('./config.json').tmpDir,
    mailSizeLimit: require('./config.json').mailSizeLimit,
    remoteSecret: require('./config.json').remoteSecret,
    letsencrypt: require('./config.json').letsencrypt,
    apiEndpoint: function() {
        var apiEndpoint = require('./config.json').apiEndpoint;
        return apiEndpoint + '/v' + self.apiVersion;
    },
    rx: {
        s3: function() {
            return self.apiEndpoint() + '/rx/get-s3';
        },
        hook: function() {
            return self.apiEndpoint() + '/rx/process-from-raw';
        },
        checkRecipient: function() {
            return self.apiEndpoint() + '/rx/check-recipient';
        },
        greylist: function() {
            return self.apiEndpoint() + '/rx/greylist';
        }
    }
}
