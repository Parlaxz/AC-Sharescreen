/**
 * test-hooks — Production-safe E2E diagnostics bridge (renderer).
 *
 * Enabled ONLY when the preload flag `screenlink.__e2eEnabled` is true
 * (set by SCREENLINK_E2E=1 in the environment of the test runner), with a
 * legacy fallback to `window.__screenlinkTestEnabled`. When disabled this
 * module is fully inert: no globals are installed and emitMarker() is a no-op.
 *
 * Exposes:
 *   window.__screenlinkTest.snapshot()   — read-only async state snapshot
 *   window.__screenlinkTestMarkers       — bounded ring buffer (last 200)
 *   emitMarker(name, detail?)            — lifecycle marker emitter
 */
import { useStore } from "../stores/main-store.js";
import { getRuntime } from "./phase3-runtime.js";
import { getActiveController } from "./viewer-session-controller.js";

// ─── rtcStats (E2E media evidence, read-only) ──────────────────────────────
// Uses the EXISTING vdo-adapter connection-access getters to enumerate live
// RTCPeerConnections and summarize getStats(). Strictly read-only: no sender
// parameter mutation, no connection lifecycle changes.

/** Per-direction RTP stat summary (fields read defensively). */
interface RtcDirectionStat {
  kind: string;
  bytesReceived?: number;
  framesDecoded?: number;
  framesPerSecond?: number | null;
  codecMimeType?: string | null;
  /** Report timestamp (ms) — lets consumers diff counters over time. */
  jitterTimestamp?: number | null;
}

interface RtcOutboundStat {
  kind: string;
  bytesSent?: number;
  framesEncoded?: number;
  codecMimeType?: string | null;
}

interface RtcConnectionSummary {
  label: "publisher" | "viewer";
  pcPresent: boolean;
  inbound: RtcDirectionStat[];
  outbound: RtcOutboundStat[];
  error?: string;
}

