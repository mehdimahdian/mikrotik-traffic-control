# TODO

Open work, in order.

**Definition of Done:** `npm test`, `npm run lint` and `npm run i18n:check` pass; new UI strings in every language file
(en and fa at least, the others marked missing); router-side changes have a removal path in `routeros/mtc-remove.rsc`;
`CHANGELOG.md` *Unreleased* updated; nothing site-specific in the repo (it is public).

## Now

1. **Translations:** done for the 1.0.0 → 1.1.0 strings on 2026-11-14 (wizard, shared configuration, sign out) in fa, ar,
   ru and zh. `i18n:check` still lists ~114 entries per language: code fragments, units, brand and language names the
   extractor cannot tell from text; leave them. Native-speaker review of ar, ru and zh is welcome.
2. **Release 1.1.0** with the *Unreleased* notes (shared configuration, per-PC API users, sign-in, sign out), per
   `docs/RELEASING.md`.

## Next

3. Tests for the REST fallback path (`src/restapi.js`) and the shared-configuration sync (`src/routerstore.js`) beyond the
   e2e happy path: conflict between two PCs, router without write rights.
