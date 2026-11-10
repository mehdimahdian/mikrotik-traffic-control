# Security

## Model

* The dashboard and its API listen on **127.0.0.1 only** and reject requests whose `Host` or `Origin` is not local. There is **no login screen**: anyone who can reach the port (or use the PC) can change router settings through it. Do not publish the port. To use it from another computer, use an SSH tunnel or a remote desktop session to the PC, or put an authenticating reverse proxy in front yourself.
* The router login is a dedicated user (`mtc-monitor`, group `mtc`) created by the setup guide, with no ssh/telnet/winbox/web/reboot/password/sniff rights, optionally limited to this PC's address. The administrator login typed in the wizard is used once in memory and never written anywhere.
* **Router passwords are stored encrypted**, never in plain text: Windows DPAPI (bound to the Windows user and PC) or AES-256-GCM with `data/secret.key` (mode 600) on other systems. Passwords are passed to collectors through their environment and removed there at once; they never appear in logs or API responses.
* No credentials, SNMP communities, WiFi keys or private keys are written to project files or the router config by this program (the access codes of the guest portal are random hotspot users on the router).
* Router changes require an explicit action, are previewed, are preceded by a configuration export, and are tagged for removal. The block / quota features never act on admin PCs or the router's own addresses; internet-address blocks refuse private addresses, the router's public address, the ISP gateway and DNS servers in use.
* The program talks to your router(s) and resolves names: reverse-DNS lookups of the internet addresses your devices talk to go through the PC's normal DNS resolver (and optionally your internal DNS server for local names). The *Whois* button additionally sends **only the address being looked up** to RDAP (`rdap.org` and the registries) and to Team Cymru's ASN DNS service. Nothing else leaves the PC.

## Hardening checklist

* Keep the PC patched and access to it restricted; the data folder holds history and the encrypted logins.
* Restrict the API service on the router to this PC (`/ip service set api address=<PC>/32`) and keep it off the internet.
* Prefer *Only allow the new user to log in from this PC* in the setup guide.

## Reporting a vulnerability

Please report privately to Kish IT (<https://kish-it.com>) rather than in a public issue, with steps to reproduce. We will acknowledge within a few days.
