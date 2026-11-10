# Configuration

Settings are per router (**Configuration** tab) except language, organization name and logo (header). Everything is saved in the router's data folder.

## General

* **Staff networks / Guest networks** - router interface names (e.g. `ether2, VLAN90-Office`). A device belongs to the network its address is in. *Staff* = your own people and devices; *Guests* = visitors, customers, residents' guests. Anything else is "Other".
* **Admin PCs** - never blocked, never limited, never flagged for probing the router.
* **Servers that scan on purpose** - monitoring servers, controllers: ignored by the security alerts.

## Working hours and abuse limits

Configuration > *Working hours & abuse limits* (or Abuse tab > *Limits & working hours*):

* **Open 24/7** (hotels, hospitals, always-open shops): every minute counts as working time; nothing is "off-hours".
* **Weekly schedule**: a start and end for each weekday you work (0 = Sunday ... 6 = Saturday; the order shown follows the language). A window that ends before it starts (22:00-06:00) runs overnight and is counted on the day it starts.
* Limits: busy minute (MB/min), busy minutes per day, GB per working day (staff), GB per day (guests), upload GB per day, "N times the median", concurrent connections (guests).

The **Abuse** tab then lists devices over the limits (internet traffic only): staff inside the working hours, guests all day, with the reasons and a *Block* / *Limit* button.

## Bandwidth control

Configuration > *Bandwidth control*. Nothing is enforced until you turn the **master switch** on, press *Preview*, and *Apply* (an export is saved first). Limits apply to **internet traffic only**.

1. **Profiles** - named rates, e.g. `staff-default 20M down / 10M up`, `throttled 1M / 512k`, `unlimited` (0 = exempt).
2. **Default rule per group** - one PCQ queue per network group: *every device* gets its own copy of the rate (new devices are covered at once).
3. **Users** - a person with several devices (addresses) and a profile; overrides the group rule.
4. **Auto-throttle** - when a device averages >= X Mbps download for N minutes (1-15), apply a profile for M minutes, for chosen groups.
5. **Usage quota** - see below.

*Device overrides* lists individual limits (manual, auto-throttle, quota) with their end time. The **Limit** button next to every device sets a temporary limit (until midnight, 1 h, 24 h ... or until removed).

### Usage quota: slow the heavy users for 24 hours

*Enabled*, a **period** (per day, resetting at midnight, or the last 2/3/7/14/30 days), limits for **download**, **upload** and/or **total** in GB (0 = not checked), the **profile** to apply, **how long** (default 1440 min = 24 h), the **groups** it applies to (default Guests) and a list of exempt devices.

* Counts internet traffic per device address. Checked every ~15 s.
* A device that passes a limit gets a `mtc-dev-<ip>` queue with the profile; it is released by itself when the time is over.
* After a limit, usage is counted again **from the next day**, so a device is not limited twice for the same traffic; if you remove a limit by hand, the device is not re-limited the same day.
* Skipped: admin PCs, the scan-ignore list, devices already limited (manually or by auto-throttle), user entries, exempt devices.
* The table *Closest to the quota now* shows who is near the limit - tune the numbers with it before enabling.
* Every limit is recorded in the **Audit** tab (action "Usage quota passed - limited", by "usage quota").

## Names and groups

Double-click a device name to rename it (stored per router). Names otherwise come from DHCP host-name/comment, then reverse DNS (the router, or your internal DNS server). Import a CSV: `pwsh tools/import-names-csv.ps1 -File names.csv`. Optional user labels (for example from 802.1X / Active Directory): `routers/<id>/user-labels.json` with `{"AA:BB:CC:DD:EE:FF": "jsmith"}`; shown next to the device.

## Presence (Online / Offline)

Static DHCP leases (printers, cameras, controllers, access points ...) are watched: online when they move traffic or answer ARP/ping, offline after failed ARP, or 6 minutes of silence plus two failed pings (guests: 30 min). History of outages, uptime, a watch list per device.

## Security tab

One row per device: every event combined, how many times each kind happened, the worst severity, last seen; click a row for the individual events, *Ack all* per device. Plus the router's own traps (port scanners, SSH/telnet brute force), the router log (who is knocking), whois lookups and **Block** for internet addresses (single or /16-/32 ranges, with a timeout).

## Reports

Reports tab: today / yesterday / week / month / last month / 30 days / custom, English, Persian, Arabic, Russian, Chinese (or English + Persian). Printable A4 with your organization name and logo; use *Print / Save as PDF*. Put your logo (PNG) at `<data folder>/org-logo.png`.

## Retention

Per-minute rows 31 days; hourly and daily rows forever; destinations 120 days; audit trail forever.
