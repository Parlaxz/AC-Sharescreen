import { create } from "zustand";

// ─── Types ─────────────────────────────────────────────────────────────────

export type Page =
  | "dashboard"
  | "groups"
  | "quality-presets"
  | "source-picker"
  | "settings"
  | "diagnostics"
  | "about";

export interface ViewerInfo {
  peerUuid: string;
  displayName: string;
  connectedAt: number;
  presetId: string;
}

export interface CaptureStats {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  packetsSent: number;
  packetsLost: number;
  rtt: number;
}

export interface AppState {
  // Navigation
  currentPage: Page;
  navigate: (page: Page) => void;

  // Sharing state
  isSharing: boolean;
  isDegraded: boolean;
  sourceId: string | null;
  sourceName: string;
  sourceKind: "screen" | "window" | null;
  sourceDisplayId: string | null;
  sourceFingerprint: string | null;

  // Capture settings
  captureWidth: number;
  captureHeight: number;
  captureFps: number;
  captureBitrate: number;

  // Viewers
  viewerCount: number;
  viewers: ViewerInfo[];

  // Session stats (aggregate)
  sessionDuration: number;
  totalBytesSent: number;

  // View-stream mode (watch someone else's share)
  mode: "host" | "view";
  isViewing: boolean;
  viewStatus: string;
  viewStreamHostName: string;

  // Groups / state
  selectedGroupId: string | null;

  // Phase 2G / Phase 3 independent state machines
  localShareState: LocalShareState;
  remoteShareState: RemoteShareState;

  // Per-viewer observed stats (replaces per-stream stats with per-stream-per-viewer keys)
  localStreamSession: { sessionId: string; streamId: string; password: string } | null;
  watchedStreamsBySessionId: Record<string, { hostDeviceId: string; hostName: string; startedAt: number }>;
  qualityPresets: unknown[];

  // ── Phase 2G legacy fields kept temporarily for Dashboard source compatibility.
  // These are no longer wired to pairing IPCs; they are no-op shims and will be
  // removed in Phase 3.1 once the Dashboard is fully refactored to use Groups.
  // DO NOT add new consumers of these fields.
  /** @deprecated Phase 3: pairing removed. */
  pairingState: "unpaired" | "PAIRED_ONLINE" | "PAIRED_OFFLINE" | "error";
  /** @deprecated Phase 3: friend model removed. */
  friendDisplayName: string;
  /** @deprecated Phase 3: friend model removed. */
  friendDeviceId: string;
  /** @deprecated Phase 3: friend model removed. */
  friendIsSharing: boolean;
  /** @deprecated Phase 3: media credentials moved to per-group sessions. */
  remoteStreamId: string;
  /** @deprecated Phase 3: media credentials moved to per-group sessions. */
  remoteMediaPassword: string;
  /** @deprecated Phase 3: media credentials moved to per-group sessions. */
  remoteMediaSessionId: string;
  /** @deprecated Phase 3: media credentials moved to per-group sessions. */
  localMediaSessionId: string;
  /** @deprecated Phase 3: media credentials moved to per-group sessions. */
  localStreamId: string;
  /** @deprecated Phase 3: media credentials moved to per-group sessions. */
  localMediaPassword: string;
  /** @deprecated Phase 3: auto-watch removed. */
  autoWatchFriend: boolean;

  // Actions
  setIsSharing: (sharing: boolean) => void;
  setIsDegraded: (degraded: boolean) => void;
  setSource: (input: { id: string; name: string; kind: "screen" | "window"; displayId: string; fingerprint: string | null } | string, name?: string) => void;
  setCaptureInfo: (width: number, height: number, fps: number) => void;
  setCaptureBitrate: (kbps: number) => void;
  setViewers: (viewers: ViewerInfo[]) => void;
  setSessionDuration: (ms: number) => void;
  setTotalBytesSent: (bytes: number) => void;
  setMode: (mode: "host" | "view") => void;
  setIsViewing: (isViewing: boolean) => void;
  setViewStatus: (status: string) => void;
  setViewStreamHostName: (name: string) => void;
  setSelectedGroupId: (id: string | null) => void;
  setQualityPresets: (presets: unknown[]) => void;
  reset: () => void;

  // State machine actions
  setLocalShareState: (state: LocalShareState) => void;
  setRemoteShareState: (state: RemoteShareState) => void;
  setLocalStreamSession: (s: { sessionId: string; streamId: string; password: string } | null) => void;
  setWatchedStreams: (s: Record<string, { hostDeviceId: string; hostName: string; startedAt: number }>) => void;

  // Deprecated shim setters — kept for Dashboard source compatibility.
  setPairingState: (state: "unpaired" | "PAIRED_ONLINE" | "PAIRED_OFFLINE" | "error") => void;
  setFriendInfo: (deviceId: string, displayName: string) => void;
  setFriendSharing: (isSharing: boolean) => void;
  setRemoteMediaCredentials: (sessionId: string, streamId: string, password: string) => void;
  setLocalMediaCredentials: (sessionId: string, streamId: string, password: string) => void;
  clearRemoteMediaCredentials: () => void;
  clearLocalMediaCredentials: () => void;
  setAutoWatchFriend: (enabled: boolean) => void;
}

