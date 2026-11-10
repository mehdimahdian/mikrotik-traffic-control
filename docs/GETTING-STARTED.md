# Getting started: from an empty install to a working system

When no router is configured, the **setup guide** opens by itself. It has five steps; you can go back at any time and nothing on the router changes until the last step plus your explicit confirmations in *Router setup*.

## 1. Welcome

Choose the **language** (English, فارسی, العربية, Русский, 中文 - you can change it later in the header), type your **organization name** (shown in the header, reports and guest cards) and the **type of business**. The type only presets your working hours and the names offered; you can edit everything afterwards.

| Type | Preset working hours |
|---|---|
| Office / company | Monday-Friday 08:00-17:00 (Saturday-Wednesday for Persian, Sunday-Thursday for Arabic) |
| Hotel / hospitality | **24/7** |
| Restaurant / cafe | every day 10:00-23:00 |
| Shop / retail | every day 09:00-21:00 |
| Residential building / home | **24/7** |
| School / university / clinic | Monday-Friday 07:30-15:30 |
| Other | Monday-Friday 08:00-17:00 |

## 2. Router

Enter the router address (usually the gateway of your network, e.g. `192.168.88.1`) and the API port (8728).

**Create a dedicated API user for me** (recommended): enter a router administrator login. It is used **once**, in memory, to create the group `mtc` and the user `mtc-monitor` with a random password; the program stores only that new password, encrypted. Optionally the new user is restricted so it can log in only from this PC.
Group permissions: `read, write, api, test, ftp, policy, sensitive` - no `ssh`, `telnet`, `winbox`, `web`, `reboot`, `password` or `sniff`.

**I already have an API user:** type its name and password.

**Brand-new router, API closed?** Open the *brand-new router* section: type the address of this PC, download `mtc-init.rsc`, edit the password line and paste it into a Winbox terminal. It enables the API service for this PC only and creates the user. Then continue with "I already have an API user".

The guide then *inspects* the router (read-only): name, RouterOS version, internet interface, networks and DHCP servers, FastTrack, the permissions of the login, and the address of this PC as the router sees it.

## 3. Networks

Every router network (interface with an address) is listed. Mark each as **Staff** (your own people and devices), **Guests** (visitors, customers, residents' guests) or **Ignore**. The internet interface is detected from the active default route and shown as *Internet (WAN)*. Networks whose name or comment contains *guest, wifi, visitor, hotspot, public* are pre-selected as guests.

Also here: the **admin PC address** (prefilled; this device can never be blocked or limited by mistake) and an optional **internal DNS server** (used for reverse-DNS names of PCs).

## 4. Working hours

Choose **Open 24/7** (every minute counts as working time; nothing is "off-hours") or a **weekly schedule** with a start/end for each weekday. A window that ends before it starts (22:00-06:00) runs overnight. Staff usage outside these hours is reported separately in the Abuse tab; guests are always judged all day.

## 5. Finish

The router is saved (encrypted), collection starts and your choices are stored. You land on **Router setup**.

## What to do next

1. **Router setup** - pick what to create on the router and press *Save and preview*, then *Apply*:
   * *Block internet for single devices* (the **Block** buttons) and *Block internet addresses* (attackers): one filter rule and two raw rules, lists start empty - nobody is blocked.
   * *Disable FastTrack* - required for speed limits (FastTrack bypasses queues). Rules are only disabled.
   * *Create an isolated guest network* - on a free interface: address, DHCP server and pool, NAT, isolation from your private networks. Needed for a guest portal on a fresh router.
2. **Configuration > Bandwidth control** - set default speeds per group, per-user limits, auto-throttle and the **usage quota**; preview; apply.
3. **Guest Wi-Fi** - prepare and enable the captive portal ([HOTSPOT.md](HOTSPOT.md)).
4. Name devices: double-click a name in the live list. Import names from a CSV with `tools/import-names-csv.ps1`.
5. Reports: **Reports** tab, pick a period and a language.

You can re-run the guide any time by deleting the router in *Manage routers* (its history folder stays on disk).
