# Host Viewer Information Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-viewer diagnostics, quality settings, and paused-vs-active visibility to HostDashboard.

**Architecture:** One new message type (`viewer.status`) carries viewer-side state from ViewerSession to the host. One dashboard-scoped hook (`useHostViewerDiagnostics`) merges viewer-reported data, host-side SDK stats, and QualityCoordinator requests into `ViewerRow[]`. No new Zustand state, no IPC, no background services.

**Tech Stack:** TypeScript, React 19, Zustand 5, VDO.Ninja SDK, Zod

**Spec:** `docs/superpowers/specs/2026-06-27-host-viewer-information-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/shared/src/group-control-messages.ts` | Modify | Add `viewer.status` type, schema, map entries |
| `packages/shared/src/index.ts` | Verify | Confirm types re-exported (may already re-export from group-control-messages) |
| `apps/desktop/src/renderer/services/viewer-session.ts` | Modify | Replace `sendPauseState` with `sendViewerStatus`; add 2s periodic status reporting |
| `apps/desktop/src/renderer/services/group-message-router.ts` | Modify | Route `viewer.status` → dispatch `screenlink:viewer-status` CustomEvent |
| `apps/desktop/src/renderer/hooks/use-host-viewer-diagnostics.ts` | Create | Dashboard-scoped hook: merges 3 data sources into `ViewerRow[]` |
| `apps/desktop/src/renderer/components/workspace/HostDashboard.tsx` | Modify | Add viewer list section below connection status bar |

---

### Task 1: Add `viewer.status` schema to shared

**Files:**
- Modify: `packages/shared/src/group-control-messages.ts`

- [ ] **Step 1: Add "viewer.status" to GROUP_CONTROL_MESSAGE_TYPES**

In `GROUP_CONTROL_MESSAGE_TYPES` array, add `"viewer.status"` after `"viewer.paused"` (line 33).

```typescript
  "viewer.paused",
  "viewer.status",
```

- [ ] **Step 2: Add ViewerStatusPayloadSchema**

Add after `ViewerPausedPayloadSchema` (after line 541):

```typescript
// ─── Viewer status payload schema ────────────────────────────────────────────

export const ViewerStatusPayloadSchema = z.object({
  viewerDeviceId: z.string(),
  streamId: z.string(),
  state: z.enum(["playing", "paused", "reconnecting"]),
  receivedBitrateKbps: z.number().nullable(),
  receivedWidth: z.number().nullable(),
  receivedHeight: z.number().nullable(),
  displayedFps: z.number().nullable(),
  sampledAt: z.number(),
}).strict();
```

- [ ] **Step 3: Add to GroupControlPayloadMap**

After the `"viewer.paused"` entry (line 639):

```typescript
  "viewer.status": z.infer<typeof ViewerStatusPayloadSchema>;
```

- [ ] **Step 4: Add to payloadSchemaMap**

After the `"viewer.paused"` entry (line 673):

```typescript
  "viewer.status": ViewerStatusPayloadSchema,
```

- [ ] **Step 5: Verify shared package builds**

```bash
cd packages/shared && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/group-control-messages.ts
git commit -m "feat(shared): add viewer.status message schema"
```

---

### Task 2: Add periodic status reporting to ViewerSession

**Files:**
- Modify: `apps/desktop/src/renderer/services/viewer-session.ts`

- [ ] **Step 1: Add status interval fields to ViewerSession class**

Add these private fields near the existing interval/timer fields (after `_readinessTimer`, around line 191):

```typescript
  /** 2-second interval for sending viewer.status reports to the host */
  private _statusInterval: ReturnType<typeof setInterval> | null = null;
```

- [ ] **Step 2: Add `sendViewerStatus` method**

Replace the existing `sendPauseState` method (lines 1271-1289) with:

