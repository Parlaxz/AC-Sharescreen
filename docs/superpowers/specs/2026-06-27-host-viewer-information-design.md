# Host Viewer Information — Design Spec

**Date:** 2026-06-27
**Status:** Approved

## Overview

Expand the HostDashboard so the host can see each connected viewer's real-time state, diagnostics, and quality settings. Three sub-features:

1. **Per-viewer diagnostics** — sent bitrate, packet loss, RTT, sent resolution, FPS, codec (host-observed from local WebRTC stats); received resolution, FPS, bitrate (viewer-reported).
2. **Report viewer settings** — show what quality each viewer requested, read from existing QualityCoordinator.
3. **Paused viewer visibility** — keep paused viewers in the viewer list with clear "Paused" indicator and note that their control connection is still active.

## Design Principles

- **No new background services.** One dashboard-scoped hook owns all polling and state.
- **No main-process IPC.** Everything runs in the renderer process where the SDK and QualityCoordinator live.
- **No Zustand changes for rapidly changing data.** Only persistent control state (if needed) goes in the store.
- **One message type.** `viewer.status` carries state, received media stats, and is sent immediately on state transitions.
- **Three data sources, one merged view:**
  1. `viewer.status` message → what the viewer receives and displays
  2. Host-side SDK `getStats()` polling → what the host sends, RTT, loss, codec
  3. QualityCoordinator → what the viewer requested

---

## Data Model

### 1. `viewer.status` message (viewer → host, via group control channel)

New message type in `@screenlink/shared` control-messages schema.

```typescript
interface ViewerStatus {
  viewerDeviceId: string;
  streamId: string;

  state: "playing" | "paused" | "reconnecting";

  receivedBitrateKbps: number | null;
  receivedWidth: number | null;
  receivedHeight: number | null;
  displayedFps: number | null;

  sampledAt: number;
}
```

**Send schedule:**
- Every 2 seconds while `state === "playing"` or `"reconnecting"`
- Immediately when pausing begins (state: "paused", media values: null)
- Immediately when resuming begins (state: "reconnecting", media values: null)
- Immediately after resume succeeds (state: "playing", fresh media values)
- When paused, all media fields are null

**Bandwidth impact:** ~200 bytes per message. At 0.5 msg/s per viewer, roughly 1 kbps per active viewer.

### 2. Host-observed stats (local SDK polling)

Not a message. Polled directly from the host's `sdk.connections` Map.

```typescript
interface HostObservedViewerStats {
  sentBitrateKbps: number | null;
  packetLossPercent: number | null;
  rttMs: number | null;
  sentWidth: number | null;
  sentHeight: number | null;
  sentFps: number | null;
  codec: string | null;
}
```

Source: `RTCPeerConnection.getStats()` on each `group.publisher.pc` for `outbound-rtp`, `remote-inbound-rtp`, `candidate-pair`, and `codec` stats.

### 3. Combined display model (`ViewerRow`)

Local to the HostDashboard component. Not persisted in Zustand.

```typescript
interface ViewerRow {
  viewerDeviceId: string;
  displayName: string;
  connectedAt: number;

  state: "playing" | "paused" | "reconnecting" | "unknown";

  received: {
    bitrateKbps: number | null;
    width: number | null;
    height: number | null;
    fps: number | null;
  };

  sent: {
    bitrateKbps: number | null;
    width: number | null;
    height: number | null;
    fps: number | null;
    packetLossPercent: number | null;
    rttMs: number | null;
    codec: string | null;
  };

  requested: {
    bitrateKbps: number | null;
    width: number | null;
    height: number | null;
    fps: number | null;
    presetName: string | null;
  };

  lastStatusAt: number | null;
}
```

### 4. Zustand store (unchanged unless proven necessary)

`ViewerInfo` remains as-is. The viewer list (`store.viewers`) is driven by control connections (join/leave). Pause does not remove a viewer.

State is derived from the latest `ViewerStatus`:
- Recent status says "playing" → Playing
- Recent status says "paused" → Paused
- Recent status says "reconnecting" → Reconnecting
- No recent status → "unknown"

---

## Architecture

```
VIEWER                                    HOST
======                                    ====

ViewerSession                             HostDashboard
├─ Every 2s:                              │
│   └─ poll inbound-rtp (existing)        ├─ useHostViewerDiagnostics() hook
│       └─ build ViewerStatus             │   │
│           └─ send "viewer.status"       │   ├─ Receives ViewerStatus via
│                                         │   │   window CustomEvent
│ On pause/resume:                        │   │   (dispatch from
│   └─ send "viewer.status" immediately   │   │    GroupMessageRouter)
│                                         │   │
        ╲                                 │   ├─ Polls SDK connections
         ╲  group control channel         │   │   (outbound-rtp, candidate-pair)
          ╲                               │   │
           ──────────────────────────────→│   ├─ Reads QualityCoordinator
                                         │   │   for viewer requests
GroupMessageRouter                       │   │
├─ Route "viewer.status"                 │   └─ Returns ViewerRow[]
│   └─ dispatch custom event             │
│       "screenlink:viewer-status"       │ HostDashboard
│                                        │ └─ Renders viewer list from
│                                        │     ViewerRow[]
```

### Key points

- **GroupMessageRouter** receives `viewer.status` and dispatches a `window.dispatchEvent(new CustomEvent("screenlink:viewer-status", { detail }))`. This follows the existing pattern used for `quality.effective` and `quality.configured`.
- **The hook is mounted only while the HostDashboard is visible.** No background polling.
- **No new IPC channels.**
- **No Zustand changes** — ViewerInfo stays as-is unless the current code removes paused viewers from the store (in which case that removal is removed).

---

## Component Changes

### Files to create

