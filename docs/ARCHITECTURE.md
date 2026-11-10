# Architecture

```
 Browser (dashboard, http://127.0.0.1:8787)
        |
   manager.js  -- serves src/public, org settings, router list (+ encrypted passwords),
        |         wizard calls: inspect / provision / test, proxies /api/r/<id>/api/* to the right collector
        |
   server.js x N  (one process per router, own data folder)
        |   polls the RouterOS API every 3 s -> SQLite (traffic.db) + in-memory state
        |   security detection, abuse report, presence, quota, queue / hotspot / setup logic
        v
   MikroTik router (RouterOS API, port 8728)
```

* **Zero dependencies.** Node 22.5+ with `node:sqlite`; the dashboard is plain HTML/JS/CSS (no build step).
* **One collector per router** keeps routers isolated (own database, configuration, crash domain). `manager.js` restarts a collector that exits.
* **The dashboard only talks to the manager**, which listens on `127.0.0.1` and rejects requests with a foreign `Host` or `Origin` (DNS-rebinding / CSRF guard). POST bodies must be JSON.

## Source files

| File | Role |
|---|---|
| `src/manager.js` | HTTP server, settings (`settings.json`), router list (`routers.json`), secrets at rest (Windows DPAPI / AES-256-GCM), worker supervision, wizard endpoints |
| `src/server.js` | Collector: connection-table polling, per-device accounting, history, names, presence, security events, abuse report, external IPs + whois, blocking, quota, audit trail, all collector HTTP endpoints |
| `src/rosapi.js` | RouterOS API client (sentence encoding, login, serialized requests) |
| `src/routerinfo.js` | WAN detection, router inspection, least-privilege user provisioning |
| `src/setup.js` | The router-side base setup as data: desired objects, plan, status, rollback, export as `.rsc` |
| `src/qos.js` | Bandwidth control: profiles, groups, users, auto-throttle, **usage quota** validation, desired queues and plan |
| `src/hotspot.js` | Guest portal: configuration, pages in 5 languages, desired objects, plan, readiness checks |
| `src/classify.js`, `security.js`, `whois.js` | Destination type estimate, security detectors, RDAP/ASN lookups |
| `src/public/index.html` | The dashboard (all tabs); `app-ext.js` splash, wizard, Router setup tab, working-hours editor; `i18n.js` + `i18n/*.json` translations; `report.html` printable report |

## Accounting

Every poll reads `/ip/firewall/connection/print` (original and reply byte counters, plus FastTrack counters). Deltas are attributed to the **LAN device address** (the real client even for NATed networks) and split Internet vs LAN by whether the remote is public. Rates are smoothed over 3 s polls. Rows: per minute (31 days), hourly and daily (kept forever), destinations per day (120 days).

## Router writes

Only through four code paths, all idempotent and previewed: `setup.js` (base setup), `qos.js` via `server.js` (queues), `hotspot.js` via `server.js` (portal), and block/unblock (address lists). Everything is tagged `[mtc-...]` / `mtc-...`. See [ROUTEROS.md](ROUTEROS.md).

## Data

`traffic.db` tables: `m` per-minute, `h` hourly, `d` daily per device; `cc` concurrent connections; `x` per-device peaks; `rm` remote destinations; `sec` security events; `aud` audit trail; `qev` limit/quota events; `pres`, `pe`, `upt` presence and uptime; `ipw` whois cache; `extlog` router-log addresses; `vpn` tunnel usage; `macs` MAC history; `names` device names; `ptr` reverse-DNS cache. JSON files: see [INSTALL.md](INSTALL.md).

## HTTP API (collector, via `/api/r/<id>/api/...`)

Read: `live`, `ring`, `history`, `ranking`, `staff`, `abuse`, `security`, `blocked`, `presence`, `destnow`, `dest`, `extips`, `whois`, `vpn`, `macs`, `audit`, `report`, `qos`, `qos/plan`, `setup`, `setup/rsc`, `hotspot`, `hotspot/plan`, `hotspot/preview`, `config`, `status`.
Write (JSON POST): `name`, `staff`, `block`, `unblock`, `ipblock`, `ipunblock`, `secack`, `secignore`, `watch`, `config`, `qos/config|apply|off|remove|device|device/clear`, `setup/config|apply|remove`, `hotspot/config|apply|pages|enable|disable|remove|kick|account|account/revoke`.
Manager: `GET/POST /api/settings`, `GET /api/routers`, `POST /api/routers[/test|/inspect|/provision|/delete]`, `GET /api/init-script`.

## Tests

`test/mock-router.js` is a small stateful fake RouterOS API server (login, print/add/set/remove/enable/disable for the resources used, synthetic clients with growing counters). `test/e2e.test.js` starts the real manager and collector against it: wizard calls, provisioning, live data, router setup (apply, idempotence, FastTrack, remove), working hours, quota, hotspot from scratch. `npm run demo` runs the same fake router for a hands-on trial.