```typescript
  /**
   * Send a viewer.status report over the group-control channel.
   * Reports current viewer state, received media stats, and the sampled timestamp.
   * Fire-and-forget — the host uses this for the viewer diagnostics list.
   */
  private sendViewerStatus(overrides?: { state?: string }): void {
    const runtime = getRuntime();
    if (!runtime || runtime.isDestroyed()) return;
    if (!this.groupId || !this.hostDeviceId || !this.logicalStreamId) return;

    const conn = runtime.getConnectionManager().getConnection(this.groupId);
    if (!conn) return;

    const peerUuid = conn.peerForDevice(this.hostDeviceId);
    if (!peerUuid) return;

    const state = overrides?.state ?? (() => {
      if (this._pauseState === "paused") return "paused";
      if (this._pauseState === "pausing") return "paused";
      if (this._pauseState === "resuming") return "reconnecting";
      return "playing";
    })();

    // Gather received media stats from diagnostics
    let receivedBitrateKbps: number | null = null;
    let receivedWidth: number | null = null;
    let receivedHeight: number | null = null;
    let displayedFps: number | null = null;

    if (state === "playing" && this.viewerClient) {
      // Non-blocking: if getDiagnostics is stale, send null values
      this.viewerClient.getSDK()?.connections.forEach((group, _uuid) => {
        const pc = group.viewer?.pc ?? group.publisher?.pc;
        if (pc) {
          try {
            // Use getStats directly for minimal overhead per send cycle
            pc.getStats().then(stats => {
              for (const report of stats.values()) {
                if (report.type === "inbound-rtp" && (report as any).kind === "video") {
                  receivedBitrateKbps = (report as any).bitrateEstimate
                    ? Math.round((report as any).bitrateEstimate / 1000)
                    : null;
                  receivedWidth = (report as any).frameWidth ?? null;
                  receivedHeight = (report as any).frameHeight ?? null;
                  displayedFps = (report as any).framesPerSecond ?? null;
                }
              }
            }).catch(() => {});
          } catch { /* best effort */ }
        }
      });
    }

    void conn.sendToPeer(peerUuid, {
      type: "viewer.status",
      viewerDeviceId: runtime.deviceId ?? "viewer",
      streamId: this.logicalStreamId,
      state,
      receivedBitrateKbps,
      receivedWidth,
      receivedHeight,
      displayedFps,
      sampledAt: Date.now(),
    } as Record<string, unknown>).catch(() => {});
  }
```

Note: The async getStats call above races the send. For the initial implementation, send with null media values and let the next 2s cycle catch the resolved promise. This keeps the message fire-and-forget.

Simpler approach — use the existing `getDiagnostics` method but wrap it to build the status:

```typescript
  /**
   * Send a viewer.status report over the group-control channel.
   */
  private async buildAndSendViewerStatus(stateOverride?: string): Promise<void> {
    const runtime = getRuntime();
    if (!runtime || runtime.isDestroyed()) return;
    if (!this.groupId || !this.hostDeviceId || !this.logicalStreamId) return;

    const conn = runtime.getConnectionManager().getConnection(this.groupId);
    if (!conn) return;

    const peerUuid = conn.peerForDevice(this.hostDeviceId);
    if (!peerUuid) return;

    const state = stateOverride ?? (() => {
      if (this._pauseState === "paused" || this._pauseState === "pausing") return "paused" as const;
      if (this._pauseState === "resuming") return "reconnecting" as const;
      return "playing" as const;
    })();

    let receivedBitrateKbps: number | null = null;
    let receivedWidth: number | null = null;
    let receivedHeight: number | null = null;
    let displayedFps: number | null = null;

    if (state !== "paused" && this.viewerClient) {
      try {
        const diag = await this.getDiagnostics();
        if (diag) {
          receivedBitrateKbps = diag.inboundVideo.bitrateBps > 0
            ? Math.round(diag.inboundVideo.bitrateBps / 1000)
            : null;
          receivedWidth = diag.inboundVideo.frameWidth;
          receivedHeight = diag.inboundVideo.frameHeight;
          displayedFps = diag.inboundVideo.framesPerSecond;
        }
      } catch { /* best effort */ }
    }

    void conn.sendToPeer(peerUuid, {
      type: "viewer.status",
      viewerDeviceId: runtime.deviceId ?? "viewer",
      streamId: this.logicalStreamId,
      state,
      receivedBitrateKbps,
      receivedWidth,
      receivedHeight,
      displayedFps,
      sampledAt: Date.now(),
    } as Record<string, unknown>).catch(() => {});
  }
```

