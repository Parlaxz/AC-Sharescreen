import { create } from "zustand";
import type { StreamAnnouncement, StreamTarget } from "@screenlink/shared";
import { createDefaultVideoQualitySettings } from "@screenlink/shared";

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Global page routing.
 * - `home`            — landing / aggregate view of all groups
 * - `overview`        — group-specific overview (requires selectedGroupId)
 * - `host`            — host dashboard (active share)
 * - `viewer`          — viewer experience
 * - `share-setup`     — source/quality configuration before sharing
 * - `group-presets`   — quality presets scoped to the selected group
 * - `group-settings`  — settings scoped to the selected group
 * - `user-settings`   — application-wide user settings
 * - `diagnostics`     — diagnostics / debugging
 * - `about`           — version & attribution
 */
export type Page =
  | "home"
  | "overview"
  | "host"
  | "viewer"
  | "share-setup"
  | "quality-presets"
  | "group-settings"
  | "user-settings"
  | "diagnostics"
  | "about";

/** Group dashboard internal nav pages (Section 6.2) */
export type GroupNavPage = "overview" | "group-settings";

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

export interface AppState {
  // Navigation
  currentPage: Page;
  navigate: (page: Page) => void;

  // Context panel (Section 9)
  showContextPanel: boolean;
  toggleContextPanel: () => void;

  // Group dashboard nav (Section 6.2)
  groupNavPage: GroupNavPage;
  setGroupNavPage: (page: GroupNavPage) => void;

  // Sharing state (Phase 3)
  isSharing: boolean;
  sharingGroupId: string | null;
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
  focusMode: boolean;

  /** Explicit watched target — replaces first-entry heuristics */
  watchingTarget: StreamTarget | null;

  // Group state
  selectedGroupId: string | null;
  groupsById: Record<string, { id: string; name: string; members: Record<string, { deviceId: string; displayName: string }> }>;
  groupOrder: string[];
  groupConnectionStateById: Record<string, GroupConnectionState>;
  onlineDeviceIdsByGroup: Record<string, string[]>;
  activeStreamsByGroup: Record<string, StreamAnnouncement[]>;

  // Share setup dialog (Stage 3.7D)
  openShareSetup: boolean;

  // Unified Create/Join Group dialog state
  openCreateGroupDialog: boolean;
  openJoinGroupDialog: boolean;

  // Last audio mode per source kind (persisted across dialog opens)
  lastScreenAudioMode: "none" | "monitor";
  lastWindowAudioMode: "none" | "application";

  // Local streaming state
  localShareState: LocalShareState;
  qualityPresets: unknown[];

  // Actions
  setOpenShareSetup: (open: boolean) => void;
  setOpenCreateGroupDialog: (open: boolean) => void;
  setOpenJoinGroupDialog: (open: boolean) => void;
  /** Convenience: select a group and navigate to its overview. */
  selectGroup: (groupId: string) => void;
  /** Convenience: navigate to home without clearing selectedGroupId. */
  homeNavigate: () => void;
  toggleFocusMode: () => void;
  setFocusMode: (focusMode: boolean) => void;
  setIsSharing: (sharing: boolean) => void;
  setSharingGroupId: (groupId: string | null) => void;
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
  setLastScreenAudioMode: (mode: "none" | "monitor") => void;
  setLastWindowAudioMode: (mode: "none" | "application") => void;
  setLocalShareState: (state: LocalShareState) => void;
  /** Set explicit watching target (replaces first-entry heuristics) */
  setWatchingTarget: (target: StreamTarget | null) => void;

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
  currentPage: "home" as Page,
  showContextPanel: false,
  groupNavPage: "overview" as GroupNavPage,
  isSharing: false,
  sharingGroupId: null as string | null,
  isDegraded: false,
  sourceId: null as string | null,
  sourceName: "",
  sourceKind: null as "screen" | "window" | null,
  sourceDisplayId: null as string | null,
  sourceFingerprint: null as string | null,
  captureWidth: createDefaultVideoQualitySettings().sendWidth,
  captureHeight: createDefaultVideoQualitySettings().sendHeight,
  captureFps: createDefaultVideoQualitySettings().sendFps,
  captureBitrate: createDefaultVideoQualitySettings().videoBitrateKbps,
  viewerCount: 0,
  viewers: [] as ViewerInfo[],
  sessionDuration: 0,
  totalBytesSent: 0,
  isViewing: false,
  viewStatus: "",
  focusMode: false,
  watchingTarget: null as StreamTarget | null,
  selectedGroupId: null as string | null,
  groupsById: {} as Record<string, { id: string; name: string; members: Record<string, { deviceId: string; displayName: string }> }>,
  groupOrder: [] as string[],
  groupConnectionStateById: {} as Record<string, GroupConnectionState>,
  onlineDeviceIdsByGroup: {} as Record<string, string[]>,
  activeStreamsByGroup: {} as Record<string, StreamAnnouncement[]>,
  openShareSetup: false,
  openCreateGroupDialog: false,
  openJoinGroupDialog: false,
  lastScreenAudioMode: "none" as "none" | "monitor",
  lastWindowAudioMode: "none" as "none" | "application",
  localShareState: "idle" as LocalShareState,
  qualityPresets: [] as unknown[],
};

