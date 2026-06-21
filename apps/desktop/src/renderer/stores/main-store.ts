import { create } from "zustand";

// ─── Types ─────────────────────────────────────────────────────────────────

export type Page =
  | "dashboard"
  | "source-picker"
  | "quality"
  | "viewers"
  | "friends"
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

  // Capture settings
  captureWidth: number;
  captureHeight: number;
  captureFps: number;
  captureBitrate: number;

  // Viewers
  viewerCount: number;
  viewers: ViewerInfo[];

  // Share configuration
  shareId: string;
  viewerToken: string;
  hostToken: string;
  workerBaseUrl: string;
  viewerBaseUrl: string;

  // Link (computed)
  viewerUrl: string;

  // Session stats (aggregate)
  sessionDuration: number;
  totalBytesSent: number;

  // View-stream mode (watch someone else's share)
  mode: "host" | "view";
  isViewing: boolean;
  viewStatus: string;
  viewStreamHostName: string;

  // Independent state machines (P2P migration)
  localShareState: LocalShareState;
  remoteShareState: RemoteShareState;
  pairingState: PairingState;
  friendDisplayName: string;
  friendDeviceId: string;
  friendIsSharing: boolean;
  remoteStreamId: string;
  remoteMediaPassword: string;
  remoteMediaSessionId: string;
  localMediaSessionId: string;
  localStreamId: string;
  localMediaPassword: string;
  autoWatchFriend: boolean;
  notifyWhenFriendShares: boolean;
  allowRemoteQualityRequests: boolean;
  allowRemoteGlobalChanges: boolean;

  // Actions
  setIsSharing: (sharing: boolean) => void;
  setIsDegraded: (degraded: boolean) => void;
  setSource: (id: string, name: string) => void;
  setCaptureInfo: (width: number, height: number, fps: number) => void;
  setCaptureBitrate: (kbps: number) => void;
  setViewers: (viewers: ViewerInfo[]) => void;
  setViewerUrl: (url: string) => void;
  setSessionDuration: (ms: number) => void;
  setTotalBytesSent: (bytes: number) => void;
  setShareConfig: (config: { shareId: string; viewerToken: string; hostToken: string; workerBaseUrl: string; viewerBaseUrl: string }) => void;
  setMode: (mode: "host" | "view") => void;
  setIsViewing: (isViewing: boolean) => void;
  setViewStatus: (status: string) => void;
  setViewStreamHostName: (name: string) => void;
  reset: () => void;

  // State machine actions
  setLocalShareState: (state: LocalShareState) => void;
  setRemoteShareState: (state: RemoteShareState) => void;
  setPairingState: (state: PairingState) => void;
  setFriendInfo: (deviceId: string, displayName: string) => void;
  setFriendSharing: (isSharing: boolean) => void;
  setRemoteMediaCredentials: (sessionId: string, streamId: string, password: string) => void;
  setLocalMediaCredentials: (sessionId: string, streamId: string, password: string) => void;
  clearRemoteMediaCredentials: () => void;
  clearLocalMediaCredentials: () => void;
  setAutoWatchFriend: (enabled: boolean) => void;
  setNotifyWhenFriendShares: (enabled: boolean) => void;
  setAllowRemoteQualityRequests: (enabled: boolean) => void;
  setAllowRemoteGlobalChanges: (enabled: boolean) => void;
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

export type PairingState =
  // Legacy states (kept only where still referenced)
  | "unpaired"
  | "error"
  // Active lifecycle states matching shared PAIRING_LIFECYCLE
  | "PAIR_CREATED_WAITING_FOR_IMPORT"
  | "PAIR_IMPORTED_CONNECTING"
  | "PAIR_CONNECTED_UNCONFIRMED"
  | "PAIRED_OFFLINE"
  | "PAIRED_ONLINE";

const initialState = {
  currentPage: "dashboard" as Page,
  isSharing: false,
  isDegraded: false,
  sourceId: null as string | null,
  sourceName: "",
  captureWidth: 854,
  captureHeight: 480,
  captureFps: 15,
  captureBitrate: 650,
  viewerCount: 0,
  viewers: [] as ViewerInfo[],
  shareId: "",
  viewerToken: "",
  hostToken: "",
  workerBaseUrl: "",
  viewerBaseUrl: "",
  viewerUrl: "",
  sessionDuration: 0,
  totalBytesSent: 0,
  mode: "host" as "host" | "view",
  isViewing: false,
  viewStatus: "",
  viewStreamHostName: "",

  localShareState: "idle" as LocalShareState,
  remoteShareState: "remote-offline" as RemoteShareState,
  pairingState: "unpaired" as PairingState,
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
  notifyWhenFriendShares: true,
  allowRemoteQualityRequests: true,
  allowRemoteGlobalChanges: true,
};

// ─── Store ──────────────────────────────────────────────────────────────────

export const useStore = create<AppState>((set) => ({
  ...initialState,

  navigate: (page) => set({ currentPage: page }),

  setIsSharing: (sharing) => set({ isSharing: sharing }),
  setIsDegraded: (degraded) => set({ isDegraded: degraded }),

  setSource: (id, name) => set({ sourceId: id, sourceName: name }),

  setCaptureInfo: (width, height, fps) =>
    set({ captureWidth: width, captureHeight: height, captureFps: fps }),

  setCaptureBitrate: (kbps) => set({ captureBitrate: kbps }),

  setViewers: (viewers) => set({ viewers, viewerCount: viewers.length }),

  setViewerUrl: (url) => set({ viewerUrl: url }),

  setShareConfig: (config) =>
    set({
      shareId: config.shareId,
      viewerToken: config.viewerToken,
      hostToken: config.hostToken,
      workerBaseUrl: config.workerBaseUrl,
      viewerBaseUrl: config.viewerBaseUrl,
    }),

  setMode: (mode) => set({ mode }),
  setIsViewing: (isViewing) => set({ isViewing }),
  setViewStatus: (status) => set({ viewStatus: status }),
  setViewStreamHostName: (name) => set({ viewStreamHostName: name }),

  setSessionDuration: (ms) => set({ sessionDuration: ms }),

  setTotalBytesSent: (bytes) => set({ totalBytesSent: bytes }),

  setLocalShareState: (state) => set({ localShareState: state }),
  setRemoteShareState: (state) => set({ remoteShareState: state }),
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
  setNotifyWhenFriendShares: (enabled) => set({ notifyWhenFriendShares: enabled }),
  setAllowRemoteQualityRequests: (enabled) => set({ allowRemoteQualityRequests: enabled }),
  setAllowRemoteGlobalChanges: (enabled) => set({ allowRemoteGlobalChanges: enabled }),

  reset: () => set(initialState),
}));
