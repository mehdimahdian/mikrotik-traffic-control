# Mikrotik Traffic Control - prepare a (new) MikroTik router for the program.            (c) Kish IT - https://kish-it.com
#
# What it does (nothing else on the router is changed):
#   1. creates the user group "mtc" with the permissions the program needs (no ssh/telnet/winbox/web/reboot/password/sniff),
#   2. creates the API user "mtc-monitor" in that group, allowed to log in from the PC %PC_ADDRESS% only,
#   3. turns the API service (port 8728) on for that PC only,
#   4. lets that PC reach the router's API in the firewall INPUT chain (needed only if your firewall drops everything not listed).
#
# The program downloads this file with a generated password already filled in; just run it. (Run by hand? replace the password line below with 16+ random characters.)
#
# Run it:  Winbox > New Terminal > paste everything, or upload the file and run  /import file-name=mtc-init.rsc
# Undo:    /user remove mtc-monitor ; /user group remove mtc ; /ip service set api address="" ; /ip firewall filter remove [find where comment~"mtc-api"]

:local pc "%PC_ADDRESS%"
:local pw "CHANGE-ME-TO-A-LONG-RANDOM-PASSWORD"   ;# <== CHANGE ME

:if ($pw = "CHANGE-ME-TO-A-LONG-RANDOM-PASSWORD") do={ :error "Edit the script first: set a real password on the line marked CHANGE ME" }

/user group
:if ([:len [find name="mtc"]] = 0) do={ add name=mtc policy=read,write,api,test,ftp,policy,sensitive comment="Mikrotik Traffic Control" } else={ set [find name="mtc"] policy=read,write,api,test,ftp,policy,sensitive }

/user
:if ([:len [find name="mtc-monitor"]] = 0) do={ add name=mtc-monitor group=mtc password=$pw address=$pc comment="Mikrotik Traffic Control (API only)" } else={ set [find name="mtc-monitor"] group=mtc password=$pw address=$pc }

/ip service
set api disabled=no port=8728 address=$pc

# Firewall: only needed when your INPUT chain drops everything not listed (the usual default configuration already accepts the LAN).
# The rule is placed first so the PC can always reach the API; remove it if your LAN is already accepted.
/ip firewall filter
:if ([:len [find where comment~"mtc-api"]] = 0) do={ add chain=input action=accept protocol=tcp dst-port=8728 src-address=$pc comment="[mtc-api] Mikrotik Traffic Control PC -> router API" place-before=0 }

:put "Done. Go back to the program and press: I ran the script - continue."