export const useStore = create<AppState>((set, get) => ({
  ...initialState,

  navigate: (page) => set({ currentPage: page }),

  toggleContextPanel: () => set((s) => ({ showContextPanel: !s.showContextPanel })),
  setGroupNavPage: (page) => {
    // Only set the group nav indicator — no longer maps to currentPage.
    // Navigation to group pages is driven by explicit navigate() calls.
    set({ groupNavPage: page });
  },

  setOpenShareSetup: (open) => set({ openShareSetup: open }),
  setOpenCreateGroupDialog: (open) => set({ openCreateGroupDialog: open }),
  setOpenJoinGroupDialog: (open) => set({ openJoinGroupDialog: open }),
  selectGroup: (groupId) =>
    set({ selectedGroupId: groupId, currentPage: "overview" }),
  homeNavigate: () => {
    // Navigate to home without clearing selectedGroupId
    set({ currentPage: "home" });
  },
  setIsSharing: (sharing) => set({ isSharing: sharing }),
  setSharingGroupId: (sharingGroupId) => set({ sharingGroupId }),
  setIsDegraded: (degraded) => set({ isDegraded: degraded }),

  setSource: (input, name) => {
    if (typeof input === "string") {
      set({
        sourceId: input,
        sourceName: name ?? "",
        sourceKind: null,
        sourceDisplayId: null,
        sourceFingerprint: null,
      });
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
  setIsViewing: (isViewing) => set({ isViewing: isViewing, focusMode: false }),
  toggleFocusMode: () => set((s) => ({ focusMode: !s.focusMode })),
  setFocusMode: (focusMode) => set({ focusMode }),
  setViewStatus: (status) => set({ viewStatus: status }),
  setSelectedGroupId: (id) => set({ selectedGroupId: id }),
  setQualityPresets: (presets) => set({ qualityPresets: presets }),

  setLastScreenAudioMode: (mode) => set({ lastScreenAudioMode: mode }),
  setLastWindowAudioMode: (mode) => set({ lastWindowAudioMode: mode }),
  setLocalShareState: (state) => set({ localShareState: state }),
  setWatchingTarget: (target) => set({ watchingTarget: target }),

  setGroups: (groupsById, groupOrder) => set({ groupsById, groupOrder }),
  setGroupConnectionState: (groupConnectionStateById) => set({ groupConnectionStateById }),
  setOnlineDevices: (onlineDeviceIdsByGroup) => set({ onlineDeviceIdsByGroup }),
  setActiveStreams: (activeStreamsByGroup) => set({ activeStreamsByGroup }),

  reset: () => set(initialState),
}));
