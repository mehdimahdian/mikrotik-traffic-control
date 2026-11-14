# Mikrotik Traffic Control: agent guide

Public, MIT-licensed product: live traffic monitoring, usage quotas, bandwidth control, guest Wi-Fi and security alerts for
MikroTik RouterOS, in five languages (en, fa, ar, ru, zh). Pick up work at `PROJECT_STATUS.md` → **Resume here**; open
work in `TODO.md`; history and unreleased notes in `CHANGELOG.md`.

## Commands

```sh
npm test                 # node --test test/*.test.js (against a mock router)
npm run lint             # syntax check
npm run i18n:check       # translation coverage per language
npm run demo             # demo without a router
npm run build:rsc        # after src/setup.js changes: regenerates routeros/mtc-base.rsc and mtc-remove.rsc
```

Releases: `docs/RELEASING.md` (tag push → GitHub Actions builds the Windows installer and zip).

## Rules

- **This repository is public.** No site-specific facts (addresses, hostnames, network names, user names), no credentials,
  no customer or guest data, in code, docs, tests or commit messages. Examples use MikroTik defaults (`192.168.88.1`) and
  documentation ranges. Notes about any particular installation live outside this repo.
- **Pushing, tagging and releasing are maintainer decisions:** commit locally and leave the push to the owner unless asked.
- Router passwords are never stored on the router (`mtc-cfg-*` scripts hold settings only); runtime data and `secret.key`
  stay in the git-ignored `data/`.
- Every user-facing string goes through i18n; Persian and Arabic are RTL. Run `npm run i18n:check` after UI changes.
- Changes to what the program writes on a router come with a matching removal in `routeros/mtc-remove.rsc` (and `build:rsc`).
- After a meaningful change: `CHANGELOG.md` *Unreleased*, `PROJECT_STATUS.md` Resume here, `TODO.md`.
