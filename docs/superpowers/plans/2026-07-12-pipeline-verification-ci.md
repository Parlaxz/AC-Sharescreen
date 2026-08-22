# Pipeline Verification & CI Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create exhaustive verification procedures and CI infrastructure so that every code change to `main` is validated across all four ScreenLink test surfaces (shared, vdo-adapter, desktop unit, desktop integration) and the root `pnpm test` command no longer silently excludes the desktop's 130+ test files.

**Architecture:** Two tightly coupled deliverables: (1) A new `pnpm test:all` root script and `.github/workflows/ci.yml` triggered on push/PR to `main` that runs `pnpm typecheck` + `pnpm test:all` on `windows-latest` + Node 24 + pnpm 10. (2) A verification matrix document (this plan) that defines per-package test commands, expected pass/fail baselines, evidence-collection format, and conflict-safety checks. The existing `release.yml` is NOT modified.

**⚠️ Exclusive Ownership & Execution Order:** This plan MUST execute before any other plan that touches `package.json` (root) or `.github/workflows/ci.yml`. Task 1 exclusively owns adding the `test:all` script to root `package.json`. Task 2 exclusively owns creating `.github/workflows/ci.yml`. No other concurrently executing plan may modify either file. If another plan has already modified `package.json`, Task 4's conflict checks will detect it and the executor must integrate without reverting.

**Tech Stack:** pnpm 10 workspace, vitest 3.x, GitHub Actions (windows-latest), PowerShell 5.1, CMake 3.20+, Visual Studio 17 2022, Node 24.

---

### Task 1: Fix Root `pnpm test` Script (shared-only gap)

> **⚠️ Exclusive ownership:** This task is the ONLY modification to root `package.json` permitted across all concurrent plans. The `"test:all"` script must not be added by any other plan. Conflict checks in Task 4 verify no concurrent modification occurred.

**Files:**
- Modify: `package.json:7` (the `"test"` script on line 32)

- [ ] **Step 1: Read current root `package.json` to confirm the `test` script value**

  Run: `Get-Content -Path "package.json" | Select-String "test"`
  Expected output: `"test": "pnpm --filter @screenlink/shared test",`

- [ ] **Step 2: Add a new root script `test:all` and rename `test` to its current value**

  The approved spec (hardening §12.3) requires that `pnpm test` continue to work for its existing users while a new comprehensive command covers all packages.

  Change in `package.json`:
  - Keep `"test"` as-is (`"pnpm --filter @screenlink/shared test"`)
  - Add a new script:
    ```
    "test:all": "pnpm -r test"
    ```
  Place it immediately after the existing `"test"` entry on line 32.

  Edit:
  Old:
  ```
    "test": "pnpm --filter @screenlink/shared test",
    "test:run": "pnpm test",
  ```
  New:
  ```
    "test": "pnpm --filter @screenlink/shared test",
    "test:all": "pnpm -r test",
    "test:run": "pnpm test",
  ```

- [ ] **Step 3: Verify `pnpm test:all` resolves correctly**

  Run: `pnpm run test:all -- --list-tests 2>&1 | Select-String -Pattern "^@" | Select-Object -First 10`
  Expected: Lists test files from `@screenlink/shared`, `@screenlink/vdo-adapter`, and `@screenlink/desktop` — proving `pnpm -r test` propagates to all three workspace packages.

  If any package lacks a `test` script, the command fails. Verify each package's `package.json`:
  - `packages/shared/package.json`: `"test": "vitest run"` ✓
  - `packages/vdo-adapter/package.json`: `"test": "vitest run"` ✓
  - `apps/desktop/package.json`: `"test": "vitest run"` ✓

- [ ] **Step 4: Run `pnpm test:all` dry-run to confirm it would invoke vitest for each package**

  Run: `pnpm -r exec vitest run --help 2>&1 | Select-String -Pattern "vitest"`
  Expected: Shows vitest CLI help once per package (or per filtered workspace member), proving vitest is available in each.

- [ ] **Step 5: Run `pnpm test` to verify existing script unchanged**

  Run: `pnpm test 2>&1 | Select-Object -Last 20`
  Expected: Only shared-package tests run. Verify by counting test files — should match the count of `packages/shared/tests/*.test.*` files (19 files).

