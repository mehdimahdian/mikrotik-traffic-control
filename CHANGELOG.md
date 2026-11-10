# Changelog

All notable changes to this project. Format based on [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## Unreleased

* Translations completed for Persian, Arabic, Russian and Chinese (about 75 % of the extracted strings; the rest are code fragments and a few long help paragraphs that fall back to English).
* Fix: dynamic content was not translated after switching language without reloading.
* Release automation: a version tag builds the Windows installer (Setup.exe, per user or all users) and the portable zip with checksums and publishes them.
* Documentation: illustrated README with screenshots and notes in all five languages; contributor files (code of conduct, issue and pull-request templates, releasing guide), translation sanity tests.

## 1.0.0

First public release.

* Live traffic per device (fixed graph, scrolling list, today's total per device), history, staff usage, destinations, external IPs with whois, VPN and private-MAC detection, presence (online/offline) of fixed devices.
* Security tab with all events of a device combined and counted; abuse detection with **configurable working hours (24/7 or per weekday)**; audit trail; printable reports.
* Bandwidth control (PCQ per device per group, users, auto-throttle) and **usage quota**: per-day or per-period download/upload limits that slow a device for 24 hours.
* Guest Wi-Fi captive portal with packages, access codes, cards, walled garden; works for any business with temporary guests.
* **Router setup**: block rules, FastTrack handling and an isolated guest network created on a fresh MikroTik, previewed, backed up, removable; exportable as `.rsc`; `routeros/mtc-init.rsc` prepares a new router.
* First-run **setup wizard** with business-type presets; dedicated least-privilege API user created with a one-time administrator login.
* **5 languages** (en, fa, ar, ru, zh) with proper right-to-left layout; splash screen; Windows installer and tray agent.
* Generic by design: no site-specific defaults; everything created on the router is tagged `mtc-` / `[mtc-...]`.
