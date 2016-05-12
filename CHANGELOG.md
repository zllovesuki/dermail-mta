### Changelog

05/11/2016: 3.0.0 -> 3.1.0
1. New process to clean up the Redis queue using Bull's clean() method
2. By default, the process will clean up "completed" jobs every 10 minutes, you can change the interval in `config.json` with key `cleanInterval`
