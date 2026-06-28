# AC-Sharescreen Session Handoff

**Date:** 2026-06-28
**Branch:** main
**Last known HEAD:** f283312 (verify with `git log -1 --oneline`)

---

## Project Summary

ScreenLink / AC-Sharescreen is a screen-sharing desktop app (Electron + React + WebRTC) with an NVIDIA RTX VSR (Video Super Resolution) enhancement pipeline and a bandwidth telemetry system. This session focused on repairing and completing the bandwidth/graph and NVIDIA RTX VSR implementations across 18 phases with Oracle review gates.

---

## Completed Work

### Phase 2: Test Suite Fixes
- Fixed 2 TypeScript errors, fixed 5 of 6 test failures
- Full test suite: 105/105 test files passing (1513 individual tests)

### Phase 3: Bandwidth Telemetry Core Fixes
- **Fix 1:** Bucket boundary byte loss in `aggregateIntoSample` — off-by-one in bucket end-time comparison
- **Fix 2:** Clock mismatch in `buildSnapshot` — switched to `performance.now()` monotonic clock
- **Fix 3:** Auto-markers in `setSessionState` — state transitions now emit markers
- **Fix 4:** Removed 18 backward-compat methods + 5 viewer-side tracker fields from `StreamMetricsService`
- **Fix 5:** Updated tests (35 tests pass, removed backward-compat test blocks)
- **Fix 6:** Updated downstream callers

### Phase 4: Duplicate Bandwidth Tracker Removal
- Removed inline bandwidth tracker from `ViewerWorkspace.tsx` (now reads from `StreamMetricsService.getSnapshot`)
- Deleted standalone `viewer-bandwidth.ts` module + `viewer-bandwidth.test.ts`
- **StreamMetricsService is now the single canonical bandwidth tracking source**

### Phase 10: Fake NVIDIA VSR Backend Removal
- Deleted `nvidia-vsr-viewer-image-backend.ts` (stub that always returned `success:false`)
- Deleted `viewer-image-nvidia-backend.test.ts`
- Removed `"nvidia-vsr"` from `BackendKind` type
- Simplified factory to always go to WebGL2
- Removed retry logic from `EnhancedVideoSurface`
- Updated factory tests (5 NVIDIA tests removed)
- **1489 tests passing** (down from 1513 — expected due to removed NVIDIA tests)

### Panel Architecture: contentOnly Prop (Partial)
- Added `contentOnly?: boolean` prop to all 3 panel component interfaces + destructuring
- **DiagnosticsPanel:** `contentOnly` conditional rendering DONE (extracted `content` variable, early return for contentOnly mode)
- **ViewerSettingsPanel:** `contentOnly` prop added to interface + destructuring, keyboard listener skips when contentOnly — but **return statement NOT yet updated** (still always renders Popover wrapper)
- **BandwidthGraphModal:** `contentOnly` prop added to interface + destructuring — but **return statement NOT yet updated** (still always renders TooltipProvider+Popover wrapper)

---

## In-Progress / Remaining Work

### 1. ViewerSettingsPanel contentOnly Conditional Rendering
**File:** `apps/desktop/src/renderer/components/workspace/viewer/ViewerSettingsPanel.tsx`
**What to do:** Extract the `<Tabs defaultValue="general" className="w-full">...</Tabs>` content (lines 407-913) into a `const content = (...)` variable, then add:
```tsx
if (contentOnly) {
  return <div className="w-[750px] p-4">{content}</div>;
}
```
before the existing Popover return. The Popover return should then use `{content}` inside PopoverContent instead of the inline Tabs.
**Pattern to follow:** See `DiagnosticsPanel.tsx` lines 334-467 for the exact same transformation already done.

### 2. BandwidthGraphModal contentOnly Conditional Rendering
**File:** `apps/desktop/src/renderer/components/workspace/BandwidthGraphModal.tsx`
**What to do:** Extract the inner content (the "Bandwidth" title div + ScrollArea, lines 569-~950) into a `const content = (<Fragment>...</Fragment>)` variable, then add:
```tsx
if (contentOnly) {
  return (
    <TooltipProvider>
      <div className="w-[950px] p-4">{content}</div>
    </TooltipProvider>
  );
}
```
before the existing return. The existing return should use `{content}` inside PopoverContent. **Must keep TooltipProvider wrapper** because the inner content uses Tooltip components.
**Pattern to follow:** See `DiagnosticsPanel.tsx` lines 334-467.

### 3. Create ViewerPanelShell (Unified Popover Wrapper)
**New file:** `apps/desktop/src/renderer/components/workspace/viewer/ViewerPanelShell.tsx`
**Purpose:** Replace the 3 independent Popover roots (DiagnosticsPanel, ViewerSettingsPanel, BandwidthGraphModal) with a single unified Popover that shows one panel at a time.
**Design decisions already made:**
- `activePanel` type: `"settings" | "diagnostics" | "bandwidth" | null`
- Single Popover with conditional rendering inside
- Panel sizes: bandwidth=950px, settings/diagnostics=750px
- State loss on close is acceptable
- Anchor positioning: hidden trigger at bottom-center (same as current BandwidthGraphModal pattern)
- The shell renders the 3 panel components with `contentOnly={true}`

