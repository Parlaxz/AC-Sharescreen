# ScreenLink — Update System

> **Applies to:** ScreenLink desktop app (`apps/desktop`, ESM + TypeScript, Electron)
> **Repository:** [github.com/Parlaxz/AC-Sharescreen](https://github.com/Parlaxz/AC-Sharescreen)
> **Update provider:** GitHub Releases (public)
> **Release tag format:** `vMAJOR.MINOR.PATCH` (e.g. `v0.1.1`)
> **Update target:** NSIS installer only

---

## Architecture Overview

The update system is built on [`electron-updater`](https://www.electron.build/auto-update) (v6.3.x) configured with the GitHub provider. All update logic is owned by a single main-process class: `UpdateManager` (`apps/desktop/src/main/update-manager.ts`).

**The renderer never imports `electron-updater` directly.** All update interactions flow through typed IPC calls:

1. The main process creates an `UpdateManager` instance during app initialization.
2. The manager configures the `electron-updater` `autoUpdater`, subscribes to its events (`checking-for-update`, `update-available`, `update-not-available`, `download-progress`, `update-downloaded`, `error`), and manages internal state represented by the `UpdateStatus` interface.
3. State changes are broadcast to the renderer via `webContents.send` on channel `updates:status-changed`. The broadcast callback (`createStatusBroadcast` in `update-ipc.ts`) is resilient to destroyed windows and unloaded renderers.
4. The renderer (Settings page, `UpdateSection` component) subscribes to these broadcasts and renders UI accordingly. User actions (Check for Updates, Download Update, Restart & Install) are invoked via IPC handlers registered in `update-ipc.ts`.

```
┌──────────────────────────────────────────────────────────┐
│  Main Process                                            │
│                                                          │
│  ┌──────────────────────────────────────────────┐        │
│  │  UpdateManager                                │        │
│  │  ┌────────────────┐  events  ┌──────────────┐│        │
│  │  │  autoUpdater   │◄────────►│  State       ││        │
│  │  │  (electron-    │          │  (UpdateSta- ││        │
│  │  │   updater)     │          │   tus)       ││        │
│  │  └────────────────┘          └──────┬───────┘│        │
│  │                                     │         │        │
│  │                         broadcast() │         │        │
│  └─────────────────────────────────────┼─────────┘        │
│                                        │                  │
│                              ┌─────────▼──────────┐       │
│                              │  update-ipc.ts      │       │
│                              │  IPC handlers +     │       │
│                              │  status broadcast   │       │
│                              └─────────┬──────────┘       │
│                                        │                  │
│                          ipcMain.handle() / send()        │
└──────────────────────────┬──────────────┼─────────────────┘
                           │              │
                    ┌──────▼──────────────▼──────┐
                    │  Renderer Process           │
                    │  (Settings.tsx)             │
                    │  UpdateSection component    │
                    │  calls api.checkForUpdates  │
                    │  etc. via preload bridge    │
                    └─────────────────────────────┘
```

The manager is independently unit-testable through dependency injection of an `UpdaterAdapter` interface. The production implementation wraps `autoUpdater` from `electron-updater`; test implementations use a mock adapter.

---

## Supported Update Target

**Only the installed NSIS version supports auto-updates.**

When Electron Builder packages the app, it produces two artifacts:

| Artifact | Pattern | Auto-Update |
|---|---|---|
| NSIS installer | `ScreenLink Setup {version}.exe` | ✅ Yes |
| Portable executable | `ScreenLink {version}.exe` | ❌ No |

The NSIS installer places the application in a fixed installation directory (typically `%LOCALAPPDATA%\Programs\screenlink-desktop` or a user-selected path during `oneClick: false` installation). This creates a predictable location where the updater can:

- Write updated application files.
- Stage the next installer for `quitAndInstall()`.
- Resolve `app-update.yml` from packaged resources.

The update metadata file `latest.yml` references only the NSIS Setup EXE and its blockmap. The portable artifact is never listed as an update target.

---

## Why Portable Cannot Self-Update

The portable (standalone EXE) build has no installation path:

- **No `PORTABLE_EXECUTABLE_DIR` resolution for updates.** The portable EXE can be moved, renamed, or run from any location (USB drive, downloads folder, etc.). The updater cannot reliably find or replace the running executable.
- **No `app-update.yml` at a fixed resource path.** The auto-updater discovers its configuration via `app-update.yml` packaged inside `win-unpacked/resources/`. In a portable build, the unpacked directory can be deleted or the EXE can be run standalone outside it.
- **No install staging area.** The NSIS update lifecycle downloads the new installer, stages it, and runs `quitAndInstall()` which launches the new installer. The portable EXE has no installer to run — replacing an in-use EXE file is not possible on Windows.
- **Detection in code:** `UpdateManager.detectPortable()` checks `process.env.PORTABLE_EXECUTABLE_DIR`: if this environment variable is set and non-empty, the app was launched from a portable build. The manager immediately sets `phase: "unsupported"` and `updaterSupported: false`.

The Settings UI in the renderer checks `status.isPortable` and displays a clear message:

> "Portable version cannot self-update. Download the ScreenLink Setup installer to receive automatic updates."

---

## GitHub Provider

The packaged application discovers its update source through `app-update.yml`, which is generated during packaging by Electron Builder from the `publish` configuration in `electron-builder.config.cjs`:

```cjs
publish: {
  provider: "github",
  owner: "Parlaxz",
  repo: "AC-Sharescreen",
  channel: "latest",
  releaseType: "release",
  vPrefixedTagName: true,
  publishAutoUpdate: true,
}
```

At packaging time, Electron Builder generates `app-update.yml` inside the packaged resources directory (`win-unpacked/resources/app-update.yml`). This file contains:

```yaml
owner: Parlaxz
repo: AC-Sharescreen
provider: github
channel: latest
updaterCacheDirName: screenlink-desktop-updater
```

**No authentication tokens are embedded in the application.** The GitHub provider accesses public releases without authentication. The CI workflow validation (step 9 of `release.yml`) verifies that `app-update.yml` contains no token string.

The file `latest.yml` (uploaded as a release asset) is fetched from the GitHub Release by `electron-updater` to determine the latest available version, download URL, and SHA-512 checksum of the installer.

---

## Stable Channel Rules

- **Only stable published releases are supported for auto-update.**
- No alpha, beta, nightly, draft, or prerelease releases are checked.
- `allowPrerelease = false` on the autoUpdater configuration (default).
- The channel is set to `latest`, meaning only the latest stable release is offered as an update target. When a newer stable release is published, all clients on older versions will be offered that single newest version.
- The CI workflow enforces this at the job level:
  ```yaml
  if: >
    (github.event_name == 'release' && github.event.release.prerelease == false) ||
    github.event_name == 'workflow_dispatch'
  ```
  Draft and prerelease triggers are silently skipped. The workflow also safely retries only published releases (not drafts/prereleases).

---

## Release Tag Rules

- **Tags must follow `vMAJOR.MINOR.PATCH` exactly.** Examples: `v0.1.1`, `v1.0.0`, `v2.5.12`.
- The tag IS the version; no version numbers are hardcoded in source. The `set-release-version.mjs` script reads the version from the tag (stripping the leading `v`) and updates both `package.json` files (root and `apps/desktop/package.json`) deterministically.
- The CI workflow validates the tag format and fails fast if it does not match `^v\d+\.\d+\.\d+$`.
- The Electron Builder `vPrefixedTagName: true` setting ensures the updater looks for GitHub releases with the `v` prefix.

---

## Release Workflow

The release pipeline is defined in `.github/workflows/release.yml`. It is triggered by:

1. **`release.published`** — When a GitHub Release is published (not drafted or pre-released).
2. **`workflow_dispatch`** — Manual retry, requiring a tag input.

### Pipeline Steps

```
┌─────────────────────────────────────────┐
│ 1. Determine release tag                │
│    - From event or manual input         │
└────────────────┬────────────────────────┘
                 ▼
┌─────────────────────────────────────────┐
│ 2. Validate tag format (vMAJOR.MINOR.   │
│    PATCH) and strip "v" for version     │
└────────────────┬────────────────────────┘
                 ▼
┌─────────────────────────────────────────┐
│ 3. Verify release exists (for           │
│    workflow_dispatch retries)           │
└────────────────┬────────────────────────┘
                 ▼
┌─────────────────────────────────────────┐
│ 4. Check out exact tag (fetch-depth: 0) │
└────────────────┬────────────────────────┘
                 ▼
┌─────────────────────────────────────────┐
│ 5. Setup Node 24 + pnpm 10, cache,     │
│    install dependencies                 │
└────────────────┬────────────────────────┘
                 ▼
┌─────────────────────────────────────────┐
│ 6. Set release version in package.json  │
│    files via set-release-version.mjs    │
└────────────────┬────────────────────────┘
                 ▼
┌─────────────────────────────────────────┐
│ 7. Verify version consistency           │
│    root == desktop package.json         │
└────────────────┬────────────────────────┘
                 ▼
┌─────────────────────────────────────────┐
│ 8. Build native audio helper            │
│    (CMake, MSVC 2022, Release)          │
└────────────────┬────────────────────────┘
                 ▼
┌─────────────────────────────────────────┐
│ 9. Run native helper self-test          │
└────────────────┬────────────────────────┘
                 ▼
┌─────────────────────────────────────────┐
│ 10. Type check all packages             │
│ 11. Run unit tests                      │
└────────────────┬────────────────────────┘
                 ▼
┌─────────────────────────────────────────┐
│ 12. Build: shared, vdo-adapter, desktop │
│ 13. Verify desktop build output         │
└────────────────┬────────────────────────┘
                 ▼
┌─────────────────────────────────────────┐
│ 14. Package with Electron Builder       │
│     (--win --x64, NSIS + portable)      │
└────────────────┬────────────────────────┘
                 ▼
┌─────────────────────────────────────────┐
│ 15. Validate all artifacts:             │
│     - latest.yml (version + .exe ref)   │
│     - Setup EXE exists                  │
│     - Blockmap exists                   │
│     - Portable EXE exists               │
│     - Packaged helper & tray icon       │
│     - app-update.yml (no token)         │
│     - Packaged version matches release  │
└────────────────┬────────────────────────┘
                 ▼
┌─────────────────────────────────────────┐
│ 16. Upload artifacts to existing        │
│     GitHub Release (gh release upload)  │
└────────────────┬────────────────────────┘
                 ▼
┌─────────────────────────────────────────┐
│ 17. Verify uploaded assets are present  │
│     on the release                      │
└────────────────┬────────────────────────┘
                 ▼
┌─────────────────────────────────────────┐
│ 18. Generate job summary                │
└─────────────────────────────────────────┘
```

The workflow requires `contents: write` permission on the GITHUB_TOKEN to upload assets. The release must already exist (created manually or via GitHub web UI); the workflow only uploads artifacts to it.

---

## Bootstrap Limitation (0.1.0 Users)

**Important:** Existing ScreenLink 0.1.0 builds do **not** contain `electron-updater` and cannot auto-update.

Version 0.1.0 was published before the update system was implemented. Users who installed 0.1.0 will see no update UI — the `electron-updater` dependency was added in a later commit, and 0.1.0 packaged builds have no updater code, no `UpdateManager`, and no `app-update.yml`.

### Required Manual Step

1. Users of ScreenLink 0.1.0 **must manually download** the first updater-enabled NSIS release from the [GitHub Releases page](https://github.com/Parlaxz/AC-Sharescreen/releases).
2. Install the updater-enabled NSIS installer (0.1.1 or later) **over** the existing 0.1.0 installation. The NSIS installer will upgrade the existing installation in place.
3. After this one-time manual upgrade, **all future updates will work automatically** through GitHub Releases — no further manual intervention is required.

The `UpdateManager` code checks `app.isPackaged` and `process.platform === "win32"` to determine support. In 0.1.0 packaged builds, the `UpdateManager` class itself does not exist in the bundled code, so no update-related IPC handlers are registered.

---

## Required Release Assets

For auto-update to work, a GitHub Release must contain the following assets. The CI workflow validates all of these before considering the build successful.

### Required (auto-update will fail without these)

| Asset | Pattern | Purpose |
|---|---|---|
| `latest.yml` | `latest.yml` | Update metadata file containing version, download URL, and SHA-512 checksum of the installer. `electron-updater` fetches this to determine if an update is available. |
| NSIS Setup EXE | `ScreenLink Setup {version}.exe` | The full NSIS installer. This is the file downloaded and executed during the update. |
| Blockmap | `ScreenLink Setup {version}.exe.blockmap` | Differential update data. Enables partial downloads — the updater downloads only the bytes changed between the currently installed version and the new version. Significantly reduces download size for small changes. |

### Optional

| Asset | Pattern | Purpose |
|---|---|---|
| Portable EXE | `ScreenLink {version}.exe` | Standalone portable executable. **Not an update target.** Provided for users who prefer portable use. Cannot be auto-updated (see "Why Portable Cannot Self-Update" above). |

### Validation Checks

The CI workflow validates that:

- `latest.yml` contains a `version:` field matching the release version.
- `latest.yml` references an `.exe` file (the NSIS installer).
- `latest.yml` does **not** reference the portable artifact.
- The Setup EXE exists and is a valid file.
- The blockmap exists and is a valid file.
- `app-update.yml` (packaged resource) contains no token.
- `app-update.yml` points to `Parlaxz/AC-Sharescreen`.
- The packaged app version (in `app.asar/package.json` or `dist/main/main.js`) matches the release version.

---

## Historical Blockmap Retention

**The NSIS Setup EXE and blockmap from EVERY updater-enabled historical release must be preserved on GitHub Releases.**

Differential (delta) updates work by comparing the blockmap of the currently installed version against the blockmap of the new version. When a user has version `A` installed and version `B` is available:

1. `electron-updater` downloads `B`'s `latest.yml` to discover the new version and its blockmap URL.
2. It fetches `B`'s blockmap.
3. It uses the **currently installed version's blockmap** (already on disk at the install location) to compute which byte ranges differ.
4. It downloads only those changed byte ranges from `B`'s installer.

This means: **if a user is on version 0.1.1 and wants to update to 0.6.0, the updater needs the blockmap for 0.1.1 (which is on the user's disk) AND the blockmap for 0.6.0 (which must be available on the release).** But crucially, intermediate blockmaps are not needed — only the target version's blockmap.

However, there is a subtle case: if the blockmap base URL override points to a specific release download URL, and that release's artifacts have been deleted, the blockmap resolution may fail and the updater may fall back to a full download. The `UpdateManager` sets `previousBlockmapBaseUrlOverride` dynamically based on the current version:

```typescript
this.updater.previousBlockmapBaseUrlOverride =
  `https://github.com/Parlaxz/AC-Sharescreen/releases/download/v${currentVersion}`;
```

This URL must remain valid for the currently installed version. **Never delete old release assets.** The `gh release upload` command in the CI uses `--clobber` to overwrite existing assets, but deletion of historical assets will break differential updates for users still on those versions.

### Practical Rule

- **Do NOT delete any release** once published.
- **Do NOT delete or remove individual assets** (EXE, blockmap, `latest.yml`) from any updater-enabled release.
- Retaining historical assets is zero-cost on GitHub (unlimited storage for public repositories) and ensures all users receive efficient differential updates regardless of their current version.

---

## Local Build Instructions

To build the installer locally for testing:

### Prerequisites

| Tool | Required Version | Notes |
|---|---|---|
| pnpm | 10.x | Package manager |
| Node.js | >=24.0.0 | JavaScript runtime |
| CMake | >=3.20 | Native audio helper build system |
| Visual Studio 2022 | Any edition | Required by CMake for MSVC C++ toolchain (Windows x64) |

### Steps

1. **Open a Developer Command Prompt for VS 2022** (or a regular terminal with `vcvars64.bat` loaded) so that `cmake` can find the MSVC compiler.

2. **Run the build script from the repository root:**

   ```
   build-screenlink-installer.bat
   ```

   This batch script performs these steps:

   - Checks prerequisites (`pnpm`, `node`, `cmake` are in PATH).
   - Verifies the tray icon exists at `apps/desktop/assets/tray-icon.png`.
   - **Step 1/5:** Builds the native audio helper via `pnpm audio-helper:build` (CMake → Visual Studio 2022, x64, Release).
   - **Step 2/5:** Runs the audio helper self-test via `pnpm audio-helper:self-test`.
   - **Step 3/5:** Runs `pnpm build` to compile all TypeScript packages (shared, vdo-adapter, desktop).
   - **Step 4/5:** Generates a merged Electron Builder configuration that includes extra resources (audio helper, tray icon).
   - **Step 5/5:** Invokes `electron-builder --win --x64` with the generated config.
   - Cleans up the temporary config file.
   - Verifies the packaged audio helper and tray icon exist.

3. **Expected artifacts** in the `release/` directory:
   - `latest.yml`
   - `ScreenLink Setup {version}.exe`
   - `ScreenLink Setup {version}.exe.blockmap`
   - `ScreenLink {version}.exe` (portable)
   - `win-unpacked/` (unpacked application directory)

### Notes

- The local build uses the version currently in `package.json`. For release builds, the CI workflow sets the version via `set-release-version.mjs` before building.
- The local build does **not** upload artifacts to GitHub — it only produces files locally.
- If `release/` already exists from a previous build, the script removes it.
- Ensure no running `ScreenLink.exe` process exists before building, as it may lock files in the output directory.

---

## GitHub Actions Retry

If a release workflow fails (network flake, runner issue, upload timeout), you can retry it for an **existing published release** without creating a new release.

### Steps

1. Go to the repository's Actions tab: `https://github.com/Parlaxz/AC-Sharescreen/actions`
2. Select the **"Build and Release ScreenLink (Windows x64)"** workflow.
3. Click **"Run workflow"** (dropdown button).
4. In the form:
   - **Branch:** The workflow reads the tag input, not the branch — set this to `main` (or any branch; the checkout step will check out the tag directly).
   - **Tag:** Enter the existing release tag exactly (e.g. `v0.1.1`).
5. Click **"Run workflow"**.

The workflow will:

1. Verify the tag exists and is a published (non-draft, non-prerelease) release.
2. Check out the exact tag.
3. Run the full build pipeline.
4. Upload artifacts with `--clobber`, overwriting any existing assets on the release.

### When to Retry

- The workflow failed during build (type errors, test failures, build timeout).
- The workflow failed during upload (network error, GH API rate limit).
- The workflow passed but a required asset is missing from the release (should not happen due to validation + verification steps, but possible if the verification step had a bug that was later fixed).

Do **not** retry to change build contents — the workflow checks out the exact tag, so the source is identical every time. If you need different build output, create a new release with a new tag.

---

## Manual Differential Update Test

This procedure tests the end-to-end update flow including differential (blockmap-based) download.

### Prerequisites

- Two ScreenLink releases: an older installer version installed on the test machine, and a newer version to publish.
- The older version must have been packaged with the updater system (i.e., it must include `electron-updater` and `app-update.yml`).
- The test machine should have the older version actually installed (not running from the portable EXE).

### Procedure

1. **Install the older NSIS release.**
   - Download and run the NSIS installer for the earlier version (e.g. `v0.1.1`).
   - Complete the installation to a standard location.
   - Launch the app briefly to verify it starts correctly, then close it.

2. **Verify the installed version.**
   - Launch the installed app.
   - Open the Settings page.
   - Confirm the displayed version matches the old version.
   - Alternatively, check `app.getVersion()` in the dev console (if dev tools are available).

3. **Publish a newer release with a small change.**
   - Make a small, identifiable change to the app (e.g., update a version string in the UI, change a label).
   - Commit and tag: `git tag v{new-version}` and `git push origin v{new-version}`.
   - Create a GitHub Release from the tag (published, not draft, not prerelease).
   - The CI workflow will trigger on `release.published`, build, and upload artifacts.

4. **Launch the old app and check for updates.**
   - Launch the installed older version.
   - Wait approximately 15 seconds for the automatic check to trigger (the `UpdateManager` schedules the first check after a 15-second delay).
   - OR click **"Check for Updates"** in the Settings → Updates section.
   - The UI should transition: `idle` → `checking` → `update-available`.

5. **Confirm the newer version is shown.**
   - The Settings page should display:
     - The available version number (e.g. `ScreenLink 0.1.2 is available.`)
     - The **"Download Update"** button should be enabled.

6. **Press "Download Update".**
   - Click the **"Download Update"** button.
   - The UI should transition: `update-available` → `downloading`.

7. **Observe download progress.**
   - The Settings page should show a progress indicator with percentage, transferred bytes, total bytes, and speed.
   - The progress bar should update smoothly as `download-progress` events fire.

8. **Compare transferred size against full installer size.**
   - Note the `totalBytes` shown in the download progress.
   - Compare this against the full installer size (available on the GitHub Release page).
   - If the differential update is working, `transferred`/`totalBytes` should be significantly smaller than the full installer file size, because only changed byte ranges are downloaded.

9. **Check logs for differential/blockmap behavior.**
   - If logging is available, check the app's log output for entries containing `blockmap` or `differential`.
   - The `UpdateManager` logs `blockmap_base_url` on initialization with the URL of the installed version's blockmap.

10. **Press "Restart and Install".**
    - After the download completes, the UI should show `downloaded` with the message **"Update ready to install."**
    - Click **"Restart and Install"** (or equivalent button).
    - The app should close, the NSIS installer should launch, and the upgrade should proceed silently or with a brief UI.

11. **Confirm restart and new version.**
    - After the installer finishes, the updated app should launch automatically.
    - Open Settings → Updates. The status should show **"up-to-date"** with the new version.

12. **Confirm settings survive the upgrade.**
    - Verify that previously configured settings (display name, sharing preferences, window bounds, audio settings) are preserved after the upgrade. The NSIS installer by default keeps user data in the app's user data directory, not the installation directory.

13. **Confirm tray, audio helper, and sharing work.**
    - Verify the tray icon is present and functional.
    - Verify the audio helper starts correctly (check the audio pipeline status).
    - Verify sharing capabilities work correctly in the upgraded version.

### Troubleshooting the Test

| Symptom | Likely Cause |
|---|---|
| Update not detected | Check that the release is published (not draft), is a stable release (not prerelease), and `latest.yml` is present on the release. |
| Full download instead of differential | Old version may not have a blockmap on the release, or `previousBlockmapBaseUrlOverride` points to an invalid URL. Check that historical blockmaps are preserved. |
| Checksum error | The downloaded file does not match the SHA-512 in `latest.yml`. Retry — the updater may fall back to a full download on next attempt. |

---

## Offline Behavior

The `UpdateManager` handles offline scenarios gracefully:

### Background Automatic Checks

- If an automatic check (scheduled every 6 hours) fails due to network unavailability, the manager logs the error as a warning and transitions the state to `error` with code `network-unavailable`.
- **Crucially**, if the current phase is `update-available` or `downloaded`, the background error is **suppressed** (the user's existing useful state is preserved). This is a deliberate design choice: once the app knows an update is available, intermittent network failures should not clear that information.
- The auto-check timer is rescheduled regardless of success or failure, so the next check occurs in approximately 6 hours.

### Manual Checks

- When the user clicks **"Check for Updates"** while offline, the inline error is shown directly in the Settings UI.
- The error message is user-friendly: `"Unable to connect to the update server. Please check your internet connection."`
- The error code (`network-unavailable`) is exposed in the `UpdateStatus` object so the renderer can provide contextual UI.

### Error Codes

The `getErrorCode()` function maps common network/HTTP errors to typed error codes:

| Error Code | Triggered By |
|---|---|
| `network-unavailable` | `ERR_INTERNET_DISCONNECTED`, `ERR_CONNECTION_*`, `ERR_NAME_NOT_RESOLVED`, `ERR_TIMEOUT`, `getaddrinfo`, `ENOTFOUND`, `ECONNREFUSED`, `ECONNRESET` |
| `invalid-update-metadata` | `No valid updates`, `update metadata`, `is not yet available` |
| `checksum-failure` | `blockmap`, `checksum`, `integrity` |
| `missing-release-artifact` | `download`, `404`, `not found` |
| `unknown-updater-failure` | All other errors |

---

## Update Error Troubleshooting

| Error | Cause | Resolution |
|---|---|---|
| **Network unavailable** | No internet connection, DNS resolution failure, or the GitHub API is unreachable. | Check internet connectivity. If behind a corporate proxy, ensure the app can reach `api.github.com` and `github.com`. No proxy configuration is currently exposed. |
| **Invalid update metadata** | The release's `latest.yml` is missing, malformed, or contains invalid data. The release may still be processing (there is a delay between release creation and asset availability). | Verify the release has completed processing. Check `latest.yml` exists on the release and is well-formed YAML with correct `version` and `path` fields. |
| **Missing release artifact** | The updater resolved the release metadata but the actual installer EXE returned a 404 or was not found. The CI upload step may have failed or the asset may have been deleted. | Check the release's assets on GitHub. Run the CI workflow via `workflow_dispatch` to re-upload artifacts. |
| **Checksum failure** | The downloaded installer's SHA-512 does not match the value in `latest.yml`. This can happen with a corrupted download or if artifacts were overwritten with mismatched content. | Retry the update. The updater may fall back to a full (non-differential) download on the next attempt. If the error persists, re-run the CI workflow to regenerate artifacts. |
| **Checksum failure during differential download** | The blockmap-based partial download failed integrity verification. This is common when blockmaps are mismatched (e.g., artifacts were rebuilt but the blockmap was not regenerated). | The `UpdateManager` suppresses the error UI during download if the code is `checksum-failure`, because `electron-updater` automatically falls back to a full download. The user should see no error; the download continues. |
| **Updater unsupported** | The app is running in development mode (`app.isPackaged === false`), from a portable EXE, or on a non-Windows platform. | Use an installed NSIS build on Windows x64. |
| **No update found** | The app is already on the latest version, or the release tag does not follow `vMAJOR.MINOR.PATCH` format, or the release is a draft/prerelease. | Verify the release is published and stable. Check the release tag format. |

### General Troubleshooting Steps

1. **Check the release on GitHub** — navigate to `https://github.com/Parlaxz/AC-Sharescreen/releases` and verify the latest release has all required assets (`latest.yml`, Setup EXE, blockmap).
2. **Check app logs** — the `UpdateManager` logs all events with component tag `updater`. Look for `updater_error`, `check_failed`, `download_failed`, or `auto_check_failed` entries.
3. **Retry manually** — click "Check for Updates" in the Settings page. The automatic check runs every 6 hours, but a manual check can be triggered at any time.
4. **Reinstall** — if the updater is in an unrecoverable error state, download the latest NSIS installer from GitHub Releases and install manually.

---

## Rollback Policy

- **No downgrade support.** `allowDowngrade` is set to `false` (default). The updater will never offer an older version as an update, even if a newer version is already installed.
- **If a release contains a critical bug**, do not delete or replace the release. Instead, publish a **new patch release** with the fix at a higher version number.
- **Version monotonicity is required.** Release versions must always increase: `v0.1.1 → v0.1.2 → v0.1.3`, never `v0.1.2 → v0.1.1`.
- **Never delete or replace historical releases.** Deleting a release will break updates for users still on that version (they will receive no update notification) and may cause confusing error states. Replacing assets on an existing release (via `gh release upload --clobber`) is supported for retrying failed builds, but the release itself and its metadata should remain stable.

### If a Bad Release Was Published

1. Do **not** delete the release.
2. Do **not** mark it as a draft or prerelease (this would confuse the updater).
3. Do **not** re-publish the same tag with different content (this violates the immutability expectation).
4. Publish a new release with the fix at the next patch version (e.g., if `v0.1.2` has a bug, publish `v0.1.3` with the fix).
5. If users are already on the broken version, they will be offered `v0.1.3` as an update. If they are still on `v0.1.1`, they will be offered `v0.1.3` directly (skipping the broken `v0.1.2`).

---

## Unsigned Build Warning

Current ScreenLink builds are **not code-signed**. The NSIS installer and executable files do not carry an Authenticode digital signature.

### Consequences

- **Windows SmartScreen** may show a warning when the installer is downloaded or run: *"Windows protected your PC. Microsoft Defender SmartScreen prevented an unrecognized app from starting."*
- Users must click **"More info"** then **"Run anyway"** to proceed with installation.
- Group policy or enterprise settings may block unsigned executables entirely.
- Anti-virus software may flag unsigned installers more aggressively.

### Impact on Auto-Update

- **Code signing does not affect auto-update functionality.** The update system works with or without signing.
- However, during the update process, `electron-updater` launches the downloaded NSIS installer. An unsigned installer may trigger SmartScreen warnings during the update installation phase, which could confuse users.

### Recommendation

- For private/personal use, the lack of code signing is acceptable.
- For broader distribution, a code-signing certificate should be obtained and configured.

---

## Future Code Signing Notes

The packaging configuration supports adding Windows Authenticode signing later **without any code changes**. Electron Builder's `win` configuration includes native support for code signing via the `certificateFile` and `certificatePassword` options, or via `signtool` for hardware tokens/HSM.

### Configuration (electron-builder.config.cjs)

```cjs
win: {
  target: ["nsis", "portable"],
  icon: "assets/icon.png",
  certificateFile: process.env.WIN_CERT_FILE,        // optional
  certificatePassword: process.env.WIN_CERT_PASSWORD, // optional
  signDlls: true,
}
```

### CI Integration

In the GitHub Actions workflow, code signing would be configured by:

1. Storing the code-signing certificate (PFX/P12 file) as a **GitHub Actions Secret** (base64-encoded).
2. Storing the certificate password as a separate secret.
3. Adding a step before packaging to decode the certificate and set the environment variables:

```yaml
- name: Decode code signing certificate
  shell: pwsh
  env:
    WIN_CERT_BASE64: ${{ secrets.WIN_CERT_BASE64 }}
  run: |
    $bytes = [Convert]::FromBase64String($env:WIN_CERT_BASE64)
    [IO.File]::WriteAllBytes("$env:RUNNER_TEMP/cert.pfx", $bytes)
    echo "WIN_CERT_FILE=$env:RUNNER_TEMP/cert.pfx" >> $env:GITHUB_ENV
    echo "WIN_CERT_PASSWORD=${{ secrets.WIN_CERT_PASSWORD }}" >> $env:GITHUB_ENV
```

### Certificate Types

| Certificate Type | Cost | Trust Level |
|---|---|---|
| Standard Authenticode (OV/Organization Validation) | ~$200–$300/year | Basic — reduces SmartScreen warnings after reputation is built |
| Extended Validation (EV) Code Signing | ~$300–$500/year | Higher trust — immediate SmartScreen reputation, typically on hardware token |

### Recommendations

- A **Standard OV certificate** is sufficient for ScreenLink's use case.
- The certificate should be stored securely as a GitHub Actions secret, **never** committed to the repository.
- A hardware token (USB dongle) is required for EV certificates; cloud-HSM-based solutions (Azure Key Vault, AWS KMS) can also work.
- Before implementing, verify that the CI runner has the necessary cryptographic providers installed.
- Test signing locally first using `electron-builder` with `--win --x64` and the certificate file before enabling in CI.

---

## Appendix: Key Source Files

| File | Purpose |
|---|---|
| `apps/desktop/src/main/update-manager.ts` | Core update logic: state machine, event binding, auto-check scheduling, error handling. |
| `apps/desktop/src/main/update-ipc.ts` | IPC handler registration and status broadcast to renderer. |
| `apps/desktop/src/preload/api-types.ts` | `UpdateStatusDTO` type and update-related API surface. |
| `apps/desktop/src/renderer/routes/Settings.tsx` | `UpdateSection` component rendering update UI. |
| `apps/desktop/electron-builder.config.cjs` | Electron Builder configuration with GitHub publish provider. |
| `.github/workflows/release.yml` | CI/CD pipeline for building and releasing. |
| `scripts/set-release-version.mjs` | Script to deterministically set version from release tag. |
| `scripts/after-pack.cjs` | Post-packaging cleanup (removes unused Chromium files). |
| `build-screenlink-installer.bat` | Local build script for producing installer artifacts. |
