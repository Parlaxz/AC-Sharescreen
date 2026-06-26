/* eslint-disable @typescript-eslint/no-explicit-any */
export {};
/**
 * Browser shim for window.screenlink API.
 *
 * The Electron preload normally exposes the full `screenlink` API
 * (see apps/desktop/src/preload/api-types.ts). When auditing the
 * renderer in a normal browser via Playwright, we stub the API so
 * the React app can boot without crashing.
 *
 * This file is dev-only and is loaded by `index.html` only when
 * running outside Electron (e.g. via Vite dev server in browser).
 */

const stub = () => Promise.resolve(null);

const noopUnsub = () => () => {};

(window as any).screenlink = {
  // Sources
  getSources: () => Promise.resolve([]),
  setSource: stub,
  getSourceFingerprint: stub,

  // Settings
  getSettings: () =>
    Promise.resolve({
      version: 1,
      deviceIdentity: {
        deviceId: "audit-device",
        displayName: "Audit User",
        createdAt: Date.now(),
      },
      hostDisplayName: "Audit User",
      launchAtLogin: false,
      autoResumeLastMonitor: false,
      previewEnabled: true,
      windowBounds: null,
      monitorFingerprint: null,
      lastSourceId: null,
      lastSourceName: null,
      lastSourceFingerprint: null,
      developerMode: false,
      hostQualityLimits: {
        maxVideoBitrateKbps: 2400,
        maxWidth: 1280,
        maxHeight: 720,
        maxFps: 30,
        allowViewerQualityRequests: true,
      },
      globalQualityDefaults: {
        schemaVersion: 1,
        video: {
          codec: "h264",
          width: 854,
          height: 480,
          fps: 15,
          bitrateKbps: 650,
          contentHint: "detail",
        },
        audio: {
          mode: "none",
          bitrateKbps: 32,
        },
      },
    }),
  updateSettings: stub,

  // Secure storage
  encryptToken: () => Promise.resolve(null),
  decryptToken: () => Promise.resolve(null),

  // VDO session
  getVdoCredentials: () => Promise.resolve({ streamId: "", password: "" }),
  startVdoSession: () => Promise.resolve({ streamId: "", password: "" }),
  stopVdoSession: stub,

  // Window
  minimizeToTray: stub,

  // Device identity
  getDeviceIdentity: () =>
    Promise.resolve({
      deviceId: "audit-device",
      displayName: "Audit User",
      createdAt: Date.now(),
    }),
  updateDisplayName: () =>
    Promise.resolve({
      deviceId: "audit-device",
      displayName: "Audit User",
      createdAt: Date.now(),
    }),
  safeStorageAvailable: () => Promise.resolve(true),

  // Groups
  listGroups: () => Promise.resolve([]),
  getGroup: stub,
  createGroup: () => Promise.resolve({
    record: {
      groupId: "00000000-0000-0000-0000-000000000001",
      controlRoomId: "audit-room",
      encryptedGroupSecret: "stub-secret",
      sharedState: {
        schemaVersion: 1,
        groupId: "00000000-0000-0000-0000-000000000001",
        name: { value: "Demo Group", stamp: { wallTimeMs: 0, counter: 0, nodeId: "audit-device" }, valueHash: "name" },
        defaultQuality: { value: { schemaVersion: 1, video: {}, audio: {} }, stamp: { wallTimeMs: 0, counter: 0, nodeId: "audit-device" }, valueHash: "quality" },
        members: {},
      },
      lastClock: { wallTimeMs: 0, counter: 0, nodeId: "audit-device" },
      joinedAt: Date.now(),
      notificationsEnabled: true,
    },
    invite: {},
    link: "stub-group-invite-code",
  }),
  joinGroup: () => Promise.resolve({
    groupId: "00000000-0000-0000-0000-000000000001",
    controlRoomId: "audit-room",
    encryptedGroupSecret: "stub-secret",
    sharedState: {
      schemaVersion: 1,
      groupId: "00000000-0000-0000-0000-000000000001",
      name: { value: "Demo Group", stamp: { wallTimeMs: 0, counter: 0, nodeId: "audit-device" }, valueHash: "name" },
      defaultQuality: { value: { schemaVersion: 1, video: {}, audio: {} }, stamp: { wallTimeMs: 0, counter: 0, nodeId: "audit-device" }, valueHash: "quality" },
      members: {},
    },
    lastClock: { wallTimeMs: 0, counter: 0, nodeId: "audit-device" },
    joinedAt: Date.now(),
    notificationsEnabled: true,
  }),
  getGroupInvite: () => Promise.resolve({ link: "stub-group-invite-code" }),
  updateGroupSharedState: () => Promise.resolve(null),
  updateGroupClock: stub,
  setGroupNotifications: stub,
  leaveGroup: stub,
  getGroupConnectionConfig: () => Promise.resolve(null),

  // Quality presets
  listQualityPresets: () => Promise.resolve([]),
  getQualityPreset: () => Promise.resolve(null),
  createQualityPreset: () => Promise.resolve({ id: "new-preset" }),
  updateQualityPreset: () => Promise.resolve(null),
  duplicateQualityPreset: () => Promise.resolve(null),
  deleteQualityPreset: () => Promise.resolve(true),
  exportQualityPreset: () => Promise.resolve(null),
  importQualityPreset: () => Promise.resolve({ id: "imported" }),

  // Tray
  traySetSharing: () => {},
  traySetViewing: () => {},

  // Fullscreen
  toggleFullscreen: () => Promise.resolve(false),
  onFullscreenChanged: noopUnsub,

  // App info
  getAppInfo: () =>
    Promise.resolve({
      version: "0.1.0",
      electronVersion: "42.4.1",
      chromeVersion: "Chromium",
    }),

  // Clipboard
  clipboardWriteText: () => Promise.resolve({ success: true, length: 0 }),

  // Window controls
  windowControls: {
    minimize: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(false),
    close: () => Promise.resolve(),
  },

  // Audio capabilities
  getAudioCapabilities: () =>
    Promise.resolve({
      success: true,
      data: {
        supportsLoopback: true,
        supportsApplicationLoopback: true,
        supportsFilteredMonitor: true,
        supportsSynthetic: true,
        detected: { isAvailable: true, version: "stub", error: null },
      },
    }),

  // Audio pipeline
  requestAudioPort: () => Promise.resolve({ success: false, error: "audit-mode" }),
  ensureAudioHelper: () => Promise.resolve({ success: false, error: "audit-mode" }),
  getAudioState: () => Promise.resolve("disabled"),
  startSyntheticAudio: () => Promise.resolve({ success: false, error: "audit-mode" }),
  stopAudio: stub,
  enumerateAudioSessions: () => Promise.resolve({ sessions: [] }),
  startApplicationAudio: () => Promise.resolve({ success: false }),
  startFilteredMonitorAudio: () => Promise.resolve({ success: false }),
  startSystemAudio: () => Promise.resolve({ success: false }),
  getMixerState: () => Promise.resolve({}),
  getMixerDiagnostics: () => Promise.resolve({ success: false, data: null }),
  getPipelineSnapshot: () => Promise.resolve({}),

  // Updates
  getUpdateStatus: () =>
    Promise.resolve({
      phase: "unsupported",
      currentVersion: "0.1.0",
      userMessage: "Update checks are not available in audit mode",
      isPackaged: false,
      isPortable: false,
      updaterSupported: false,
    }),
  checkForUpdates: () =>
    Promise.resolve({
      phase: "unsupported",
      currentVersion: "0.1.0",
      userMessage: "Update checks are not available in audit mode",
      isPackaged: false,
      isPortable: false,
      updaterSupported: false,
    }),
  downloadUpdate: () =>
    Promise.resolve({
      phase: "unsupported",
      currentVersion: "0.1.0",
      userMessage: "Update checks are not available in audit mode",
      isPackaged: false,
      isPortable: false,
      updaterSupported: false,
    }),
  restartAndInstallUpdate: () =>
    Promise.resolve({
      phase: "unsupported",
      currentVersion: "0.1.0",
      userMessage: "Update checks are not available in audit mode",
      isPackaged: false,
      isPortable: false,
      updaterSupported: false,
    }),
  onUpdateStatusChanged: noopUnsub,
};

