# Releasing (maintainers)

Releases are built by GitHub Actions: push a version tag and the workflow publishes the **Windows installer**, the **portable zip** and checksums on the Releases page, so users only ever need to click *Download*.

## Cut a release

1. Update `version` in `package.json` and move the *Unreleased* notes in `CHANGELOG.md` under the new version.
2. `npm test && npm run lint && node tools/i18n-check.js`
3. `node tools/build-rsc.js` if `src/setup.js` changed (regenerates `routeros/mtc-base.rsc` / `mtc-remove.rsc`).
4. Commit, then tag and push:
   ```bash
   git tag v1.0.0 && git push origin main --tags
   ```
5. The **Release** workflow (`.github/workflows/release.yml`, Windows runner) runs the tests, installs Inno Setup, bundles the runner's `node.exe` and runs `windows/build-release.ps1`, then attaches to the release:
   * `MikrotikTrafficControl-<version>-Setup.exe` - single installer (per user; "all users" offered in the first dialog)
   * `MikrotikTrafficControl-<version>-win-x64.zip` - portable zip with `windows\Install.cmd`
   * `SHA256SUMS.txt`
6. Edit the generated release notes if you like.

## Build locally (Windows)

```powershell
powershell -File windows\build-release.ps1 -NodeExe "C:\Program Files\nodejs\node.exe"
```

Output in `dist\`. Without `-NodeExe` the package needs Node.js 22.5+ on the target PC; without Inno Setup 6 only the zip is built.

## Moving or forking the repository

Links, badges and `package.json` point to `mehdimahdian/mikrotik-traffic-control`. If you move or fork the project, run:

```bash
node tools/set-repo.js <owner>/<repo>
```

## Code signing (optional)

Unsigned installers trigger a Windows SmartScreen warning at first. To sign, add your certificate as a repository secret and a `signtool` step before the Inno compile (or sign `Setup.exe` after the build); the installer script itself needs no change.

## Checklist before announcing

* Run the installer on a clean Windows VM; check the setup guide opens, a router can be added, uninstall leaves the data folder.
* Check each language once (header selector), in particular Persian and Arabic layouts.
* Try *Router setup* against a lab router: apply, apply again (no changes), remove.
