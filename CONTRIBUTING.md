# Contributing

Thank you for helping! Mikrotik Traffic Control is MIT licensed and has **no runtime dependencies** - please keep it that way (Node 22.5+, built-in modules only; the dashboard stays plain HTML/JS/CSS with no build step).

New here? Good first contributions: **a translation** (plain JSON), a documentation fix, a device classifier, or a test. Look for the `good first issue` label.

## Quick start

```bash
git clone https://github.com/mehdimahdian/mikrotik-traffic-control && cd mikrotik-traffic-control
npm test            # end-to-end tests against a fake RouterOS (about 10 s)
npm run lint        # syntax check of every script, page and JSON file
npm run demo        # the dashboard with synthetic traffic - http://127.0.0.1:8787 (no router needed)
```

Edit files in `src/` and refresh the browser: the dashboard is served straight from `src/public` (no build, no cache). Restart `npm run demo` after changing server code.

## Where things are

| You want to... | Look at |
|---|---|
| change what is created on a router | `src/setup.js` (base setup), `src/qos.js` (queues, quota), `src/hotspot.js` (guest portal) |
| add an API endpoint | `src/server.js` (collector) - routes are near the end of the file |
| change a screen | `src/public/index.html` (tabs), `src/public/app-ext.js` (wizard, Router setup, working hours) |
| translate | `src/public/i18n/<lang>.json` - see [docs/I18N.md](docs/I18N.md) |
| change the Windows installer | `windows/` - see [docs/RELEASING.md](docs/RELEASING.md) |

More: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Guidelines

* **Router changes** must be previewable, idempotent, tagged (`mtc-` name or `[mtc-...]` comment), backed up first and removable. Add the operation to `src/setup.js` (or `qos.js` / `hotspot.js`) so the dashboard and the `.rsc` export stay in sync, and cover it in `test/e2e.test.js` against `test/mock-router.js` (extend the mock when it lacks a command).
* **Never log or store secrets.** No passwords, keys or communities in files, logs, API responses, screenshots or test data.
* **Business-neutral wording.** The product serves offices, hotels, restaurants, residences, schools and clinics: say "guests / visitors" and "staff"; no vendor- or site-specific names, addresses or defaults.
* **Translations.** English text is the key. New user-visible text must work in English; add translations when you can; untranslated text falls back to English. Keep `{placeholders}` exactly. For right-to-left layout use logical CSS (`margin-inline-start`, `text-align: start`) and keep numbers and addresses left-to-right.
* **Screenshots** in docs come from `npm run demo` only (synthetic data).
* **Code style.** Plain modern JavaScript, `'use strict'`, no transpiling, comments for the *why*. Small focused pull requests.

## Pull requests

1. Fork, create a branch (`fix/...`, `feat/...`, `i18n/<lang>`).
2. Make the change with tests; run `npm test`, `npm run lint` and `node tools/i18n-check.js`.
3. Update `CHANGELOG.md` (under *Unreleased*) and the docs if behaviour changed.
4. Open the pull request; the template has the checklist. CI runs on Linux and Windows with Node 22 and 24.

Commit messages: a short imperative summary (`Add quota exemption list`), details in the body if needed.

## Reporting bugs and ideas

Use the issue forms. Include the version, RouterOS version and whether it reproduces with `npm run demo`. **Do not paste passwords, API keys, public addresses or customer data.** Security problems: see [SECURITY.md](SECURITY.md).

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).