- [ ] **Step 6: Run `pnpm test:all` to establish full baseline**

  Run: `pnpm test:all 2>&1`
  Expected: All three packages' tests execute. Record:
  - Total pass count
  - Total fail count
  - Per-package breakdown
  - Any flaky tests (intermittent failures)

  Save output to `docs/superpowers/evidence/2026-07-12-test-all-baseline.txt`

---

### Task 2: Create CI Workflow for Push/PR

> **⚠️ Exclusive ownership:** This task is the ONLY creation of `.github/workflows/ci.yml` permitted across all concurrent plans. No other plan may create or modify this file. Conflict checks in Task 4 verify no concurrent creation occurred.

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Verify release.yml is read-only (no modifications)**

  Run: `git status --short .github/workflows/release.yml`
  Expected: No output (file is clean, no staged/unstaged modifications).

  If other agents have modified `release.yml`, read their diff and integrate — do NOT revert.

- [ ] **Step 2: Write `.github/workflows/ci.yml`**

  Exact content:

  ```yaml
  # ═══════════════════════════════════════════════════════════════════════════════
  # ScreenLink — CI (Push/PR to main)
  #
  # Runs type checks and vitest suites across all workspace packages on every push
  # and pull_request to main. Catches regressions before they reach release.
  #
  # Does NOT build native helpers or package the app — only TypeScript-level
  # verification. This keeps CI fast (<5 min typical).
  # ═══════════════════════════════════════════════════════════════════════════════

  name: CI

  on:
    push:
      branches: [main]
    pull_request:
      branches: [main]

  concurrency:
    group: ci-${{ github.ref }}
    cancel-in-progress: true

  permissions:
    contents: read
    checks: write

  env:
    NODE_VERSION: "24"
    PNPM_VERSION: "10"

  jobs:
    test:
      name: TypeCheck + Tests
      runs-on: windows-latest

      steps:
        - name: Check out repository
          uses: actions/checkout@v4
          with:
            fetch-depth: 1

        - name: Setup Node.js ${{ env.NODE_VERSION }}
          uses: actions/setup-node@v4
          with:
            node-version: ${{ env.NODE_VERSION }}

        - name: Setup pnpm ${{ env.PNPM_VERSION }}
          uses: pnpm/action-setup@v4
          with:
            version: ${{ env.PNPM_VERSION }}

        - name: Get pnpm store directory
          id: pnpm-store
          shell: pwsh
          run: |
            echo "store_path=$(pnpm store path)" >> $env:GITHUB_OUTPUT

        - name: Cache pnpm store
          uses: actions/cache@v4
          with:
            path: ${{ steps.pnpm-store.outputs.store_path }}
            key: ${{ runner.os }}-pnpm-store-${{ hashFiles('pnpm-lock.yaml') }}
            restore-keys: |
              ${{ runner.os }}-pnpm-store-

        - name: Install dependencies
          run: pnpm install --frozen-lockfile

        - name: Type check all packages
          run: pnpm typecheck

        - name: Run all tests
          id: run-tests
          run: pnpm test:all -- --reporter=verbose

        - name: Upload test results (on failure)
          if: failure() && steps.run-tests.outcome == 'failure'
          uses: actions/upload-artifact@v4
          with:
            name: test-results
            path: |
              **/vitest-report/**
              **/test-results/**
            if-no-files-found: ignore
  ```