function toNum(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function toNumOrNull(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Collect per-live-peer-connection getStats() summaries.
 * Returns [] when no live peer connections exist, or { error } on failure.
 */
async function rtcStats(): Promise<
  RtcConnectionSummary[] | { error: string }
> {
  try {
    const pcs: Array<{ label: "publisher" | "viewer"; pc: RTCPeerConnection }> = [];

    // Host publisher side: every peer PC on the publisher SDK.
    try {
      const runtime = getRuntime();
      const sdk = runtime
        ?.getStreamSessionManager()
        ?.getPublisherManager()
        ?.getPublisher()
        ?.getSDK() as
        | { connections?: Map<string, { publisher?: { pc?: unknown }; viewer?: { pc?: unknown } }> }
        | null
        | undefined;
      if (sdk?.connections instanceof Map) {
        for (const [, group] of sdk.connections) {
          const pc = group?.publisher?.pc ?? group?.viewer?.pc ?? null;
          if (pc instanceof RTCPeerConnection) {
            pcs.push({ label: "publisher", pc });
          }
        }
      }
    } catch {
      // no publisher SDK live — fall through
    }

    // Viewer side: the active viewer session's peer connection.
    try {
      const controller = getActiveController();
      const session = controller?.session ?? null;
      const pc = session ? session.getPeerConnection() : null;
      if (pc) pcs.push({ label: "viewer", pc });
    } catch {
      // no active viewer session — fall through
    }

    if (pcs.length === 0) return [];

    const out: RtcConnectionSummary[] = [];
    for (const { label, pc } of pcs) {
      const summary: RtcConnectionSummary = {
        label,
        pcPresent: true,
        inbound: [],
        outbound: [],
      };
      try {
        const report = await pc.getStats();
        const codecs = new Map<string, string>();
        report.forEach((s) => {
          if (s.type === "codec") {
            const mime = (s as Record<string, unknown>).mimeType;
            codecs.set(s.id, typeof mime === "string" ? mime : "");
          }
        });
        report.forEach((s) => {
          const stat = s as Record<string, unknown>;
          const codecMime =
            typeof stat.codecId === "string"
              ? codecs.get(stat.codecId) ?? null
              : null;
          if (s.type === "inbound-rtp") {
            summary.inbound.push({
              kind: String(stat.kind ?? stat.mediaType ?? "unknown"),
              bytesReceived: toNum(stat.bytesReceived),
              framesDecoded: toNum(stat.framesDecoded),
              framesPerSecond: toNumOrNull(stat.framesPerSecond),
              codecMimeType: codecMime,
              jitterTimestamp: toNumOrNull(s.timestamp),
            });
          } else if (s.type === "outbound-rtp") {
            summary.outbound.push({
              kind: String(stat.kind ?? stat.mediaType ?? "unknown"),
              bytesSent: toNum(stat.bytesSent),
              framesEncoded: toNum(stat.framesEncoded),
              codecMimeType: codecMime,
            });
          }
        });
      } catch (err) {
        summary.error = err instanceof Error ? err.message : String(err);
      }
      out.push(summary);
    }
    return out;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Maximum number of retained lifecycle markers. */
const MAX_MARKERS = 200;

interface MarkerEntry {
  e2eMarker: string;
  ts: number;
  [key: string]: unknown;
}

const markerBuffer: MarkerEntry[] = [];

/** Resolve E2E enablement from the preload flag (with fallback). */
export function isE2EEnabled(): boolean {
  // Safe in non-browser environments (vitest node pool): no window → disabled.
  const g = globalThis as {
    window?: {
      screenlink?: { __e2eEnabled?: boolean };
      __screenlinkTestEnabled?: boolean;
    };
  };
  if (typeof g.window === "undefined") return false;
  try {
    const api = g.window.screenlink;
    if (api && typeof api.__e2eEnabled === "boolean") {
      return api.__e2eEnabled;
    }
  } catch {
    // fall through to window fallback
  }
  return g.window.__screenlinkTestEnabled === true;
}

/**
 * Emit a lifecycle marker: logged to console as structured JSON AND pushed
 * to the bounded ring buffer exposed via window.__screenlinkTestMarkers.
 * No-op unless E2E mode is enabled.
 */
export function emitMarker(
  name: string,
  detail?: Record<string, unknown>,
): void {
  if (!isE2EEnabled()) return;
  const entry: MarkerEntry = {
    e2eMarker: name,
    ts: Date.now(),
    ...(detail ?? {}),
  };
  try {
    console.info(JSON.stringify(entry));
  } catch {
    // console failures must never break product code paths
  }
  markerBuffer.push(entry);
  if (markerBuffer.length > MAX_MARKERS) {
    markerBuffer.splice(0, markerBuffer.length - MAX_MARKERS);
  }
}

/** Read-only async snapshot of renderer-visible app state. */
async function snapshot(): Promise<{
  timestamp: number;
  currentPage: string;
  selectedGroupId: string | null;
  groups: Array<{ id: string; name: string; memberCount: number }>;
  groupConnections: Array<{
    groupId: string;
    state: string;
    onlinePeers: string[];
    error: string | null;
  }>;
  activeStreams: Array<Record<string, unknown>>;
  /** Per-group store slice the UI (StreamSwitcher, overview cards) reads. */
  activeStreamsByGroup: Record<string, string[]>;
  viewerSessions: Array<{
    phase: string;
    sessionId: string | null;
    logicalStreamId: string | null;
    groupId: string | null;
    error: string | null;
  }>;
  hostShare: {
    sharing: boolean;
    sessionId: string | null;
    mediaSessionId: string | null;
    sourceLabel: string | null;
  } | null;
  helpers?: {
    audio?: unknown;
    video?: unknown;
  };
}> {
  const store = useStore.getState();
  const runtime = getRuntime();

  const groups = store.groupOrder
    .map((id) => store.groupsById[id])
    .filter((g): g is NonNullable<typeof g> => g !== undefined)
    .map((g) => ({
      id: g.id,
      name: g.name,
      memberCount: Object.keys(g.members).length,
    }));

  const groupConnections = runtime
    ? Array.from(runtime.getConnectionManager().states.values()).map((s) => ({
        groupId: s.groupId,
        state: s.state,
        onlinePeers: [...s.onlinePeers],
        error: s.error,
      }))
    : [];

  const activeStreams: Array<Record<string, unknown>> = runtime
    ? (runtime.getActiveStreamRegistry().getAllStreams() as unknown as Array<
        Record<string, unknown>
      >)
    : [];

  // Per-group store slice (hostDeviceIds) — this is what StreamSwitcher and
  // the overview cards render from, as opposed to the global registry above.
  const activeStreamsByGroup: Record<string, string[]> = Object.fromEntries(
    Object.entries(store.activeStreamsByGroup).map(([gid, arr]) => [
      gid,
      arr.map((s) => s.hostDeviceId),
    ]),
  );

  const viewerSessions: Array<{
    phase: string;
    sessionId: string | null;
    logicalStreamId: string | null;
    groupId: string | null;
    error: string | null;
  }> = [];
  const controller = getActiveController();
  if (controller && controller.snapshot.phase !== "idle") {
    const snap = controller.snapshot;
    viewerSessions.push({
      phase: snap.phase,
      sessionId: snap.target?.mediaSessionId ?? null,
      logicalStreamId: snap.target?.logicalStreamId ?? null,
      groupId: snap.target?.groupId ?? null,
      error: snap.error ?? null,
    });
  }

  let hostShare: {
    sharing: boolean;
    sessionId: string | null;
    mediaSessionId: string | null;
    sourceLabel: string | null;
  } | null = null;
  const ssm = runtime?.getStreamSessionManager();
  if (ssm) {
    hostShare = {
      sharing: store.isSharing,
      sessionId: ssm.currentLogicalStreamId || null,
      mediaSessionId: ssm.currentMediaSessionId ?? null,
      sourceLabel: store.sourceName ?? null,
    };
  }

  // Helper states via existing preload APIs — best-effort, omitted on failure.
  const helpers: { audio?: unknown; video?: unknown } = {};
  try {
    const api = (
      window as unknown as {
        screenlink?: {
          getAudioState?: () => Promise<unknown>;
          videoHelperGetState?: () => Promise<unknown>;
        };
      }
    ).screenlink;
    if (api?.getAudioState) {
      helpers.audio = await api.getAudioState().catch(() => undefined);
    }
    if (api?.videoHelperGetState) {
      helpers.video = await api.videoHelperGetState().catch(() => undefined);
    }
  } catch {
    // omit helpers on any failure
  }

  return {
    timestamp: Date.now(),
    currentPage: store.currentPage,
    selectedGroupId: store.selectedGroupId,
    groups,
    groupConnections,
    activeStreams,
    activeStreamsByGroup,
    viewerSessions,
    hostShare,
    helpers,
  };
}

/**
 * Install the E2E test hooks onto window. Idempotent and inert unless
 * E2E mode is enabled. Called once early during App mount.
 */
export function installTestHooks(): void {
  if (!isE2EEnabled()) return;
  const w = window as unknown as Record<string, unknown>;
  if (!w.__screenlinkTest) {
    w.__screenlinkTest = { snapshot };
  }
  // Additive extension: rtcStats() for E2E media evidence (read-only).
  const hooks = w.__screenlinkTest as Record<string, unknown>;
  if (typeof hooks.rtcStats !== "function") {
    hooks.rtcStats = rtcStats;
  }
  if (!w.__screenlinkTestMarkers) {
    w.__screenlinkTestMarkers = {
      all: (): MarkerEntry[] => [...markerBuffer],
      last: (n = 1): MarkerEntry[] => markerBuffer.slice(-Math.max(0, n)),
    };
  }
}