- [ ] **Step 3: Add status interval start/stop**

Add `startStatusInterval` and `clearStatusInterval` methods:

```typescript
  private startStatusInterval(): void {
    this.clearStatusInterval();
    this._statusInterval = setInterval(() => {
      if (!this.isCurrent()) {
        this.clearStatusInterval();
        return;
      }
      void this.buildAndSendViewerStatus();
    }, 2000);
    // Send an immediate first report
    void this.buildAndSendViewerStatus();
  }

  private clearStatusInterval(): void {
    if (this._statusInterval) {
      clearInterval(this._statusInterval);
      this._statusInterval = null;
    }
  }
```

- [ ] **Step 4: Integrate into lifecycle**

In `start()` (after `runJoinFlow` is scheduled/called, around line 538), add:
```typescript
    await this.runJoinFlow();
    // Start periodic status reporting once the join flow completes
    if (this.isCurrent() && this._state === "watching") {
      this.startStatusInterval();
    }
```

Wait — `start` doesn't await `runJoinFlow` directly in the `start` method. Let me re-check. The `start` method calls `await this.runJoinFlow()` at line 538. After it completes, if state is "watching", start the interval.

In `pause()` (replace `this.sendPauseState(true)` at line 324):
```typescript
      void this.buildAndSendViewerStatus("paused");
```

In `resume()` — after setting state to "resuming" (line 357), send immediate status:
```typescript
    this.setPauseState("resuming");
    void this.buildAndSendViewerStatus("reconnecting");
```

In `resume()` — after successful resume (line 401), restart interval:
```typescript
      this.clearPosterFrame();
      this.setPauseState("playing");
      // Restart periodic status reporting
      this.startStatusInterval();
```

In `stop()` and `destroy()`, and the teardown path (`beginTeardown`), clear the interval:
```typescript
    this.clearStatusInterval();
```

Also clear it in `setError` (line 1261):
```typescript
    this.clearStatusInterval();
```

- [ ] **Step 5: Remove old sendPauseState calls**

The old `sendPauseState` method is being fully replaced by `buildAndSendViewerStatus`. Remove `sendPauseState` entirely.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/services/viewer-session.ts
git commit -m "feat(viewer): add periodic viewer.status reporting"
```

---

### Task 3: Route `viewer.status` in GroupMessageRouter

**Files:**
- Modify: `apps/desktop/src/renderer/services/group-message-router.ts`

- [ ] **Step 1: Add routing for `viewer.status`**

In `routeMessage()`, after the `viewer.paused` handling (if any exists) and before the quality.* section, add:

```typescript
    // viewer.status → dispatch window event for HostDashboard hook
    if (type === "viewer.status") {
      if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
        const parsed = parseGroupMessagePayload("viewer.status", envelope.payload);
        if (parsed.ok) {
          window.dispatchEvent(new CustomEvent("screenlink:viewer-status", {
            detail: parsed.data,
          }));
        }
      }
      return;
    }
```

Search the `routeMessage` method for the right insertion point. The existing pattern for quality.effective dispatch (around lines 580-591) is the template. Insert before the `quality.*` section (around line 302 where `type.startsWith("quality.viewer.")` is checked).

Note: `viewer.paused` may or may not have a handler currently. If it does, leave it but the new unified message replaces it. If there's no handler, that's fine — we're not adding one for `viewer.paused`.

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/services/group-message-router.ts
git commit -m "feat(host): route viewer.status to window event"
```

