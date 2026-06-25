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
  viewerDeviceId: string;
}

export interface GroupConnectionState {
  groupId: string;
  state: string;
  onlinePeers: string[];
  error: string | null;
}

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
  replacesSessionId: string | null;
}

export interface AppState {
  // Navigation
  currentPage: Page;
  navigate: (page: Page) => void;

  // Sharing state (Phase 3)
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

  // Session stats
  sessionDuration: number;
  totalBytesSent: number;

  // View mode
  isViewing: boolean;
  viewStatus: string;

  // Group state
  selectedGroupId: string | null;
  groupsById: Record<string, { id: string; name: string; members: Record<string, { deviceId: string; displayName: string }> }>;
  groupOrder: string[];
  groupConnectionStateById: Record<string, GroupConnectionState>;
  onlineDeviceIdsByGroup: Record<string, string[]>;
  activeStreamsByGroup: Record<string, StreamAnnouncement[]>;
  watchedStreamsBySessionId: Record<string, { hostDeviceId: string; hostName: string; startedAt: number }>;

  // Local streaming state
  localShareState: LocalShareState;
  localStreamSession: { sessionId: string; streamId: string; password: string } | null;
  qualityPresets: unknown[];

  // Actions
  setIsSharing: (sharing: boolean) => void;
  setIsDegraded: (degraded: boolean) => void;
  setSource: (input: { id: string; name: string; kind: "screen" | "window"; displayId: string; fingerprint: string | null } | string, name?: string) => void;
  setCaptureInfo: (width: number, height: number, fps: number) => void;
  setCaptureBitrate: (kbps: number) => void;
  setViewers: (v: ViewerInfo[]) => void;
  setSessionDuration: (ms: number) => void;
  setTotalBytesSent: (bytes: number) => void;
  setIsViewing: (isViewing: boolean) => void;
  setViewStatus: (status: string) => void;
  setSelectedGroupId: (id: string | null) => void;
  setQualityPresets: (presets: unknown[]) => void;
  reset: () => void;
  setLocalShareState: (state: LocalShareState) => void;
  setLocalStreamSession: (s: { sessionId: string; streamId: string; password: string } | null) => void;
  setWatchedStreams: (s: Record<string, { hostDeviceId: string; hostName: string; startedAt: number }> | ((prev: Record<string, { hostDeviceId: string; hostName: string; startedAt: number }>) => Record<string, { hostDeviceId: string; hostName: string; startedAt: number }>)) => void;

  // Group state actions
  setGroups: (groups: Record<string, { id: string; name: string; members: Record<string, { deviceId: string; displayName: string }> }>, order: string[]) => void;
  setGroupConnectionState: (stateById: Record<string, GroupConnectionState>) => void;
  setOnlineDevices: (byGroup: Record<string, string[]>) => void;
  setActiveStreams: (byGroup: Record<string, StreamAnnouncement[]>) => void;
}

export type LocalShareState =
  | "idle"
  | "selecting-source"
  | "starting"
  | "sharing"
  | "stopping"
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
  isViewing: false,
  viewStatus: "",
  selectedGroupId: null as string | null,
  groupsById: {} as Record<string, { id: string; name: string; members: Record<string, { deviceId: string; displayName: string }> }>,
  groupOrder: [] as string[],
  groupConnectionStateById: {} as Record<string, GroupConnectionState>,
  onlineDeviceIdsByGroup: {} as Record<string, string[]>,
  activeStreamsByGroup: {} as Record<string, StreamAnnouncement[]>,
  watchedStreamsBySessionId: {} as Record<string, { hostDeviceId: string; hostName: string; startedAt: number }>,
  localShareState: "idle" as LocalShareState,
  localStreamSession: null as { sessionId: string; streamId: string; password: string } | null,
  qualityPresets: [] as unknown[],
};

export const useStore = create<AppState>((set, get) => ({
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
  setIsViewing: (isViewing) => set({ isViewing }),
  setViewStatus: (status) => set({ viewStatus: status }),
  setSelectedGroupId: (id) => set({ selectedGroupId: id }),
  setQualityPresets: (presets) => set({ qualityPresets: presets }),

  setLocalShareState: (state) => set({ localShareState: state }),
  setLocalStreamSession: (s) => set({ localStreamSession: s }),
  setWatchedStreams: (s) => set({ watchedStreamsBySessionId: typeof s === "function" ? s(get().watchedStreamsBySessionId) : s }),

  setGroups: (groupsById, groupOrder) => set({ groupsById, groupOrder }),
  setGroupConnectionState: (groupConnectionStateById) => set({ groupConnectionStateById }),
  setOnlineDevices: (onlineDeviceIdsByGroup) => set({ onlineDeviceIdsByGroup }),
  setActiveStreams: (activeStreamsByGroup) => set({ activeStreamsByGroup }),

  reset: () => set(initialState),
}));
