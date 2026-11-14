# Project status: Mikrotik Traffic Control

_Last updated: 2026-11-14._ Open work: [TODO.md](TODO.md) · History: [CHANGELOG.md](CHANGELOG.md) · Agent rules: [CLAUDE.md](CLAUDE.md)

## Resume here

**2026-11-14: unreleased work committed locally, not pushed.** The work after 1.0.0 (shared configuration on the router,
per-PC API users, one-step sign-in with REST fallback, sign out, narrow-screen fixes) is committed (`0e7ef6a`) together with
this file, `CLAUDE.md` and `TODO.md`. 25 tests pass, syntax check passes; fa misses 126 of 939 strings, ar, ru and zh 148 each.
**Next:** owner pushes `main` (public), then TODO 1 (translations) and TODO 2 (release 1.1.0).

## Current state

| | |
|---|---|
| Released | **1.0.0** (2026-11-10), Windows installer + portable zip on GitHub Releases |
| Unreleased | see `CHANGELOG.md` *Unreleased* |
| Languages (`i18n:check`, 939 strings) | en complete; fa 813 (126 missing); ar, ru, zh 791 (148 missing each) |
| Git | `main`, public `github.com/mehdimahdian/mikrotik-traffic-control`; local commits ahead of `origin` until the owner pushes |
