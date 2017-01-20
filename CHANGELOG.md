### Changelog

01/20/2017: 4.x -> 4.3.0
1. Greylisting is now enabled. dermail-api@4.4.0+ required

06/28/2016: 3.x -> 4.0.0
1. Mails are now processed at API instead of at MTA. Please make sure that S3 is setup correctly, and you are running dermail-api version 3.0.0+

06/02/2016: 3.1.x -> 3.2.0
1. MTA will now verify DKIM Signature if it exists

05/11/2016: 3.0.0 -> 3.1.0
1. New process to clean up the Redis queue using Bull's clean() method
2. By default, the process will clean up "completed" jobs every 10 minutes, you can change the interval in `config.json` with key `cleanInterval`
