// ─── Domain contracts for the screen-sharing pipeline (Phase 3) ────────────
// These types are shared across main, preload, and renderer.
// No SDK, DOM, or service instance types are permitted here.

/** Keys that a host may allow a remote viewer to send to the local desktop. */
export type RemoteInputKey = "ArrowLeft" | "ArrowRight" | "Space" | "d" | "s";

/** Per-share permissions for the supported remote input keys. */
export interface RemoteInputPermissions {
  arrowLeft: boolean;
  arrowRight: boolean;
  space: boolean;
  d: boolean;
  s: boolean;
}

/** Immutable template for the safest (all denied) input policy. */
export const DEFAULT_REMOTE_INPUT_PERMISSIONS: Readonly<RemoteInputPermissions> = Object.freeze({
  arrowLeft: false,
  arrowRight: false,
  space: false,
  d: false,
  s: false,
});

/** Return a fresh all-denied policy. */
export function createDefaultRemoteInputPermissions(): RemoteInputPermissions {
  return { ...DEFAULT_REMOTE_INPUT_PERMISSIONS };
}

/**
 * Validate and copy a permissions object. Omitted permissions are deliberately
 * treated as all denied for compatibility with older stream announcements.
 */
export function normalizeRemoteInputPermissions(
  input: unknown,
): RemoteInputPermissions {
  if (input === undefined) return createDefaultRemoteInputPermissions();
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Invalid remote input permissions");
  }

  const value = input as Record<string, unknown>;
  const keys = ["arrowLeft", "arrowRight", "space", "d", "s"] as const;
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => typeof value[key] !== "boolean")
  ) {
    throw new Error("Invalid remote input permissions");
  }

  return {
    arrowLeft: value.arrowLeft as boolean,
    arrowRight: value.arrowRight as boolean,
    space: value.space as boolean,
    d: value.d as boolean,
    s: value.s as boolean,
  };
}

/** Native shortcut key corresponding to each remotely controllable key. */
export const REMOTE_INPUT_SHORTCUTS: Readonly<Record<RemoteInputKey, string>> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Space: "SPACE",
  d: "D",
  s: "S",
};

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
  /** Per-share remote input permissions; omitted means all keys are denied. */
  inputPermissions?: RemoteInputPermissions;
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
