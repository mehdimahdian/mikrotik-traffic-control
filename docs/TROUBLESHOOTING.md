# Troubleshooting

| Problem | Cause / fix |
|---|---|
| Setup guide: *Connection refused* | The API service is off or on another port. Winbox: **IP > Services > api** (8728), or run `routeros/mtc-init.rsc`. Check that this PC is in the service's *Available From* list. |
| *No answer from the router* | Wrong address, or a firewall between the PC and the router drops tcp/8728 (add an input accept for this PC). |
| *Login failed* | Wrong user/password, or the user's group lacks `api`. Use *Create a dedicated API user* with an administrator login. |
| "The login lacks permissions: write" | The user can read but not write: blocking, queues and the hotspot need `write`. Use the `mtc` group or add the policy. |
| Dashboard shows "Cannot read the router" | The collector cannot reach the API (router rebooted, address changed, IP restriction of the API user). It retries every 5 s. Edit the router in *Manage routers*. |
| Speed limits do nothing | FastTrack is enabled (Router setup warns): disable it. Also check the master switch is on and the queues were applied (state on the router, *Queues on the router*). |
| A blocked phone is not really blocked | It uses a private/random Wi-Fi address and changed IP/MAC. Give it a static DHCP lease or turn off *Private Wi-Fi address* for your SSID. |
| Block buttons say the rule is not on the router | Open **Router setup**, tick *Block internet...*, Apply. |
| Everybody on the guest Wi-Fi lost the internet after enabling the portal | Expected until they log in: use *grandfather minutes* when enabling, and issue codes first. *Disable* restores access at once. |
| Access points disappeared after enabling the portal | They were not in *Never see the portal*. Disable the portal, add them (MAC or address), prepare again. |
| Hotspot cannot be prepared: "No DHCP address pool found" | The guest interface needs a DHCP server with a pool (Router setup > guest network, or your own). |
| Device names are blank | Names come from DHCP host-name/comment, then reverse DNS. Set an internal DNS server in the setup guide, rename by double-click, or import a CSV. |
| "Cannot decrypt the saved password" in the log | The data folder was copied to another PC/Windows user. Edit the router and enter the password again. |
| The page is blank / old after an update | Hard refresh (Ctrl+F5); the program serves with `no-store`, so a proxy or the app window cache is the usual culprit. |
| Port 8787 is in use | Another copy is running (tray icon), or set `MTC_PORT`. |
| Windows: PowerShell script blocked | Run through the shortcut or `powershell -ExecutionPolicy Bypass -File ...`. |
| Persian/Arabic text looks mirrored wrongly | Open an issue with a screenshot; numbers and addresses are meant to stay left-to-right, see [I18N.md](I18N.md). |

Logs: `<data folder>/manager.log(.err)` and `<data folder>/routers/<id>/monitor.log`.
Start with a clean slate: stop the program, rename the data folder, start again (the setup guide returns).