---

### Task 4: Create `useHostViewerDiagnostics` hook

**Files:**
- Create: `apps/desktop/src/renderer/hooks/use-host-viewer-diagnostics.ts`

- [ ] **Step 1: Define types and create the hook file**

Create the file with the following content:

```typescript
import { useState, useEffect, useRef, useCallback } from "react";
import type { ViewerInfo } from "@/stores/main-store";
import type { QualityCoordinator } from "@/services/quality-coordinator";
import type { ViewerQualityRequest } from "@screenlink/shared";
import { pollStats } from "@screenlink/vdo-adapter";
import type { StatsSnapshot } from "@screenlink/vdo-adapter";
import type { VDONinjaSDK } from "@screenlink/vdo-adapter/sdk-types";

// ─── Types ─────────────────────────────────────────────────────────────────

interface ViewerStatusEvent {
  viewerDeviceId: string;
  streamId: string;
  state: "playing" | "paused" | "reconnecting";
  receivedBitrateKbps: number | null;
  receivedWidth: number | null;
  receivedHeight: number | null;
  displayedFps: number | null;
  sampledAt: number;
}

interface HostObservedViewerStats {
  sentBitrateKbps: number | null;
  packetLossPercent: number | null;
  rttMs: number | null;
  sentWidth: number | null;
  sentHeight: number | null;
  sentFps: number | null;
  codec: string | null;
}

export interface ViewerRow {
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

const STALE_STATUS_MS = 10_000;
const POLL_INTERVAL_MS = 2_000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeHostStats(snapshot: StatsSnapshot): HostObservedViewerStats {
  const outbound = snapshot.outbound as Record<string, unknown> | undefined;
  const remoteInbound = snapshot.remoteInbound as Record<string, unknown> | undefined;
  const candidatePair = snapshot.candidatePair as Record<string, unknown> | undefined;
  const codec = snapshot.codec as Record<string, unknown> | undefined;

  // Sent bitrate estimate: use bytesSent delta (handled by the tracker)
  const sentWidth = (outbound?.frameWidth as number) ?? null;
  const sentHeight = (outbound?.frameHeight as number) ?? null;
  const sentFps = (outbound?.framesPerSecond as number) ?? null;

  // Packet loss from remote-inbound-rtp
  let packetLossPercent: number | null = null;
  if (remoteInbound) {
    const fractionLost = remoteInbound.fractionLost;
    if (typeof fractionLost === "number" && fractionLost >= 0) {
      packetLossPercent = fractionLost * 100;
    }
  }

  // RTT from candidate-pair
  let rttMs: number | null = null;
  if (candidatePair) {
    const rtt = candidatePair.currentRoundTripTime;
    if (typeof rtt === "number") {
      rttMs = rtt * 1000; // seconds → ms
    }
  }

  // Codec
  const codecMimeType = typeof codec?.mimeType === "string" ? codec.mimeType : null;

  return {
    sentBitrateKbps: null, // computed by bitrate tracker below
    packetLossPercent,
    rttMs,
    sentWidth,
    sentHeight,
    sentFps,
    codec: codecMimeType,
  };
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useHostViewerDiagnostics(
  sdk: VDONinjaSDK | null,
  viewers: ViewerInfo[],
  qualityCoordinator: QualityCoordinator | null,
  groupId: string,
  logicalStreamId: string,
): ViewerRow[] {
  const [rows, setRows] = useState<ViewerRow[]>([]);
  const statusMapRef = useRef<Map<string, ViewerStatusEvent>>(new Map());
  const bytesRef = useRef<Map<string, { lastBytes: number; lastTime: number }>>(new Map());

  // Listen for viewer.status events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as ViewerStatusEvent;
      if (detail && detail.viewerDeviceId) {
        statusMapRef.current.set(detail.viewerDeviceId, detail);
      }
    };
    window.addEventListener("screenlink:viewer-status", handler);
    return () => window.removeEventListener("screenlink:viewer-status", handler);
  }, []);

  // Poll host-side SDK stats
  const pollHostStats = useCallback(async () => {
    if (!sdk) return;

    const newBytes = new Map<string, { lastBytes: number; lastTime: number }>();
    const newStats = new Map<string, HostObservedViewerStats>();

    for (const [uuid, group] of sdk.connections) {
      const pc = group.publisher?.pc;
      if (!pc) continue;

      try {
        const snapshot = await pollStats(pc);
        const stats = computeHostStats(snapshot);

        // Compute bitrate from bytesSent delta
        const outbound = snapshot.outbound as Record<string, unknown> | undefined;
        const bytesSent = typeof outbound?.bytesSent === "number" ? outbound.bytesSent : 0;
        const prev = bytesRef.current.get(uuid);
        if (prev && prev.lastTime > 0) {
          const elapsed = (Date.now() - prev.lastTime) / 1000;
          const delta = bytesSent - prev.lastBytes;
          if (elapsed > 0 && delta >= 0) {
            stats.sentBitrateKbps = Math.round((delta * 8) / elapsed / 1000);
          }
        }
        newBytes.set(uuid, { lastBytes: bytesSent, lastTime: Date.now() });
        newStats.set(uuid, stats);
      } catch {
        // Best effort
      }
    }

    bytesRef.current = newBytes;
    return newStats;
  }, [sdk]);

  // Merge all data sources every poll cycle
  useEffect(() => {
    if (viewers.length === 0) {
      setRows([]);
      return;
    }

    let cancelled = false;

    const buildRows = async () => {
      const hostStats = await pollHostStats();
      if (cancelled) return;

      const now = Date.now();
      const newRows: ViewerRow[] = [];

      for (const viewer of viewers) {
        const status = statusMapRef.current.get(viewer.viewerDeviceId);
        const isStale = !status || (now - status.sampledAt) > STALE_STATUS_MS;

        // Determine state
        let state: ViewerRow["state"] = "unknown";
        if (status) {
          state = status.state;
          if (isStale) state = "unknown";
        }

        // Host stats
        const hostStat = hostStats?.get(viewer.peerUuid) ?? null;

        // Requested quality
        let requested: ViewerRow["requested"] = {
          bitrateKbps: null,
          width: null,
          height: null,
          fps: null,
          presetName: null,
        };
        if (qualityCoordinator) {
          const req: ViewerQualityRequest | null = qualityCoordinator.getViewerRequest(
            groupId,
            logicalStreamId,
            viewer.viewerDeviceId,
          );
          if (req) {
            requested = {
              bitrateKbps: req.videoBitrateKbps,
              width: req.maxWidth,
              height: req.maxHeight,
              fps: req.maxFps,
              presetName: null, // ViewerQualityRequest doesn't carry preset name currently
            };
          }
        }

        newRows.push({
          viewerDeviceId: viewer.viewerDeviceId,
          displayName: viewer.displayName,
          connectedAt: viewer.connectedAt,
          state,
          received: status && !isStale && state !== "paused"
            ? {
                bitrateKbps: status.receivedBitrateKbps,
                width: status.receivedWidth,
                height: status.receivedHeight,
                fps: status.displayedFps,
              }
            : { bitrateKbps: null, width: null, height: null, fps: null },
          sent: hostStat
            ? {
                bitrateKbps: hostStat.sentBitrateKbps,
                width: hostStat.sentWidth,
                height: hostStat.sentHeight,
                fps: hostStat.sentFps,
                packetLossPercent: hostStat.packetLossPercent,
                rttMs: hostStat.rttMs,
                codec: hostStat.codec,
              }
            : {
                bitrateKbps: null, width: null, height: null, fps: null,
                packetLossPercent: null, rttMs: null, codec: null,
              },
          requested,
          lastStatusAt: status?.sampledAt ?? null,
        });
      }

      if (!cancelled) setRows(newRows);
    };

    buildRows();
    const interval = setInterval(buildRows, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [viewers, sdk, qualityCoordinator, groupId, logicalStreamId, pollHostStats]);

  return rows;
}
```

