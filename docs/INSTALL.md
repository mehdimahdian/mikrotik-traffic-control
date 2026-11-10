# Installation

## What you need

| | |
|---|---|
| **Router** | MikroTik, RouterOS 6.43 or newer (7.x recommended). The API service (default port 8728) must be reachable from the PC that runs the program. |
| **Computer** | Windows 10/11 for the installer and tray icon. Linux and macOS also work (run from source, no tray icon). It must stay on: it collects the history. |
| **Software** | Node.js **22.5 or newer** (built-in `node:sqlite`). The Windows Setup.exe bundles it. There is no `npm install` and no third-party dependency. |
| **Network** | The PC reaches the router's API port. The dashboard itself only listens on `127.0.0.1:8787` of that PC. |

## Windows

### Option A - Setup.exe (easiest)

1. Open the **[latest release](https://github.com/mehdimahdian/mikrotik-traffic-control/releases/latest)** and download `MikrotikTrafficControl-<version>-Setup.exe` (it bundles Node.js; nothing else to install). Optionally verify it against `SHA256SUMS.txt` (`Get-FileHash <file>`).
2. Run it. By default it installs **for the current user** (no administrator rights); the first dialog offers **Install for all users** (needs administrator rights and puts the program under Program Files, shortcuts for everyone). History and settings are always per Windows user.
3. Tick *Start with Windows* if you want the tray icon at sign-in. The setup guide opens at the end.

Windows SmartScreen may warn about an unsigned installer the first time (*More info* > *Run anyway*), until the project's releases are code-signed.

### Option B - zip

1. Unzip `MikrotikTrafficControl-<version>-win-x64.zip` anywhere.
2. Double-click `windows\Install.cmd` (or run `powershell -ExecutionPolicy Bypass -File windows\install.ps1`).
   If Node.js 22.5+ is not found and the zip does not bundle it, the script offers to install Node.js LTS with `winget`.
3. Options: `-TargetDir <path>`, `-StartWithWindows`, `-NoShortcuts`, `-NoLaunch`, `-InstallNode`.

What the installer does: copies the program to `%LOCALAPPDATA%\Programs\Mikrotik Traffic Control`, creates the data folder `%LOCALAPPDATA%\Mikrotik Traffic Control\data`, makes shortcuts and starts the tray agent. The tray agent shows a Kish IT splash, starts the program hidden, shows live Mbps in the tooltip, restarts the program if it dies and pops up a balloon for new high-severity security alerts.

### Portable mode

Create an empty file `portable.flag` in the program folder: data is then kept in `<program folder>\data` instead of `%LOCALAPPDATA%`. Router logins are encrypted with the Windows user's DPAPI key, so a portable copy only works for the same Windows user on the same PC (re-enter the router password on another PC).

### Update

Run the new installer / `install.ps1` over the old one. The program folder is replaced, **the data folder is never touched**.

### Uninstall

Start Menu > Mikrotik Traffic Control > Uninstall (or `windows\uninstall.ps1`; add `-RemoveData` to delete history and settings too).
Changes the program made **on the router** stay there: remove them first from the dashboard (Router setup > *Remove everything*, Configuration > Bandwidth control > *Remove all*, Guest Wi-Fi > *Remove everything*) or run `routeros/mtc-remove.rsc`. See [ROUTEROS.md](ROUTEROS.md).

## Linux / macOS / from source

```bash
git clone <this repository> mikrotik-traffic-control
cd mikrotik-traffic-control
node --version          # must be v22.5 or newer
npm start               # dashboard: http://127.0.0.1:8787   (data in ./data, override with MTC_DATA=/path)
```

On these systems router passwords are encrypted with AES-256-GCM using a key file `data/secret.key` (mode 600): protect the data folder like a password store.

### Run as a service (Linux, systemd)

```ini
# /etc/systemd/system/mtc.service
[Unit]
Description=Mikrotik Traffic Control
After=network-online.target

[Service]
User=mtc
WorkingDirectory=/opt/mikrotik-traffic-control
Environment=MTC_DATA=/var/lib/mtc
ExecStart=/usr/bin/node src/manager.js
Restart=always

[Install]
WantedBy=multi-user.target
```

`sudo systemctl enable --now mtc`. Open the dashboard from another machine through an SSH tunnel (`ssh -L 8787:127.0.0.1:8787 server`), not by exposing the port (see [SECURITY.md](../SECURITY.md)).

### Run as a service (Windows, without a logged-in user)

The tray agent starts at sign-in. For an always-on server, use Task Scheduler ("At startup", run whether the user is logged on or not) with `node.exe src\manager.js` and the environment variable `MTC_DATA`. Note that DPAPI-encrypted router passwords can only be decrypted by the same Windows account that saved them.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MTC_PORT` | `8787` | Dashboard port (always bound to `127.0.0.1`) |
| `MTC_DATA` | `<repo>/data` (Windows installer: `%LOCALAPPDATA%\Mikrotik Traffic Control\data`) | Data folder |
| `MTC_POLL_MS` | `3000` | Router polling interval of the collectors |

## Data and backups

Everything lives in the data folder:

```
settings.json            organization name, business type, language
routers.json             router list (passwords encrypted)
org-logo.png             optional: your logo (shown in the header, reports, guest cards)
routers/<id>/traffic.db  history (SQLite)
routers/<id>/*.json      per-router configuration: config, qos, setup, hotspot, names, staff, watch
```

Back up the folder while the program is stopped (or copy `traffic.db` together with its `-wal` file). History is kept: per-minute rows 31 days, hourly and daily rows forever.

## Check that it works

`npm test` runs end-to-end tests against a fake router. `npm run demo` starts the program against that fake router so you can click through every screen.
