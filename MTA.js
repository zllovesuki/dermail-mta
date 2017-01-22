var    _ = require('lodash'),
    Queue = require('bull'),
    config = require('./config'),
    Promise = require('bluebird'),
    request = require('superagent'),
    dns = Promise.promisifyAll(require('dns')),
    fs = Promise.promisifyAll(require('fs')),
    isFQDN = require('is-fqdn'),
    log;

var resolv = fs.readFileSync('/etc/resolv.conf', {encoding: 'utf-8'});
if (resolv.indexOf('127.0.0.1') === -1) {
    fs.writeFileSync('/etc/resolv.conf', 'nameserver 127.0.0.1')
    // Exception throw is expected here
}

var MTA = require('dermail-smtp-inbound');
var messageQ = new Queue('dermail-mta', config.redisQ.port, config.redisQ.host);

var penalty = 20 * 1000; // 20 seconds

if (!!config.graylog) {
    log = require('bunyan').createLogger({
        name: 'MTA',
        streams: [{
            type: 'raw',
            stream: require('gelf-stream').forBunyan(config.graylog.host, config.graylog.port)
        }]
    });
}else{
    log = require('bunyan').createLogger({
        name: 'MTA'
    });
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

var checkMapping = function(connection) {
    return new Promise(function(resolve, reject) {
        if (!isFQDN(connection.hostNameAppearsAs)) {
            log.info({ message: 'Connection rejected (invalid hostname)', connection: connection });
            var error = new Error('Invalid Hostname');
            error.responseCode = 530;
            return reject(error)
        }
        /*
        Godsent Microsoft pulls shits like this:
        clientHostname: mail-by2nam03on0082.outbound.protection.outlook.com
        hostNameAppearsAs: nam03-by2-obe.outbound.protection.outlook.com
        Their explantion given (https://support.microsoft.com/en-us/help/3019655/recipient-rejects-mail-from-exchange-online-or-exchange-online-protection,-and-you-receive-a-host-name-does-not-match-the-ip-address-error)
        is utterly bullshit (it doesn't match)
        Therefore, we will relax the matching by dropping the host
        (e.g. 1.b.c.d and 2.b.c.d will match)

        Then we have fucking Facebook
        clientHostname: 66-220-144-143.outmail.facebook.com
        hostNameAppearsAs: mx-out.facebook.com

        we will now do a if-not-match-delay-for-20-seconds
        */
        return checkARecord(connection.remoteAddress, connection.hostNameAppearsAs).then(function(AValid) {
            if (connection.clientHostname === connection.hostNameAppearsAs && AValid === true) {
                log.info({ message: 'Connection accepted (valid IP-Domain mapping)', connection: connection });
                return resolve();
            }
            log.info({ message: 'Invalid IP-Domain mapping, giving 20 seconds delay', connection: connection });
            connection.delay = true;
            return resolve();
        })
    });
}

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

var checkSpamhaus = function(connection) {
    return new Promise(function(resolve, reject) {
        var remoteAddress = connection.remoteAddress;
        spamhausZen(remoteAddress)
        .then(function(rejection) {
            log.info({ message: 'Connection rejected by Spamhaus', connection: connection, spamhaus: rejection });
            var error = new Error('Your IP is Blacklisted by Spamhaus');
            error.responseCode = 530;
            return reject(error)
        })
        .catch(function(acceptance) {
            log.info({ message: 'Connection accepted (spamhaus ok)', connection: connection, spamhaus: acceptance });
            return resolve();
        })
    });
}

var validateSender = function(email, connection) {
    return new Promise(function(resolve, reject) {
        checkMapping(connection).then(function() {
            if (connection.delay) {
                log.info({ message: 'Delaying Spamhaus check', connection: connection})
                setTimeout(function() {
                    checkSpamhaus(connection).then(resolve).catch(reject)
                }, penalty)
            }else{
                checkSpamhaus(connection).then(resolve).catch(function(e) {
                    setTimeout(function() {
                        reject(e)
                    }, penalty);
                })
            }
        }).catch(function(e) {
            setTimeout(function() {
                reject(e)
            }, penalty);
        })
    })
}

var checkARecord = function(ip, domain) {
    return dns.resolve4Async(domain).then(function(ips) {
        return ips.indexOf(ip) !== -1
    }).catch(function(e) {
        return false;
    })
}

var checkRecipient = function(email, connection) {
    return new Promise(function(resolve, reject) {
        return request
        .post(config.rx.checkRecipient())
        .timeout(4500)
        .set('X-remoteSecret', config.remoteSecret)
        .send({
            to: email
        })
        .set('Accept', 'application/json')
        .end(function(err, res){
            if (err) {
                // Service not available, we will let it slide
                log.error({ message: 'Service (recipient) not available', error: err.response.body });
                return resolve();
            }
            if (res.body.ok === true) {
                log.info({ message: 'Recipient accepted (recipient)', email: email, connection: connection });
                return resolve();
            }else{
                log.info({ message: 'Recipient rejected (recipient)', email: email, connection: connection });
                var error = new Error('Recipient address rejected: User unknown in local recipient table');
                error.responseCode = 550;
                return reject(error);
            }
        });
    })
}

var checkGreylist = function(triplet) {
    return new Promise(function(resolve, reject) {
        return request
        .post(config.rx.greylist())
        .timeout(4500)
        .set('X-remoteSecret', config.remoteSecret)
        .send(triplet)
        .set('Accept', 'application/json')
        .end(function(err, res){
            if (err) {
                // Service not available, we will let it slide
                log.error({ message: 'Service (greylist) not available', error: err.response.body });
                return resolve();
            }
            if (res.body.ok === true) {
                log.info({ message: 'Recipient accepted (greylist)', triplet: triplet });
                return resolve();
            }else{
                log.info({ message: 'Recipient temporaily rejected (greylist)', triplet: triplet });
                var error = new Error('Greylisted: Please try again later')
                error.responseCode = 451;
                return reject(error)
            }
        });
    });
}

var validateRecipient = function(email, connection) {
    return new Promise(function(resolve, reject) {
        if (connection.delay) {
            log.info({ message: 'Delaying recipient check', connection: connection})
            setTimeout(function() {
                checkRecipient(email, connection).then(function() {
                    return checkGreylist({
                        ip: connection.remoteAddress,
                        from: connection.envelope.mailFrom.address,
                        to: email
                    })
                }).then(resolve).catch(reject)
            }, penalty)
        }else{
            checkRecipient(email, connection).then(function() {
                return checkGreylist({
                    ip: connection.remoteAddress,
                    from: connection.envelope.mailFrom.address,
                    to: email
                })
            }).then(resolve).catch(function(e) {
                setTimeout(function() {
                    reject(e)
                }, penalty);
            })
        }
    });
}

var queueProcess = function(connection) {
    connection.date = new Date().toISOString();
    log.info({ message: 'Mail ready for process', connection: connection });
    return messageQ.add({
        type: 'processMail',
        payload: connection
    }, config.Qconfig)
}

var mailReady = function(connection) {
    return new Promise(function(resolve, reject) {
        if (connection.delay) {
            log.info({ message: 'Delaying data process', connection: connection})
            setTimeout(function() {
                queueProcess(connection).then(resolve).catch(resolve)
            }, penalty)
        }else{
            queueProcess(connection).then(resolve).catch(resolve)
        }
    })
}

/*
    So, in short,
    1. Validation of DNS - by dermall-smtp-inbound
    2. Check for IP-Domain Mapping
        - If it matches, no delay is given
        - It it does not match, a 20 seconds delay is imposed
    3. Check for Spamhaus (after 20 seconds delay if applicable)
    4. Check for envelope recipient
    5. Check for greylist (after 20 seconds delay if applicable)
    6. Mail ready to be processed by API-Worker
*/

var letsencrypt = config.letsencrypt;

MTA.start({
    doNotParse: true,
    port: process.env.PORT || 25,
    tmp: config.tmpDir || '/tmp',
    handlers: {
        onError: function(err) {
            log.error({ message: 'SMTP Server returns an error', error: err })
        },
        validateSender: validateSender,
        validateRecipient: validateRecipient,
        mailReady: mailReady
    },
    smtpOptions: {
        logger: (typeof process.env.DEBUG !== 'undefined'),
        size: config.mailSizeLimit || 52428800, // Default 50 MB message limit
        // Notice that this is the ENTIRE email. Headers, body, attachments, etc.
        banner: 'Dermail.net, by sdapi.net',
        key: fs.readFileSync('/etc/letsencrypt/live/' + letsencrypt + '/privkey.pem'),
        cert: fs.readFileSync('/etc/letsencrypt/live/' + letsencrypt + '/fullchain.pem')
    }
});

log.info('Process ' + process.pid + ' is listening to incoming SMTP.')