- [ ] **Step 2: Verify the file compiles**

```bash
npx tsc --noEmit --project apps/desktop/tsconfig.json
```

Fix any import issues. `pollStats` is exported from `@screenlink/vdo-adapter` (check `packages/vdo-adapter/src/index.ts` for the export).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/hooks/use-host-viewer-diagnostics.ts
git commit -m "feat(host): add useHostViewerDiagnostics hook"
```

---

### Task 5: Add viewer list to HostDashboard

**Files:**
- Modify: `apps/desktop/src/renderer/components/workspace/HostDashboard.tsx`

- [ ] **Step 1: Import hook and types**

Add imports at top:
```typescript
import { useHostViewerDiagnostics } from "@/hooks/use-host-viewer-diagnostics";
import type { ViewerRow } from "@/hooks/use-host-viewer-diagnostics";
```

- [ ] **Step 2: Access SDK, viewers, and QualityCoordinator from store/services**

In the HostDashboard component function, after existing store selectors (around line 76), add:

```typescript
  const viewers = useStore((s) => s.viewers);
  const streamingGroupId = useStore((s) => s.sharingGroupId);
```

And access SDK via the confirmed chain:

```typescript
  const runtime = getRuntime();
  // Chain: runtime → StreamSessionManager → PublisherManager → HostPublisher → SDK
  const sdk = runtime
    ?.getStreamSessionManager()
    ?.getPublisherManager()
    ?.getPublisher()
    ?.getSDK() ?? null;