- [ ] **Step 3: Verify CI workflow YAML structure**

  Check whether an already-declared YAML parser is available in the project's dependency tree. Do NOT install any package solely for validation.

  **If js-yaml is a declared dependency (direct or transitive):**
  ```
  $jsYamlAvail = pnpm ls js-yaml --depth=0 2>$null
  if ($LASTEXITCODE -eq 0) {
    node -e "const fs=require('fs'); const yaml=require('js-yaml'); const doc=yaml.load(fs.readFileSync('.github/workflows/ci.yml','utf8')); console.log('YAML parsed OK. Jobs: ' + Object.keys(doc.jobs||{}).join(', '))"
  }
  ```
  If `pnpm ls` succeeds (js-yaml is a declared dependency), the parser confirms the file is well-formed YAML.

  **If no YAML parser is declared:** Perform a manual line-by-line structural review. This is NOT YAML syntax validation — it is a structural correctness check. The definitive parse happens when GitHub Actions reads the file on push. No package is installed for validation.

  Manual line-by-line structural review checklist (step through each line):
  ```
  Line 108  name: CI                          # key: value pair, no trailing colon
  Line 110  on:                               # block start
  Line 111    push:                           # 2-space indent under on:
  Line 112      branches: [main]              # 4-space, inline array value
  Line 113    pull_request:                   # same indent as push:
  Line 114      branches: [main]              # 4-space
  Line 116  concurrency:                      # root-level key
  Line 117    group: ci-${{ github.ref }}     # 2-space, GitHub expression
  Line 118    cancel-in-progress: true        # 2-space, lowercase boolean
  Line 120  permissions:                      # root level
  Line 121    contents: read                  # 2-space
  Line 122    checks: write                   # 2-space
  Line 124  env:                              # root level
  Line 125    NODE_VERSION: "24"              # 2-space, quoted string
  Line 126    PNPM_VERSION: "10"              # 2-space
  Line 128  jobs:                             # root level
  Line 129    test:                           # 2-space job name
  Line 130      name: TypeCheck + Tests       # 4-space
  Line 131      runs-on: windows-latest       # 4-space
  Line 133      steps:                        # 4-space list start
  Line 134        - name: Check out...        # 8-space list item
  Line 135          uses: actions/checkout@v4 # 10-space
  Line 137            fetch-depth: 1          # 12-space under with:
  ```
  Key structural rules verified:
  - [ ] All indentation uses spaces (no tabs — GitHub Actions rejects tabs)
  - [ ] Indentation is consistent in multiples of 2
  - [ ] List items use `- ` (dash + space) at correct indent
  - [ ] All boolean values are lowercase (`true`/`false` not `True`/`TRUE`)
  - [ ] All `${{ }}` GitHub expressions have balanced braces
  - [ ] `on:` has at least one event type with branches
  - [ ] `steps:` contains at least one step
  - [ ] `runs-on:` specifies a valid runner label
  - [ ] No unquoted colons or special YAML chars in string values
  - [ ] `|` literal block scalar used correctly for multiline `run:` values
  - [ ] `if:` expression uses valid GitHub functions (`failure()`)
  - [ ] No trailing whitespace on any line

- [ ] **Step 4: Simulate the CI job locally (no GitHub runner)**

  Run each of these commands and record success/failure:

  1. `pnpm install --frozen-lockfile` (verify lockfile is up to date)
  2. `pnpm typecheck`
  3. `pnpm test:all -- --reporter=verbose | Tee-Object -FilePath "ci-simulation-output.txt"`

  Save the full output to `docs/superpowers/evidence/2026-07-12-ci-simulation.txt`

- [ ] **Step 5: Verify release.yml still works independently**

  Run: `node -e "const fs=require('node:fs'); const yml=fs.readFileSync('.github/workflows/release.yml','utf8'); if(yml.includes('pnpm test') && !yml.includes('pnpm test:all')){console.log('release.yml uses pnpm test (shared only, correct — no change needed')}else{console.log('UNEXPECTED: release.yml references test:all'); process.exit(1)}"`
  Expected: release.yml still uses `pnpm test` (shared-only). This is correct because the release workflow is already tested via `workflow_dispatch` and changing it is out of scope.

- [ ] **Step 6: Status checkpoint — record git state**

  Run: `git status --short`
  Expected: Only modified `package.json` and new `.github/workflows/ci.yml` (and optional `docs/superpowers/evidence/ci-simulation-full.txt`). No other changes.

---

### Task 3: Exhaustive Verification Matrix (All Test Surfaces)

This task establishes the exact commands, expected outcomes, and evidence-collection procedures for every verification surface. Run ALL of these AFTER the CI workflow is in place.

**Subtask 3A: Shared Package**

- [ ] **3A-1: Run shared tests directly**

  Run: `pnpm --filter @screenlink/shared exec vitest run --reporter=verbose 2>&1 | Tee-Object -FilePath "docs/superpowers/evidence/2026-07-12-shared-test-output.txt"`
  Expected: All 19 shared test files execute. Count: `Get-ChildItem packages/shared/tests/*.test.* | Measure-Object | Select-Object -ExpandProperty Count` should be 19.
  Record: pass/fail count, any skips.

