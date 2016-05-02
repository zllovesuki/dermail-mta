#!/bin/sh

apt-get install bind9 dnsutils -y

echo "nameserver 127.0.0.1" > /etc/resolv.conf

echo 'acl goodclients {
        localhost;
        localnets;
};

options {
        directory "/var/cache/bind";

        recursion yes;
        allow-query { goodclients; };

	dnssec-enable yes;
	dnssec-validation yes;

        auth-nxdomain no;    # conform to RFC1035
};' > /etc/bind/named.conf.options 

systemctl restart bind9
