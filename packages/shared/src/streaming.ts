// ─── Domain contracts for the screen-sharing pipeline (Phase 3) ────────────
// These types are shared across main, preload, and renderer.
// No SDK, DOM, or service instance types are permitted here.

/**
 * Stream announcement — published by a host and consumed by viewers
 * to discover active streams. This is the canonical shared type,
 * replacing the duplicate definitions in active-stream-registry.ts
 * and main-store.ts.
 */
export interface StreamAnnouncement {
  logicalStreamId: string;
  mediaSessionId: string;
  groupId: string;
  hostDeviceId: string;
  hostDisplayName: string;
  sourceKind: string;
  sourceName: string;
  startedAt: number;
  appliedSettingsRevision: number;
  heartbeatSequence: number;
  streamRevision: number;
  /** Per-viewer join metadata (not the actual media secret) */
  mediaJoinMetadata: string;
  replacesSessionId: string | null;
  /** Whether audio has failed (video preserved) */
  isAudioDegraded?: boolean;
  /** Wall-time the host asserts the lease is still valid through */
  leaseValidUntil?: number;
  /** HLC stamp of the synchronized group settings applied at publication. */
  sharedSettingsRevision?: string;
  /** HLC stamp of the live-applied group settings. */
  appliedLiveSettingsRevision?: string;
  /** HLC stamp of the last restart-applied settings. */
  appliedRestartSettingsRevision?: string;
}

/**
 * Explicit watched target — set when starting a watch/self-preview.
 * Multi-stream safe: each watch sets its own target.
 */
export interface StreamTarget {
  groupId: string;
  logicalStreamId: string;
  mediaSessionId: string;
  hostDeviceId: string;
  hostName: string;
  startedAt: number;
  sourceName?: string;
  sourceKind?: string;
}

/**
 * Exact viewer binding identity — used for all mapping operations
 * instead of legacy first-match lookups.
 * Matches the plan: viewerDeviceId, viewerSessionId, mediaSessionId.
 */
export interface ViewerBindingId {
  viewerDeviceId: string;
  viewerSessionId: string;
  mediaSessionId: string;
}

/**
 * Immutable snapshot of the host share session state.
 */
export interface HostSessionSnapshot {
  phase: "idle" | "starting" | "active" | "restarting" | "stopping" | "failed" | "destroyed";
  groupId: string | null;
  logicalStreamId: string | null;
  mediaSessionId: string | null;
  sourceId: string | null;
  sourceKind: string | null;
  sourceName: string;
  isDegraded: boolean;
  startedAt: number;
}

/**
 * Immutable snapshot of a viewer session state.
 * React subscribes to this snapshot; it does not mirror state
 * into additional lifecycle variables.
 */
export interface ViewerSessionSnapshot {
  phase: "idle" | "connecting" | "watching" | "paused" | "reconnecting" | "ended" | "error";
  target: StreamTarget | null;
  controlHealth: "up" | "down" | "recovering";
  mediaHealth: "up" | "stalled" | "down" | "recovering";
  pause: "playing" | "pausing" | "paused" | "resuming";
  error: string | null;
}