- [ ] **3A-2: Verify root `pnpm test` produces identical output**

  Run: `pnpm test -- --reporter=verbose 2>&1 | Tee-Object -FilePath "docs/superpowers/evidence/2026-07-12-root-test-output.txt"`
  Expected: Number of test files matches 3A-1 exactly. Root `pnpm test` runs ONLY `@screenlink/shared`.

**Subtask 3B: VDO Adapter**

- [ ] **3B-1: Run vdo-adapter tests directly**

  Run: `pnpm --filter @screenlink/vdo-adapter exec vitest run --reporter=verbose 2>&1 | Tee-Object -FilePath "docs/superpowers/evidence/2026-07-12-vdo-adapter-test-output.txt"`
  Expected: All 6 vdo-adapter test files execute. List: `viewer-client.test.ts`, `codec-evidence.test.ts`, `codec-negotiation-order.test.ts`, `codec-capabilities-phase3.test.ts`, `exact-peer-access.test.ts`, `sender-parameters.test.ts`.
  Record: pass/fail count.

- [ ] **3B-2: Type-check vdo-adapter**

  Run: `pnpm --filter @screenlink/vdo-adapter exec tsc --noEmit 2>&1`
  Expected: Exit code 0, no type errors.

**Subtask 3C: Desktop — Main Process Tests**

- [ ] **3C-1: Enumerate all desktop test files by category**

  Run: ```
  Write-Host "=== All .ts test files ==="
  Get-ChildItem apps/desktop/tests/*.test.ts | Select-Object -ExpandProperty Name | Sort-Object
  Write-Host "=== All .tsx test files ==="
  Get-ChildItem apps/desktop/tests/*.test.tsx | Select-Object -ExpandProperty Name | Sort-Object
  Write-Host "=== All .mjs test files ==="
  Get-ChildItem apps/desktop/tests/*.test.mjs | Select-Object -ExpandProperty Name | Sort-Object
  Write-Host "=== Integration test files ==="
  Get-ChildItem apps/desktop/tests/integration/*.test.ts | Select-Object -ExpandProperty Name | Sort-Object
  Write-Host "=== UI test files ==="
  Get-ChildItem apps/desktop/tests/ui/*.test.ts | Select-Object -ExpandProperty Name | Sort-Object
  ```
  Save output to `docs/superpowers/evidence/2026-07-12-desktop-test-inventory.txt`

- [ ] **3C-2: Run desktop tests (full suite)**

  Run: `pnpm --filter @screenlink/desktop exec vitest run --reporter=verbose 2>&1 | Tee-Object -FilePath "docs/superpowers/evidence/2026-07-12-desktop-test-output.txt"`
  Expected: All desktop test files run. The exact count depends on the current number of `.test.ts`/.`test.tsx`/.`test.mjs` files in `apps/desktop/tests/` plus those in subdirectories (`integration/`, `ui/`).
  Record: total pass, total fail, total skipped, duration.

- [ ] **3C-3: Identify any flaky desktop tests**

  Run the full desktop suite twice more:
  ```
  pnpm --filter @screenlink/desktop exec vitest run --reporter=verbose 2>&1 | Tee-Object -FilePath "docs/superpowers/evidence/2026-07-12-desktop-test-output-2.txt"
  pnpm --filter @screenlink/desktop exec vitest run --reporter=verbose 2>&1 | Tee-Object -FilePath "docs/superpowers/evidence/2026-07-12-desktop-test-output-3.txt"
  ```
  Cross-reference: Any test that passes in one run but fails in another is flaky. Record as known flaky tests in the evidence file `docs/superpowers/evidence/2026-07-12-flaky-tests.txt`.

**Subtask 3D: Full Workspace (`pnpm test:all`)**

- [ ] **3D-1: Run the new comprehensive command**

  Run: `pnpm test:all -- --reporter=verbose 2>&1 | Tee-Object -FilePath "docs/superpowers/evidence/2026-07-12-test-all-comprehensive.txt"`
  Expected: Combines output from 3A-1 + 3B-1 + 3C-2 — all three packages' test suites execute. Total test file count should be sum of shared (19) + vdo-adapter (6) + desktop (varies).

