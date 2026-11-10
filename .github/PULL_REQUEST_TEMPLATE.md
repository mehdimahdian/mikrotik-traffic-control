## What and why

<!-- One or two sentences. Link the issue: "Fixes #123". -->

## Type

- [ ] Bug fix
- [ ] Feature
- [ ] Translation (language: ___ )
- [ ] Documentation
- [ ] Other

## Checklist

- [ ] `npm test` and `npm run lint` pass
- [ ] Router-side changes are previewable, idempotent, tagged (`mtc-` / `[mtc-...]`), backed up first and removable - and covered by a test against `test/mock-router.js`
- [ ] No secrets, real network details or site-specific names in code, docs, screenshots or test data
- [ ] New user-visible text works in English; translations added or noted (`node tools/i18n-check.js`)
- [ ] Right-to-left layout checked if the UI changed (Persian or Arabic)
- [ ] Docs and `CHANGELOG.md` updated