// ─── State machine types ────────────────────────────────────────

export type LocalShareState =
  | "idle"
  | "selecting-source"
  | "starting"
  | "sharing"
  | "stopping"
  | "error";

export type RemoteShareState =
  | "remote-offline"
  | "remote-online-idle"
  | "remote-share-available"
  | "connecting"
  | "viewing"
  | "reconnecting"
  | "error";

const initialState = {
  currentPage: "dashboard" as Page,
  isSharing: false,
  isDegraded: false,
  sourceId: null as string | null,
  sourceName: "",
  sourceKind: null as "screen" | "window" | null,
  sourceDisplayId: null as string | null,
  sourceFingerprint: null as string | null,
  captureWidth: 854,
  captureHeight: 480,
  captureFps: 15,
  captureBitrate: 650,
  viewerCount: 0,
  viewers: [] as ViewerInfo[],
  sessionDuration: 0,
  totalBytesSent: 0,
  mode: "host" as "host" | "view",
  isViewing: false,
  viewStatus: "",
  viewStreamHostName: "",
  selectedGroupId: null as string | null,
  localShareState: "idle" as LocalShareState,
  remoteShareState: "remote-offline" as RemoteShareState,
  localStreamSession: null as { sessionId: string; streamId: string; password: string } | null,
  watchedStreamsBySessionId: {} as Record<string, { hostDeviceId: string; hostName: string; startedAt: number }>,
  qualityPresets: [] as unknown[],

  // Deprecated shim fields
  pairingState: "unpaired" as "unpaired" | "PAIRED_ONLINE" | "PAIRED_OFFLINE" | "error",
  friendDisplayName: "",
  friendDeviceId: "",
  friendIsSharing: false,
  remoteStreamId: "",
  remoteMediaPassword: "",
  remoteMediaSessionId: "",
  localMediaSessionId: "",
  localStreamId: "",
  localMediaPassword: "",
  autoWatchFriend: false,
};

// ─── Store ──────────────────────────────────────────────────────────────────

export const useStore = create<AppState>((set) => ({
  ...initialState,

  navigate: (page) => set({ currentPage: page }),

  setIsSharing: (sharing) => set({ isSharing: sharing }),
  setIsDegraded: (degraded) => set({ isDegraded: degraded }),

  setSource: (input, name) => {
    if (typeof input === "string") {
      set({ sourceId: input, sourceName: name ?? "" });
    } else {
      set({
        sourceId: input.id,
        sourceName: input.name,
        sourceKind: input.kind,
        sourceDisplayId: input.displayId,
        sourceFingerprint: input.fingerprint,
      });
    }
  },

  setCaptureInfo: (width, height, fps) =>
    set({ captureWidth: width, captureHeight: height, captureFps: fps }),

  setCaptureBitrate: (kbps) => set({ captureBitrate: kbps }),

  setViewers: (viewers) => set({ viewers, viewerCount: viewers.length }),

  setSessionDuration: (ms) => set({ sessionDuration: ms }),

  setTotalBytesSent: (bytes) => set({ totalBytesSent: bytes }),

  setMode: (mode) => set({ mode }),
  setIsViewing: (isViewing) => set({ isViewing }),
  setViewStatus: (status) => set({ viewStatus: status }),
  setViewStreamHostName: (name) => set({ viewStreamHostName: name }),
  setSelectedGroupId: (id) => set({ selectedGroupId: id }),
  setQualityPresets: (presets) => set({ qualityPresets: presets }),

  setLocalShareState: (state) => set({ localShareState: state }),
  setRemoteShareState: (state) => set({ remoteShareState: state }),
  setLocalStreamSession: (s) => set({ localStreamSession: s }),
  setWatchedStreams: (s) => set({ watchedStreamsBySessionId: s }),

  // Deprecated shim setters — no-op or local-only
  setPairingState: (state) => set({ pairingState: state }),
  setFriendInfo: (deviceId, displayName) => set({ friendDeviceId: deviceId, friendDisplayName: displayName }),
  setFriendSharing: (isSharing) => set({ friendIsSharing: isSharing }),
  setRemoteMediaCredentials: (sessionId, streamId, password) =>
    set({ remoteMediaSessionId: sessionId, remoteStreamId: streamId, remoteMediaPassword: password }),
  setLocalMediaCredentials: (sessionId, streamId, password) =>
    set({ localMediaSessionId: sessionId, localStreamId: streamId, localMediaPassword: password }),
  clearRemoteMediaCredentials: () =>
    set({ remoteMediaSessionId: "", remoteStreamId: "", remoteMediaPassword: "" }),
  clearLocalMediaCredentials: () =>
    set({ localMediaSessionId: "", localStreamId: "", localMediaPassword: "" }),
  setAutoWatchFriend: (enabled) => set({ autoWatchFriend: enabled }),

  reset: () => set(initialState),
}));