**Rough structure:**
```tsx
type ActivePanel = "settings" | "diagnostics" | "bandwidth";

interface ViewerPanelShellProps {
  activePanel: ActivePanel | null;
  onActivePanelChange: (panel: ActivePanel | null) => void;
  // Pass through all props needed by the 3 panels
  session: ViewerSession | null;
  requestState: ViewerRequestState | null;
  onRequestChange: (state: ViewerRequestState | null) => void;
  mediaSessionId: string | null;
  // ... etc
}

export function ViewerPanelShell({ activePanel, onActivePanelChange, ... }: ViewerPanelShellProps) {
  const width = activePanel === "bandwidth" ? "w-[950px]" : "w-[750px]";

  return (
    <Popover open={activePanel !== null} onOpenChange={(open) => { if (!open) onActivePanelChange(null); }}>
      <div className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 opacity-0 pointer-events-none" aria-hidden="true">
        <PopoverTrigger asChild><span /></PopoverTrigger>
      </div>
      <PopoverContent side="top" align="center" className={`${width} p-4`}>
        {activePanel === "settings" && <ViewerSettingsPanel contentOnly {...settingsProps} />}
        {activePanel === "diagnostics" && <DiagnosticsPanel contentOnly {...diagnosticsProps} />}
        {activePanel === "bandwidth" && <BandwidthGraphModal contentOnly {...bandwidthProps} />}
      </PopoverContent>
    </Popover>
  );
}
```

### 4. Update ViewerWorkspace.tsx
**File:** `apps/desktop/src/renderer/components/workspace/ViewerWorkspace.tsx` (~1882 lines)
**What to do:**
- Replace `panelsOpen` boolean state + `bandwidthGraphOpen` boolean state with single `activePanel: "settings" | "diagnostics" | "bandwidth" | null` state
- Remove the 3 separate Popover-wrapped panel instances
- Add `<ViewerPanelShell>` with the new `activePanel` state
- Wire `onActivePanelChange` to set the state

### 5. Update VideoControls.tsx
**File:** `apps/desktop/src/renderer/components/workspace/viewer/VideoControls.tsx` (~629 lines)
**What to do:**
- Remove `onPanelsOpenChange` and `onBandwidthClick` props
- Add `activePanel` and `onActivePanelChange` props
- Settings cog button: instead of `window.dispatchEvent(new CustomEvent("screenlink:viewer-toggle-settings"))`, call `onActivePanelChange(activePanel === "settings" ? null : "settings")`
- Diagnostics dot: call `onActivePanelChange(activePanel === "diagnostics" ? null : "diagnostics")`
- Bandwidth button: call `onActivePanelChange(activePanel === "bandwidth" ? null : "bandwidth")`
- Remove hidden trigger wrappers for the panels (they move into ViewerPanelShell)

### 6. Native C++ Dead Code Removal
**Status:** Dispatched to fixer but result unverified. May or may not be done.
**Files to check:**
- `native/video-enhancer/src/SharedFrameRing.h` — should be deleted
- `native/video-enhancer/src/NvidiaVsrContext.h` — should be deleted
- `native/video-enhancer/src/CapabilityProbe.h` — should be deleted
- `native/video-enhancer/src/CMakeLists.txt` — references to these files should be removed
- `native/video-enhancer/src/main.cpp` — SimpleJson payload nesting fix (TS sends object, C++ tries GetString → always fails)
**Verify with:** Check if those .h files still exist on disk. If they do, delete them and update CMakeLists.txt.

### 7. Fix RTX Control Protocol
**Priority:** Medium
**Issues:**
- **Payload nesting mismatch:** TypeScript sends `{ type: "command", payload: { ... } }` but C++ tries `GetString("type")` on the inner payload — always fails because the inner payload is an object not a string
- **Request/response IDs:** No correlation between requests and responses
- **Command queue:** No queuing of commands, potential race conditions
**Files:**
- `apps/desktop/src/main/VideoHelperManager.ts` — TS side (528 lines, `submitFrame` returns false — kept as placeholder)
- `native/video-enhancer/src/main.cpp` — C++ side

### 8. Oracle Gate 2 Review
**When:** After items 1-5 (panel unification) are complete
**What:** Code review of all changes by @oracle agent before declaring phase complete

---

## Key Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| StreamMetricsService = canonical bandwidth collector | Eliminated 2 duplicate trackers (inline + standalone) |
| Removed fake NVIDIA VSR backend | Was a stub always returning `success:false`; real VFX SDK headers/libs not in repo |
| Kept `submitFrame` no-op in VideoHelperManager | Placeholder for Phase 13 wiring, not fake RTX |
| Kept NVIDIA VSR as unavailable in ProcessingBackend type | Users can request it, falls back to WebGL2 |
| Kept nvidia-capability-service.ts + IPC + preload | Architecture preserved for future real SDK integration |
| Panel unification via contentOnly + ViewerPanelShell | 3 independent Popover roots → single activePanel state |
| State loss on panel close acceptable | Panels are read-heavy, re-init cost is low |

