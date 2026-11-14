# TODO

Open work, in order.

**Definition of Done:** `npm test`, `npm run lint` and `npm run i18n:check` pass; new UI strings in every language file
(en and fa at least, the others marked missing); router-side changes have a removal path in `routeros/mtc-remove.rsc`;
`CHANGELOG.md` *Unreleased* updated; nothing site-specific in the repo (it is public).

## Now

1. **Translations** (`npm run i18n:check`): fa misses 126 of 939 strings, ar, ru and zh 148 each. Persian first (there
   is a Persian README edition), then the others, or mark the gap in the README.
2. **Release 1.1.0** with the *Unreleased* notes (shared configuration, per-PC API users, sign-in, sign out), per
   `docs/RELEASING.md`, once the owner has pushed `main`.

## Next

3. Tests for the REST fallback path (`src/restapi.js`) and the shared-configuration sync (`src/routerstore.js`) beyond the
   e2e happy path: conflict between two PCs, router without write rights.
