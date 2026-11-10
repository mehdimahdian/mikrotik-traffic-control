# Use cases

Working hours, networks and limits for common kinds of business. Pick the type in the setup guide to preload the hours; everything is editable afterwards.

## Hotel / guest house (24/7)

* **Networks:** staff PCs and staff Wi-Fi = *Staff*; guest Wi-Fi = *Guests*; add servers (PMS, door locks, room controllers) to *Servers that scan on purpose*.
* **Hours:** *Open 24/7* - front desk, housekeeping, security and night staff work around the clock.
* **Router setup:** block rules, isolated guest network, FastTrack off.
* **Limits:** guests 4M/2M per device by default (Bandwidth control), usage quota 6 GB/day download then *throttled* 24 h; staff 20M/10M.
* **Guest Wi-Fi portal:** packages per room class, reference = room, card at check-in.

## Office / company

* **Hours:** Monday-Friday 08:00-17:00 (adjust to your week). Off-hours usage of staff devices is flagged.
* **Networks:** office LAN/VLANs = *Staff*; visitor Wi-Fi = *Guests*.
* **Limits:** staff default 20M/10M, auto-throttle for sustained >= 15 Mbps for 5 min (guests only).

## Restaurant / cafe

* **Hours:** daily 10:00-23:00 for the staff network (POS, tablets, kitchen printers).
* **Guest Wi-Fi portal:** one package (e.g. 3M, 2 devices), codes valid for 3 hours, printed on the receipt; walled garden = your online menu.
* **Limits:** guests 2M/1M, quota 2 GB per day.

## Residential building / home network (24/7)

* **Hours:** *Open 24/7*.
* **Networks:** residents' own devices = *Staff* (or one network per floor); visitor Wi-Fi = *Guests*.
* **Limits:** usage quota per device per period (e.g. 50 GB per 7 days, then 1M for 24 h) stops a single user from taking the whole line.

## School / university / clinic

* **Hours:** Monday-Friday 07:30-15:30. Devices active at night are flagged.
* **Guests:** visitor and patient Wi-Fi with a portal, short codes.
* **Limits:** block P2P by blocking offenders from the Security tab; throttle the heaviest downloaders.

## Shop / retail

* **Hours:** daily 09:00-21:00 for POS and back-office PCs. Customer Wi-Fi as guests with a free-package portal.