---

## Critical File Map

| File | Lines | Status |
|------|-------|--------|
| `apps/desktop/src/renderer/services/stream-metrics-service.ts` | — | Canonical bandwidth collector (all fixes applied) |
| `apps/desktop/src/renderer/services/bandwidth-telemetry-types.ts` | — | BandwidthSnapshot type (has `currentBitsPerSecond` + `totalBytes`) |
| `apps/desktop/src/renderer/components/workspace/ViewerWorkspace.tsx` | ~1882 | Inline tracker REMOVED; panelsOpen/bandwidthGraphOpen state still present (pending unification) |
| `apps/desktop/src/renderer/components/workspace/viewer/VideoControls.tsx` | ~629 | Hidden trigger wrappers, onPanelsOpenChange, onBandwidthClick (pending unification) |
| `apps/desktop/src/renderer/components/workspace/viewer/DiagnosticsPanel.tsx` | ~468 | contentOnly conditional rendering DONE |
| `apps/desktop/src/renderer/components/workspace/viewer/ViewerSettingsPanel.tsx` | ~917 | contentOnly prop added, keyboard listener skips, but return NOT yet updated |
| `apps/desktop/src/renderer/components/workspace/BandwidthGraphModal.tsx` | ~957 | contentOnly prop added, but return NOT yet updated |
| `apps/desktop/src/renderer/services/viewer-image-processing/viewer-image-backend-factory.ts` | — | NVIDIA VSR branch REMOVED, always goes to WebGL2 |
| `apps/desktop/src/renderer/services/viewer-image-processing/viewer-image-backend.ts` | — | BackendKind = "webgl2" \| "unavailable" |
| `apps/desktop/src/renderer/components/workspace/viewer/EnhancedVideoSurface.tsx` | — | NVIDIA retry logic REMOVED |
| `apps/desktop/src/main/VideoHelperManager.ts` | ~528 | submitFrame returns false (placeholder) |
| `native/video-enhancer/src/main.cpp` | — | C++ video enhancer, dead code removal unverified |
| `native/video-enhancer/src/FrameTransport.cpp` | ~212 | Named pipe transport, functional but unwired |

### Deleted Files
- `apps/desktop/src/renderer/services/viewer-bandwidth.ts`
- `apps/desktop/tests/viewer-bandwidth.test.ts`
- `apps/desktop/src/renderer/services/viewer-image-processing/nvidia-vsr-viewer-image-backend.ts`
- `apps/desktop/tests/viewer-image-nvidia-backend.test.ts`

---

## Test Status

- **1489 tests passing** (down from 1513 — expected due to removed NVIDIA backend tests)
- Run with: `npx vitest run` from `apps/desktop/`
- C++ LSP errors on Windows are pre-existing (C++17 flags not configured in LSP, not actual build issues)

---

## Constraints & Rules

1. **Do not trust** comments, filenames, test names, or previous reports as proof — verify on disk
2. **Do not call** ordinary bilinear/bicubic/Lanczos/CUDA/NPP resizing = NVIDIA VSR
3. **Do not keep** two bandwidth systems active
4. **Do not declare** visual success from component unit tests
5. **Do not weaken** tests to fit broken behavior
6. **Preserve** Quick Share/Quick Join shortcut feature and run regression tests
7. **No new branch** or worktree unless explicitly instructed
8. **Do not use `grep` tool** on this machine — it hangs. Use `Select-String` (PowerShell), `glob`, `ast_grep_search`, or `read` instead
9. **ComfyUI parent repo** (if referenced): `C:\Users\parla\OneDrive\Documents\AI HUB\ComfyUI\ComfyUI`

---

## Recommended Next Steps (Ordered)

1. **ViewerSettingsPanel contentOnly return** — extract Tabs into `content` variable, add conditional return (follow DiagnosticsPanel pattern)
2. **BandwidthGraphModal contentOnly return** — same pattern, keep TooltipProvider wrapper
3. **Create ViewerPanelShell.tsx** — unified popover wrapper
4. **Update ViewerWorkspace.tsx** — replace panelsOpen/bandwidthGraphOpen with activePanel state
5. **Update VideoControls.tsx** — replace onPanelsOpenChange/onBandwidthClick with activePanel/onActivePanelChange
6. **Verify native C++ cleanup** — check if SharedFrameRing.h, NvidiaVsrContext.h, CapabilityProbe.h still exist
7. **Fix RTX control protocol** — payload nesting, request/response IDs
8. **Oracle Gate 2 review** — after panel unification is complete
9. **Run full test suite** — `npx vitest run` from `apps/desktop/`
