### Installing MTA

Before your installation of MTA, make sure that you have completed the check list first:

1. Obtain a hosted/on-premise S3 bucket for attachments
2. Setup up API (refers to dermail-api's INSTALL.md)
3. Setup MTA (which is this guide)
4. Setup TX
5. Setup Webmail

### Setup MTA

1. `npm install` and `npm install pm2 -g`
2. You need to have a BIND running locally for the SPAMHAUS Zen queries. This can be done by running the `BIND.sh` if you are running on Debian
3. Setup up Let's Encrypt's `certbot`. Refers to https://certbot.eff.org for instructions on your OS. Make sure that you select "none of the above" for the webserver as this is for SMTP.
4. Configure MTA with a `config.json` file
    ```json
    {
            "redisQ":{
                    "host": "127.0.0.1",
                    "port": 6379
            },
            "remoteSecret": "[remote secret set in API]",
            "apiEndpoint": "https://[api endpoint]",
            "letsencrypt": "[hostname of this machine/letencrypt domain]"
    }
    ```
5. Start the MTA with `pm2 start app.json`
