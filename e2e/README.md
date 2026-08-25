# ScreenLink E2E Suite

Playwright-driven end-to-end tests for ScreenLink. The suite launches **real
app instances** ("agents") via Playwright's Electron support, drives their UI,
captures logs/artifacts, and verifies process cleanup.

## Prerequisites

- Windows (the suite uses PowerShell `Get-CimInstance` / `taskkill` for
  process inspection and teardown).
- Node >= 24, pnpm 10.
- A built desktop app: `pnpm build` (produces `apps/desktop/dist/main/main.js`).
- Native helpers built:
  - `native/audio-helper/build/Release/screenlink-audio-helper.exe`
  - `native/video-enhancer/build/Release/screenlink-video-enhancer.exe`
- `@playwright/test` is installed at the repo root with
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` — `_electron` needs **no** downloaded
  browsers.

## Commands

```powershell
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD='1'   # only needed for the first install
pnpm install

pnpm e2e:preflight            # fast Phase-0 gate (env checks only)
pnpm e2e:preflight -- --full  # + typecheck/build/native checks/unit tests (stops on first failure)

pnpm e2e                      # run everything (project "all" semantics via default config order)
pnpm e2e:local                # same as e2e
pnpm e2e:critical             # --project=critical   (@critical)
pnpm e2e:media                # --project=media      (@media)
pnpm e2e:soak                 # --project=soak       (@soak)
pnpm e2e:packaged             # --project=packaged   (@packaged)
pnpm e2e:two-machine          # --project=two-machine (@two-machine)

pnpm exec playwright test --config e2e/playwright.config.ts --list   # dry list
```

All scripts pass `--config e2e/playwright.config.ts` explicitly because the
config lives under `e2e/` while commands run from the repo root.

## Architecture map

- **`playwright.config.ts`** — single worker, zero retries (infra retries live
  inside launch helpers), 180s test timeout, 15s expect timeout. Reporters:
  list + JSON (`e2e/artifacts/results.json`) + JUnit
  (`e2e/artifacts/results.xml`). Projects filter by title tag (`grep`);
  project `all` has no filter.
- **`framework/agent.ts`** — `AgentController` + `launchAgent()`. Launches one
  real app instance per agent name with
  `electron.exe --dev-profile=<name> --multi-instance <abs dist/main/main.js>`,
  cwd=`apps/desktop`, env `SCREENLINK_E2E=1 NODE_ENV=production
  SCREENLINK_AGENT=<name>`. Registers console/pageerror/requestfailed
  collectors *before* any window exists (Set-guarded per page) plus a
  main-process console listener. Exposes `page`, `byTestId/clickTestId/
  fillTestId/waitForTestId` (with URL+body-snippet diagnostics on timeout),
  `snapshot()` (read-only renderer state via `window.__screenlinkTest`),
  `drainMarkers()` (ring buffer + parsed `{e2eMarker:"..."}` console lines),
  `clipboardText()` (main-process evaluate), `mainEval()`, `screenshot()`,
  `processSnapshot()`, and `close()` (graceful `electronApp.close()` then
  `taskkill /PID <pid> /T /F` fallback). A static registry tracks live agents;
  `AgentController.closeAllAgents()` is the global safety net.
- **`framework/fixtures.ts`** — Playwright fixtures. `createAgent(name?)`
  launches agents; fixture teardown auto-closes every agent created during the
  test (finally semantics — runs on failure/timeout too), flushing logs and
  capturing failure screenshots first. `artifactDir` hands each test a writer
  bound to its own directory.
- **`framework/artifacts.ts`** — `ArtifactWriter` (appendJsonl/writeJson/
  savePng/flushAgentLogs) plus the once-per-run environment manifest
  (`e2e/artifacts/env.json`: OS caption+build, node/pnpm versions, app version
  from `apps/desktop/package.json`, git SHA, GPU name/driver, display layout).
- **`framework/processes.ts`** — PowerShell-backed `listProcesses`,
  `killTree`, `waitForProcessGone`, `assertNoLeftovers(agentNames,
  extraNames)` (finds stray `--dev-profile=<name>` processes and leftover
  native helpers without killing them).
- **`framework/wait.ts`** — labeled polling helper `waitFor(predicate, opts)`
  reused by UI waits.
- **`scripts/preflight.mjs`** — Phase-0 gate; see Commands above. Writes
  `e2e/artifacts/preflight.json`, exits non-zero on any fast-mode failure.

## Agent model

| Profile name | Role | userData | Notes |
|--------------|------|----------|-------|
| `alice` | sender | `%APPDATA%\<base>-alice` | no fixed ports needed |
| `bob`   | receiver/viewer | `%APPDATA%\<base>-bob` | |
| `charlie` | third participant | `%APPDATA%\<base>-charlie` | |

Profile/userData isolation comes free from `--dev-profile=<name>`; multiple
instances run side by side thanks to `--multi-instance`. Never pass fixed CDP
ports — Playwright injects its own `--remote-debugging-port=0`.

## Fixture window

Deterministic capturable media source (`e2e/fixtures/fixture-window/`),
launched with the *same* electron.exe:

```ts
import { startFixture } from '../fixtures/fixture-window/client.js';
const fx = await startFixture({ agent: 'alice', controlPort: 9770, audio: true });
await fx.frames();     // current frame count via GET /frame
await fx.minimize();   // POST /minimize
await fx.restore();    // POST /restore
await fx.stop();       // POST /close + taskkill fallback
```

The window title is exactly `E2E-FIXTURE:<AGENT>` (capture enumeration keys on
this). It paints SMPTE-like color bars, a huge frame counter, a timestamp and
the agent label at ~vsync rate; optional WebAudio square wave alternating
440/880 Hz (gain 0.15). Its control HTTP server binds `127.0.0.1` only and its
userData lives in a unique temp dir.

## Artifact layout

```
e2e/artifacts/
├── env.json                     environment manifest (once per run)
├── preflight.json               preflight report
├── results.json / results.xml   Playwright reporters
├── agent-exits.jsonl            one line per agent close
├── test-results/                Playwright outputDir
└── <testfile>-<testtitle-slug>/ per-test dir
    ├── <agent>-logs.json        flushed console/pageerror/requestfailed buffers
    ├── <agent>-*.png            screenshots
    └── <agent>-processes-*.json process snapshots