- [ ] **3D-2: Verify no package is silently excluded**

  Run: ```
  $output = Get-Content "docs/superpowers/evidence/2026-07-12-test-all-comprehensive.txt" -Raw
  $hasShared = $output -match "@screenlink/shared"
  $hasVdo = $output -match "@screenlink/vdo-adapter"
  $hasDesktop = $output -match "@screenlink/desktop"
  Write-Host "Shared tested: $hasShared"
  Write-Host "VDO adapter tested: $hasVdo"
  Write-Host "Desktop tested: $hasDesktop"
  if (-not ($hasShared -and $hasVdo -and $hasDesktop)) { Write-Host "ERROR: missing package coverage!" }
  ```
  Expected: All three packages are tested.

**Subtask 3E: Desktop Integration Tests (Native Helpers)**

- [ ] **3E-1: List integration tests**

  Run: `Get-ChildItem apps/desktop/tests/integration/*.test.ts | Select-Object -ExpandProperty FullName`
  Expected: `apps/desktop\tests\integration\helper-service.test.ts`

- [ ] **3E-2: Check if integration tests require built native helpers**

  Read: `Get-Content apps/desktop/tests/integration/helper-service.test.ts -Head 30`
  Verify whether it imports native addons or spawns helper processes. If so, these tests require CMake-built native binaries.

  If integration tests require native binaries:
  - Run: `pnpm audio-helper:build` first
  - Run: `pnpm video-enhancer:build` first (or ensure non-VFX build)
  - Then: `pnpm --filter @screenlink/desktop exec vitest run tests/integration/ --reporter=verbose 2>&1`
  - Record results to `docs/superpowers/evidence/2026-07-12-integration-test-output.txt`

  If integration tests use mocks/no native dependencies, they are already included in 3C-2.

**Subtask 3F: Type Checking Verification**

- [ ] **3F-1: Full workspace typecheck**

  Run: `pnpm typecheck 2>&1 | Tee-Object -FilePath "docs/superpowers/evidence/2026-07-12-typecheck-output.txt"`
  Expected: Exit code 0, no type errors.

- [ ] **3F-2: Individual package typecheck (for isolation)**

  ```
  pnpm --filter @screenlink/shared exec tsc --noEmit
  pnpm --filter @screenlink/vdo-adapter exec tsc --noEmit
  pnpm --filter @screenlink/desktop exec tsc -p tsconfig.main.json --noEmit
  pnpm --filter @screenlink/desktop exec tsc -p tsconfig.preload.json --noEmit
  pnpm --filter @screenlink/desktop exec tsc -p tsconfig.renderer.json --noEmit
  ```
  Record any failures to `docs/superpowers/evidence/2026-07-12-typecheck-per-package.txt`

---

### Task 4: Conflict-Safety Checks (Concurrent Agent Protocol)

**Files:**
- Read-only checks (no file creation)

- [ ] **Step 1: Verify no other agent has modified `package.json`**

  Run: `git diff package.json`
  Expected: Only the `"test:all"` script addition is shown. No other changes.

  If the diff shows changes from another agent (e.g., version bumps, dependency additions), DO NOT revert. Integrate the `test:all` addition alongside the concurrent change by reading the current file state and re-applying only the test:all edit.

- [ ] **Step 2: Verify no other agent has created `.github/workflows/ci.yml`**

  Run: `Test-Path .github/workflows/ci.yml`
  Expected: `False` (we are creating it now — confirm before creation). If `True`, read it and verify it meets requirements. If it does, skip Task 2. If it doesn't, report findings but do NOT overwrite.

- [ ] **Step 3: Verify no other agent has modified `.github/workflows/release.yml`**

  Run: `git status --short .github/workflows/release.yml`
  Expected: No output (file is clean). This file must not be modified by this plan.

  If release.yml IS modified: read the diff, document what changed, and verify our CI workflow is still compatible (different triggers, different job names — should be no conflict).

- [ ] **Step 4: Verify no other agent holds a lock on evidence directory**

  Run: `Test-Path docs/superpowers/evidence`
  If `True`, enumerate files: `Get-ChildItem docs/superpowers/evidence | Select-Object Name`
  If files from another plan are present, append to them with clear section separators rather than overwriting.