| File | Purpose |
|------|---------|
| `apps/desktop/src/renderer/hooks/use-host-viewer-diagnostics.ts` | Hook that merges ViewerStatus + host SDK stats + QualityCoordinator into `ViewerRow[]` |

### Files to modify

| File | Change |
|------|--------|
| `packages/shared/src/control-messages.ts` | Add `"viewer.status"` type and `ViewerStatusPayloadSchema` |
| `packages/shared/src/index.ts` | Export new types |
| `apps/desktop/src/renderer/services/viewer-session.ts` | Add 2s status reporting interval; send on pause/resume transitions |
| `apps/desktop/src/renderer/services/group-message-router.ts` | Route `viewer.status` → dispatch `screenlink:viewer-status` CustomEvent |
| `apps/desktop/src/renderer/services/quality-coordinator.ts` | Expose read-only query for viewer's latest request (if not already public) |
| `apps/desktop/src/renderer/components/workspace/HostDashboard.tsx` | Add viewer list section using `useHostViewerDiagnostics()` |

### Files NOT changed

- `main-store.ts` — no changes unless current code removes paused viewers
- `connection-access.ts` — reused as-is via SDK access in the hook
- `media-stats.ts` — reused patterns, but hook will do its own focused polling
- `viewer-media-binding.ts` — ViewerMediaBinding viewer tracking is unchanged

---

## Hook: `useHostViewerDiagnostics()`

```typescript
function useHostViewerDiagnostics(
  sdk: VDONinjaSDK | null,
  viewers: ViewerInfo[],
  qualityCoordinator: QualityCoordinator | null,
  groupId: string,
  logicalStreamId: string,
): ViewerRow[]
```

**Behavior:**
1. Maintains a `Map<viewerDeviceId, ViewerStatus>` updated by `screenlink:viewer-status` events.
2. Every 2s, for each viewer with a known peer UUID, polls `sdk.connections.get(uuid).publisher.pc.getStats()`.
3. Computes `HostObservedViewerStats` from outbound-rtp, remote-inbound-rtp, candidate-pair, and codec stats.
4. Reads QualityCoordinator per-viewer requests.
5. Merges everything into `ViewerRow[]`.
6. Cleans up on unmount (clears interval, removes event listener).

**Error handling:**
- If SDK is null (not connected), returns empty array.
- If a viewer's PC throws on `getStats()`, that viewer gets null sent stats for that cycle.
- Stale ViewerStatus (>10s since last message) → state becomes "unknown".

---

## UI: HostDashboard viewer list

Appended as the bottom section of HostDashboard (after the connection status bar).

### Playing viewer row
```
● Alice                                      Playing
Sent 1080p 30 FPS → Received 720p 28 FPS
1.2 Mbps · RTT 28 ms · Loss 0.1% · VP9
Requested: Balanced · 1080p · 30 FPS · 2 Mbps
```

### Paused viewer row
```
⏸ Bob                                        Paused
Control connection active · Media stopped
```

### Reconnecting viewer row
```
◐ Charlie                              Reconnecting
Waiting for media statistics
```

### Unknown state viewer row
```
○ Dana                                        No report
No status received yet
```

### Visual notes
- Status dot: green (playing), yellow/amber (paused), orange with pulse animation (reconnecting), gray (unknown)
- The viewer count badge in the header already shows total viewers. Paused and reconnecting viewers count toward this total.
- Requested quality row is only shown when the viewer has explicitly requested different settings (not using group defaults).
- When sent/received values differ significantly (e.g. sent 1080p but received 720p), the arrow `→` makes the direction clear.
- No collapse control in initial implementation.

---

## ViewerSession Changes

Add a status reporting interval:

```
start()          → begin 2s status reporting interval
pause()          → send "viewer.status" immediately with state:"paused"
resume() start   → send "viewer.status" immediately with state:"reconnecting"
resume() success → send "viewer.status" immediately with state:"playing"
stop()/destroy() → clear status reporting interval
```

The interval uses the existing `getDiagnostics()` method to read inbound stats, then builds a `ViewerStatus` payload and sends it via the group control channel.

---

## Scope Boundaries

**In scope:**
- `viewer.status` message type and schema
- Viewer status reporting interval in ViewerSession
- GroupMessageRouter routing for `viewer.status`
- `useHostViewerDiagnostics()` hook
- HostDashboard viewer list UI
- QualityCoordinator read-only query (if needed)

**Out of scope:**
- Historical diagnostics or charts
- Detailed ICE internals (candidate types, relay vs direct)
- NACK, PLI, FIR, or cumulative counters in the main UI
- Audio stats (focus is video diagnostics)
- Collapsible viewer list (YAGNI for now)
- Viewer-side changes beyond the status message (DiagnosticsPanel unchanged)
- Any main-process changes or new IPC channels

---

## Testing

- **Unit:** `useHostViewerDiagnostics` hook — mock SDK, QualityCoordinator, events
- **Unit:** ViewerSession status interval — verify message contents on play/pause/resume
- **Integration:** GroupMessageRouter routes `viewer.status` to window event
- **Manual:** Host shares screen, viewer joins, verify diagnostics appear, pause viewer, verify paused state visible

---

## References

- `packages/vdo-adapter/src/media-stats.ts` — existing stats polling pattern
- `packages/vdo-adapter/src/connection-access.ts` — SDK connection access
- `apps/desktop/src/renderer/components/workspace/viewer/DiagnosticsPanel.tsx` — viewer-side diagnostics (existing pattern for real stats display)
- `apps/desktop/src/renderer/services/group-message-router.ts` — existing message routing (see quality.effective for CustomEvent dispatch pattern)
- `apps/desktop/src/renderer/services/quality-coordinator.ts` — per-viewer quality requests
