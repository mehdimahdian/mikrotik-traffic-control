# Mikrotik Traffic Control - remove everything the base setup created.   (c) Kish IT - https://kish-it.com
# Removes every object whose comment starts with [mtc-block], [mtc-ipblock] or [mtc-guest] (rules, NAT, address lists, guest DHCP, pool, address)
# and enables FastTrack again. Queues, the hotspot and the API user are removed from the dashboard or by hand (see the end of this file).
# Take a backup first:  /export file=before-mtc-remove

/ip firewall filter remove [find where comment~"^\\[mtc-(block|ipblock|guest)\\]"]
/ip firewall raw remove [find where comment~"^\\[mtc-ipblock\\]"]
/ip firewall nat remove [find where comment~"^\\[mtc-guest\\]"]
/ip firewall address-list remove [find where comment~"^\\[mtc-guest\\]"]
/ip dhcp-server remove [find where comment~"^\\[mtc-guest\\]"]
/ip dhcp-server network remove [find where comment~"^\\[mtc-guest\\]"]
/ip pool remove [find where comment~"^\\[mtc-guest\\]"]
/ip address remove [find where comment~"^\\[mtc-guest\\]"]
/ip firewall filter enable [find where action=fasttrack-connection]

# Optional, by hand:
#   /queue simple remove [find where name~"^mtc-"] ; /queue type remove [find where name~"^mtc-"]
#   /ip hotspot remove [find where name="mtc-hotspot"] ; /ip hotspot profile remove [find where name="mtc-guest"]
#   /system script remove [find where name~"^mtc-cfg-"]   (the shared configuration stored by the program)
#   /user remove [find where comment~"Mikrotik Traffic Control"] ; /user group remove mtc ; /ip service set api address=""