```

## Tagging / project matrix

Tags go inside test titles: `test('@critical @smoke ...')`.

| Project | Grep |
|---------|------|
| critical | `@critical` |
| local-mesh | `@local-mesh` or `@critical` |
| media | `@media` |
| resilience | `@resilience` |
| soak | `@soak` |
| packaged | `@packaged` |
| two-machine | `@two-machine` |
| all | no filter |

## Two-machine coordinator (placeholder)

Planned contract for cross-machine specs (implementation deferred): an
authenticated HTTPS coordinator service that both machines poll/join by run
ID; it brokers offer/answer SDP + ICE candidates between agents on different
hosts and relays control commands (join room, mute, quit). Auth via short-lived
run-scoped tokens minted by CI. Specs will use the same `AgentController`
locally and a thin remote-agent client against the coordinator API. This
section will be updated when the coordinator lands.

## Troubleshooting

- **Stale dev profiles**: agent userData lives at
  `%APPDATA%\<base>-<profile>`. The base folder depends on how Electron
  resolves the app name in dev mode — check for both `screenlink` and
  `Electron` under `%APPDATA%` (i.e. `%APPDATA%\Electron-alice` or
  `%APPDATA%\screenlink-alice`). To wipe a stale profile, delete the matching
  `-<profile>` folder while no agent is running. The preflight report records
  the app package name to help locate the base folder.
- **Leftover processes after a failed run**: `Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*--dev-profile=*' }` then
  `taskkill /PID <pid> /T /F`.
- **Launch fails with missing main.js**: run `pnpm build`.
- **Fixture port conflicts**: pass an explicit `controlPort` (default range
  9700–9799).