// Mark that the stub is in place so App.tsx can skip Electron-only paths
(window as any).__SCREENLINK_AUDIT_MODE__ = true;

// Listen for audit navigation events
window.addEventListener("screenlink:audit-navigate", ((ev: Event) => {
  const detail = (ev as CustomEvent<{ page: string }>).detail;
  const store = (window as any).__SCREENLINK_STORE__;
  if (store && detail?.page) {
    store.getState().navigate(detail.page);
    console.log("[ScreenLink Audit] navigated to", detail.page);
  } else {
    console.warn("[ScreenLink Audit] no store available for navigation");
  }
}) as EventListener);

// Listen for audit seed events (populate test data)
window.addEventListener("screenlink:audit-seed", ((ev: Event) => {
  const detail = (ev as CustomEvent<{ groups?: unknown[]; streams?: Record<string, unknown[]> }>).detail;
  const store = (window as any).__SCREENLINK_STORE__;
  if (!store) return;
  const state = store.getState();
  if (detail?.groups) {
    const groupsById: Record<string, unknown> = {};
    const groupOrder: string[] = [];
    for (const g of detail.groups as Array<{ id: string; name: string; members: Record<string, { deviceId: string; displayName: string }> }>) {
      groupsById[g.id] = { id: g.id, name: g.name, members: g.members };
      groupOrder.push(g.id);
    }
    state.setGroups(groupsById, groupOrder);
    if (groupOrder.length > 0) state.setSelectedGroupId(groupOrder[0]);
  }
  if (detail?.streams) {
    state.setActiveStreams(detail.streams);
  }
  console.log("[ScreenLink Audit] seeded data");
}) as EventListener);

console.log("[ScreenLink] Audit shim installed for window.screenlink");
