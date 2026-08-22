# Releasing ScreenLink

## Prerequisites

- `gh` CLI authenticated: `gh auth login` (once per machine)
- pnpm installed and on PATH
- Clean working tree — commit or stash before releasing

## Quick release (recommended)

From any terminal:

```
release.bat 0.8.2
```

or from the repo root:

```
.\release.bat 0.8.2
```

The batch does everything: bumps the version, commits, pushes `main`, creates and pushes the tag, and dispatches the build workflow.

Then watch https://github.com/Parlaxz/AC-Sharescreen/actions — "Build and Release ScreenLink (Windows x64)" takes ~5 minutes. The GitHub Release publishes automatically after artifact verification passes.

## Manual steps (equivalent)

1. `node scripts/set-release-version.mjs <version>` — bumps root + `apps/desktop/package.json`
2. Commit as `v<version>`, push `main`
3. `git tag v<version>` then `git push origin v<version>`
4. `gh workflow run release.yml -f tag=v<version> -f release_type=stable -R Parlaxz/AC-Sharescreen`

## Verifying a release

- Release page: `https://github.com/Parlaxz/AC-Sharescreen/releases/tag/v<version>`
- Required assets: `ScreenLink-Setup-<version>.exe`, `.exe.blockmap`, `ScreenLink-Portable-<version>.exe`, `latest.yml`
- Public URL check (should return 200):
  `https://github.com/Parlaxz/AC-Sharescreen/releases/download/v<version>/latest.yml`

## Toast self-test

Launch the packaged app with the self-test flag to display a test toast after 5 seconds:

```
ScreenLink.exe --test-toast
```

Diagnostics print with `[stream-toast]`, `[fullscreen-detector]`, and `[notification-watcher]` prefixes. If the toast is suppressed, the log states why (`deduped` or `fullscreen application detected`).