- [ ] **Step 5: Final conflict reconciliation**

  Run: `git status --short`
  Verify all uncommitted changes belong to this plan:
  - `M package.json` (only the `test:all` addition)
  - `?? .github/workflows/ci.yml` (new CI workflow)
  - `?? docs/superpowers/evidence/ci-simulation-full.txt` (CI simulation output, optional)
  - `?? docs/superpowers/plans/2026-07-12-pipeline-verification-ci.md` (this plan)

  If ANY unexpected file is modified, investigate before proceeding.

---

### Task 5: Evidence Collection and Baseline Documentation

- [ ] **Step 1: Create evidence directory**

  Run: `if (-not (Test-Path "docs/superpowers/evidence")) { New-Item -ItemType Directory -Path "docs/superpowers/evidence" -Force }`

- [ ] **Step 2: Collect CI workflow validation**

  Run all CI commands locally (as they would run in GitHub Actions) and pipe output:
  ```
  $results = @()
  $results += "=== ScreenLink CI Simulation ===`n"
  $results += "Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`n"
  $results += "Git SHA: $(git rev-parse HEAD)`n`n"

  # Node/pnpm versions
  $results += "Node: $(node --version)`n"
  $results += "pnpm: $(pnpm --version)`n`n"

  # pnpm install (frozen-lockfile)
  $installOutput = pnpm install --frozen-lockfile 2>&1
  $results += "=== pnpm install --frozen-lockfile ===`n$installOutput`n`n"

  # Typecheck
  $typecheckOutput = pnpm typecheck 2>&1
  $results += "=== pnpm typecheck ===`n$typecheckOutput`n`n"

  # Full test suite
  $testOutput = pnpm test:all -- --reporter=verbose 2>&1
  $results += "=== pnpm test:all -- --reporter=verbose ===`n$testOutput`n"

  $results | Out-File -FilePath "docs/superpowers/evidence/2026-07-12-ci-simulation-full.txt" -Encoding utf8
  ```

- [ ] **Step 3: (reserved)**

---

### Task 6: Self-Review — Spec Coverage Verification

- [ ] **Step 1: Map hardening spec §12.3 requirements to plan tasks**

  | Spec Requirement | Plan Task |
  |---|---|
  | Add `ci.yml` on push + PR to main | Task 2 |
  | Must use command that runs desktop tests | Task 2 (uses `pnpm test:all`) |
  | windows-latest, Node 24, pnpm 10 | Task 2 (`env:` block) |
  | No build/packaging | Task 2 (no build steps) |
  | No modification to release.yml | Task 2 (new file only) |
  | Root `pnpm test` currently shared-only | Task 1 (adds `test:all`, preserves `test`) |
  | CI gap: desktop tests absent from CI | Task 2 resolves this |

- [ ] **Step 2: Check for placeholders**

  Search the plan for any of:
  - "TBD", "TODO", "implement later", "fill in details"
  - "Add appropriate error handling" (without code)
  - "Write tests for the above" (without test code)
  - "Similar to Task N"
  - References to undefined types/functions

  Fix any found.

- [ ] **Step 3: Verify exact paths match actual filesystem**

  Cross-reference every path in this plan:
  - `package.json` → exists at root
  - `.github/workflows/ci.yml` → does not exist yet (will be created)
  - `.github/workflows/release.yml` → exists
  - `packages/shared/package.json` → exists, `"test": "vitest run"` confirmed
  - `packages/vdo-adapter/package.json` → exists, `"test": "vitest run"` confirmed
  - `apps/desktop/package.json` → exists, `"test": "vitest run"` confirmed
  - `docs/superpowers/evidence/` → will be created
  - All test file paths → verified via glob earlier

- [ ] **Step 4: Verify commands are OS-correct (Windows/PowerShell)**

  Every `Run:` line in this plan uses PowerShell 5.1 syntax (the shell on this system). Check specifically:
  - `2>&1` — works in PowerShell 5.1 for stderr redirection
  - `Tee-Object` — PowerShell native cmdlet present in 5.1
  - `Get-ChildItem` — works (PowerShell 5.1)
  - `Select-String` — works (PowerShell 5.1)
  - `pnpm --filter` — works cross-platform
  - `vitest run` — works cross-platform
  - Backtick for line continuation — PowerShell 5.1 supports this

- [ ] **Step 5: Verify no commit steps are present**

  The instructions explicitly say "Do not commit." Scan for any `git commit` or `git add` commands. None should exist. If found, remove them and replace with status/verification checkpoints.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-12-pipeline-verification-ci.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