```

The accessor chain is verified:
- `Phase3Runtime.getStreamSessionManager()` → `StreamSessionManager`
- `StreamSessionManager.getPublisherManager()` → `PublisherManager | null`
- `PublisherManager.getPublisher()` → `HostPublisher | null`
- `HostPublisher.getSDK()` → `VDONinjaSDK | null`

- [ ] **Step 3: Call the hook**

```typescript
  const logicalStreamId = useMemo(() => {
    return runtime?.getStreamSessionManager()?.currentLogicalStreamId ?? "";
  }, [runtime]);

  const viewerRows = useHostViewerDiagnostics(
    sdk,
    viewers,
    runtime?.getQualityCoordinator() ?? null,
    streamingGroupId ?? "",
    logicalStreamId,
  );
```

- [ ] **Step 4: Add viewer list section to JSX**

After the connection status bar `<Card>` (after line 236), add:

```tsx
      {viewers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-text-primary">
              Viewers ({viewers.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {viewerRows.map((row) => (
              <ViewerRowItem key={row.viewerDeviceId} row={row} />
            ))}
          </CardContent>
        </Card>
      )}
```

- [ ] **Step 5: Create ViewerRowItem component** (in same file, above HostDashboard)

```tsx
function ViewerRowItem({ row }: { row: ViewerRow }) {
  const statusDot = (() => {
    switch (row.state) {
      case "playing": return { color: "bg-green-500", label: "Playing" };
      case "paused": return { color: "bg-amber-500", label: "Paused" };
      case "reconnecting": return { color: "bg-orange-500 animate-pulse", label: "Reconnecting" };
      default: return { color: "bg-gray-400", label: "No report" };
    }
  })();

  const fmtKbps = (v: number | null) => v !== null ? `${(v / 1000).toFixed(1)} Mbps` : null;
  const fmtLoss = (v: number | null) => v !== null ? `${v.toFixed(1)}%` : null;

  return (
    <div className="py-1.5 space-y-0.5">
      {/* Row 1: name + state */}
      <div className="flex items-center gap-2 text-xs">
        <span className={`h-2 w-2 rounded-full ${statusDot.color} shrink-0`} />
        <span className="text-text-primary font-medium truncate">{row.displayName}</span>
        <span className="text-text-muted ml-auto shrink-0">{statusDot.label}</span>
      </div>

      {row.state === "paused" && (
        <div className="text-[11px] text-text-muted pl-4">
          Control connection active · Media stopped
        </div>
      )}

      {row.state === "reconnecting" && (
        <div className="text-[11px] text-text-muted pl-4">
          Waiting for media statistics
        </div>
      )}

      {row.state === "playing" && (
        <>
          {/* Row 2: sent → received */}
          <div className="text-[11px] text-text-secondary pl-4">
            {(row.sent.width || row.sent.height || row.sent.fps) ? (
              <>
                Sent {row.sent.width}×{row.sent.height ?? "?"} {row.sent.fps ?? "?"} FPS
                {(row.received.width || row.received.height || row.received.fps) ? (
                  <> → Received {row.received.width}×{row.received.height ?? "?"} {row.received.fps ?? "?"} FPS</>
                ) : null}
              </>
            ) : (
              <span className="text-text-muted">No host stats</span>
            )}
          </div>

          {/* Row 3: bitrate, RTT, loss, codec */}
          <div className="text-[11px] text-text-muted pl-4 flex flex-wrap gap-x-3 gap-y-0">
            {row.sent.bitrateKbps !== null && (
              <span>{fmtKbps(row.sent.bitrateKbps)}</span>
            )}
            {row.sent.rttMs !== null && (
              <span>RTT {Math.round(row.sent.rttMs)} ms</span>
            )}
            {row.sent.packetLossPercent !== null && (
              <span>Loss {fmtLoss(row.sent.packetLossPercent)}</span>
            )}
            {row.sent.codec && (
              <span>{row.sent.codec}</span>
            )}
          </div>

          {/* Row 4: requested quality (only if viewer has explicit request) */}
          {row.requested.bitrateKbps !== null && (
            <div className="text-[10px] text-text-muted pl-4">
              Requested: {row.requested.width}×{row.requested.height ?? "?"} · {row.requested.fps} FPS · {row.requested.bitrateKbps} kbps
            </div>
          )}
        </>
      )}

      {row.state === "unknown" && row.lastStatusAt === null && (
        <div className="text-[11px] text-text-muted pl-4">
          No status received yet
        </div>
      )}

      {row.state === "unknown" && row.lastStatusAt !== null && (
        <div className="text-[11px] text-text-muted pl-4">
          Status stale (last: {Math.round((Date.now() - row.lastStatusAt) / 1000)}s ago)
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Add separator between rows**

Wrap each row with a `<Separator />` except the last:

```tsx
            {viewerRows.map((row, i) => (
              <div key={row.viewerDeviceId}>
                {i > 0 && <Separator className="my-1" />}
                <ViewerRowItem row={row} />
              </div>
            ))}
```

- [ ] **Step 7: Verify build**

```bash
cd apps/desktop && npx tsc --noEmit
```

Fix any type errors. The `Separator` component is already imported at the top of the HostDashboard.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/components/workspace/HostDashboard.tsx
git commit -m "feat(host): add per-viewer diagnostics list to HostDashboard"
```

---

## Verification

After all tasks, run the full project type check:

```bash
pnpm --filter @screenlink/shared build
pnpm --filter @screenlink/vdo-adapter build
cd apps/desktop && npx tsc --noEmit
```

All must pass with no errors.

## Edge Cases Handled

- **No SDK connected** → hook returns empty array, hosts shows no viewer rows
- **getStats() throws** → that viewer gets null host stats for that cycle, retried next poll
- **ViewerStatus stale (>10s)** → state becomes "unknown", stale age displayed
- **Paused viewer** → sent/received stats hidden, "Control connection active" shown
- **Reconnecting viewer** → "Waiting for media statistics" shown
- **Viewer leaves** → removed from store.viewers, rows update on next render cycle
- **Multiple viewers** → each gets independent row with unique viewerDeviceId key
