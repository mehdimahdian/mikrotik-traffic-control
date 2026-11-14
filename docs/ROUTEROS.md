# The router side

## Requirements

* RouterOS 6.43+ (plain-text API login) or 7.x. Developed and tested on RouterOS 7.19.
* The **API service** (`/ip service`, `api`, port 8728) enabled and reachable from the PC that runs the program. If your input firewall drops everything not listed, allow that PC to reach tcp/8728.
* A user with these policies: `read`, `write`, `api` (plus `test`, `ftp`, `policy`, `sensitive` for ping, config exports and some tables). The setup guide / `mtc-init.rsc` creates the group **`mtc`** with `read,write,api,test,ftp,policy,sensitive` and the user **`mtc-monitor`**. No ssh, telnet, winbox, web, reboot, password or sniff.
* Clock: set NTP (`/system ntp client`) - hotspot code expiry and timeouts rely on it.

## A brand-new router

Two ways to prepare it:

1. **Setup guide** (recommended): enter the router address and an administrator login once; the program creates the group and user over the API with a random password (kept encrypted, never shown).
2. **Script**: edit the password in `routeros/mtc-init.rsc` (the setup guide can download it with the address of this PC filled in) and paste it into a Winbox terminal. It creates the group and user, opens the API service for this PC only, and adds one input accept rule for the API.

Then in the dashboard open **Router setup** to create the rest:

| Part | What is created on the router |
|---|---|
| *Block internet for single devices* | `filter` forward drop: `src-address-list=MTC-Blocked-Clients`, `out-interface=<WAN>`, comment `[mtc-block] ...`, placed first in the forward chain. The list is empty until you press Block. |
| *Block internet addresses* | `raw` prerouting, two rules `[mtc-ipblock]`: drop from `MTC-Blocked-IPs` coming in on the WAN; drop to `MTC-Blocked-IPs` going out from the LAN. The list is empty. |
| *Disable FastTrack* | `/ip firewall filter disable` on rules with `action=fasttrack-connection` (never deleted; remembered, and re-enabled by *Remove everything*). Required for speed limits. |
| *Isolated guest network* | `/ip address` on the chosen interface, `/ip pool mtc-guest-pool`, `/ip dhcp-server network` + `/ip dhcp-server mtc-guest-dhcp`, srcnat masquerade for the guest subnet, address list `mtc-private` (10/8, 172.16/12, 192.168/16) with a forward drop *guests -> private*, and two input rules so guests reach the router only for DNS/DHCP (the hotspot login page keeps working). All tagged `[mtc-guest]`. |

The tab shows the state of every item (*done* / *missing*), the exact list of changes, a **Download as .rsc script** link (same changes as a RouterOS script you can review and run yourself), **Apply** and **Remove everything this program created**. Before any apply or removal a configuration export is saved on the router (`mtc-before-setup-<time>.rsc` / `mtc-before-remove-<time>.rsc`). Applying twice changes nothing the second time.

`routeros/mtc-base.rsc` is an example of the generated script (WAN `ether1`, guest network on `ether5`); `routeros/mtc-remove.rsc` removes everything tagged by hand.

## What the program writes to the router

Reads: connection table (every 3 s), ARP, DHCP leases, addresses, interfaces, routes, firewall lists, queues, log, hotspot state.

Writes - only on your action in the dashboard (or the *expiry* of something you created):

| Feature | Objects | Names / tags |
|---|---|---|
| Block device | address-list entry + cut that client's connections | list `MTC-Blocked-Clients`, comment `[mtc-block] <name> (...)`, optional timeout |
| Block internet address | address-list entry | list `MTC-Blocked-IPs`, comment `[mtc-ipblock] ...`, optional timeout |
| Speed limits / quota | queue types and simple queues, **only toward the internet interface** | `mtc-up-<profile>`, `mtc-down-<profile>`, `mtc-group-<id>`, `mtc-dev-<ip>`; comment `[mtc-qos]` |
| Router setup | see the table above | `[mtc-block]`, `[mtc-ipblock]`, `[mtc-guest]`, `mtc-guest-pool`, `mtc-guest-dhcp`, `mtc-private` |
| Guest hotspot | hotspot server, profile, user profiles (packages), walled garden, ip-bindings, users (access codes), html pages, optional logo fetch | `mtc-hotspot`, `mtc-guest`, `mtc-<package>`, comments `[mtc-hotspot]`, `[mtc-hotspot-gf]` |
| Backups | `/export` before applying | `mtc-before-setup-*`, `before-qos-*`, `before-hotspot-*` |

Rule of thumb: everything created starts with `mtc-` or has a comment starting `[mtc-`. The program never edits or deletes anything else (FastTrack is only disabled, on request).

## Rollback

* Router setup tab: **Remove everything this program created**.
* Configuration > Bandwidth control: **Disable all limits now** (kill switch, keeps objects) or **Remove all from router**.
* Guest Wi-Fi: **Disable** (everybody gets the internet again) or **Remove everything**.
* Or by hand: `routeros/mtc-remove.rsc`; the restore point is the `*.rsc` export taken before the change (`/system reset-configuration` is never needed).

## Good to know

* **FastTrack** and speed limits cannot work together (fast-tracked packets skip queues). The program warns and offers to disable it.
* **Queues only affect internet traffic**: every queue has `dst=<WAN interface>`. LAN traffic is never limited.
* The WAN interface is the interface of the active default route (PPPoE, DHCP client, static, LTE, VLAN, bridge...). Override it in Router setup / Bandwidth control if the router has several uplinks.
* Devices are tracked by IP. Phones with a private (random) Wi-Fi address that change MAC need a static DHCP lease to be blocked/limited reliably. The *VPN & MACs* tab shows who rotates.
* IPv4 only.

## Shared configuration (`mtc-cfg-*` scripts)

So that every PC sees the same setup, the program stores its configuration on the router: organization name and type, logo (up to 400 KB), router name / DNS, and the per-router files `config`, `qos`, `setup`, `setup-state`, `hotspot`, `names`, `staff`, `watch`, `user-labels`. They are written as gzip + base64 chunks into `/system/script` entries named `mtc-cfg-<revision>-<nnn>` (policy `read`, never executed, comment `[mtc-config]`). A new revision is written completely before the old one is removed. **Passwords are never stored**, and traffic history stays on each PC.

Every 30 s each PC compares its copy with the router: its own changes are saved, changes made from another PC are loaded (the collector restarts); if both changed, the newer one wins. A new PC that connects to a router carrying this data is offered **Join** in the setup guide and skips all questions. Remove with `/system script remove [find where name~"^mtc-cfg-"]`.
