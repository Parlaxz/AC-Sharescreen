// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Hoisted mocks must be defined first
const mockGetRuntime = vi.hoisted(() => vi.fn());
const mockRuntimeAddGroup = vi.hoisted(() => vi.fn());
const mockRuntimeRemoveGroup = vi.hoisted(() => vi.fn());
const mockRuntimeWaitForJoin = vi.hoisted(() => vi.fn());
const mockConnGetConnection = vi.hoisted(() => vi.fn());

vi.mock("../src/renderer/services/phase3-runtime.js", () => ({
  getRuntime: mockGetRuntime,
  acquirePhase3Runtime: vi.fn(),
  releasePhase3Runtime: vi.fn(),
}));

// Mock ViewerClient from vdo-adapter
const mockViewerClientCreateAndConnect = vi.hoisted(() => vi.fn());
const mockViewerClientView = vi.hoisted(() => vi.fn());
const mockViewerClientStopViewing = vi.hoisted(() => vi.fn());
const mockViewerClientDisconnect = vi.hoisted(() => vi.fn());
const mockViewerClientGetSDK = vi.hoisted(() => vi.fn());
const mockViewerClientSendMediaBind = vi.hoisted(() => vi.fn());
const mockViewerClientOn = vi.hoisted(() => vi.fn());
const mockViewerClientConstructor = vi.hoisted(() => vi.fn());

vi.mock("@screenlink/vdo-adapter", () => ({
  ViewerClient: vi.fn().mockImplementation(() => {
    const instance = {
      createAndConnect: mockViewerClientCreateAndConnect,
      view: mockViewerClientView,
      stopViewing: mockViewerClientStopViewing,
      disconnect: mockViewerClientDisconnect,
      getSDK: mockViewerClientGetSDK,
      sendMediaBind: mockViewerClientSendMediaBind,
      on: mockViewerClientOn,
    };
    mockViewerClientConstructor(instance);
    return instance;
  }),
}));

import { useStore } from "../src/renderer/stores/main-store.js";
import type {
  ScreenLinkAPI,
  CreateGroupResponseDTO,
  GroupRecordDTO,
  GroupConnectionConfigDTO,
  GroupSharedState,
  HybridTimestamp,
  LwwRegister,
} from "../src/renderer/../preload/api-types.js";

// Re-import types from shared
import type { GroupSharedState as SharedGroupState } from "@screenlink/shared";

// ─── Fixtures ─────────────────────────────────────────────────────────────

function makeStamp(nodeId = "node-1"): HybridTimestamp {
  return { wallTimeMs: Date.now(), counter: 0, nodeId };
}

function makeLww<T>(value: T, nodeId = "node-1"): LwwRegister<T> {
  return {
    value,
    stamp: makeStamp(nodeId),
    valueHash: "",
    updatedByDeviceId: nodeId,
  };
}

const defaultGroupId = "test-group-uuid";

function makeSharedState(): SharedGroupState {
  return {
    schemaVersion: 1,
    groupId: defaultGroupId,
    name: makeLww("Test Group"),
    defaultQuality: {
      value: {
        schemaVersion: 1,
        video: {
          videoBitrateKbps: 4000,
          sendWidth: 1280,
          sendHeight: 720,
          sendFps: 30,
          captureWidth: 1280,
          captureHeight: 720,
          captureFps: 30,
          preserveAspectRatio: true,
          preventUpscale: true,
          resolutionMode: "target-dimensions",
          scaleResolutionDownBy: 1,
          codec: "vp9",
          h264Profile: "auto",
          contentHint: "detail",
          degradationPreference: "balanced",
          scalabilityMode: null,
          cursorMode: "always",
          rtpPriority: "medium",
        },
        audio: {
          bitrateKbps: 64,
          channels: "stereo",
          bitrateMode: "vbr",
          dtx: false,
          fec: true,
          packetDurationMs: 20,
          redundantAudio: false,
        },
      },
      stamp: makeStamp("node-1"),
      valueHash: "",
      updatedByDeviceId: "node-1",
    },
    members: {
      "node-1": {
        deviceId: "node-1",
        displayName: "Creator",
        firstSeenAt: Date.now(),
        profileStamp: makeStamp("node-1"),
      },
    },
  };
}

function makeGroupRecord(overrides?: Partial<GroupRecordDTO>): GroupRecordDTO {
  return {
    groupId: defaultGroupId,
    controlRoomId: "control-room-abc",
    encryptedGroupSecret: "encrypted-placeholder",
    sharedState: makeSharedState() as unknown as GroupSharedState,
    lastClock: makeStamp("node-1"),
    joinedAt: 1,
    notificationsEnabled: true,
    ...overrides,
  };
}

function makeCreateGroupResponse(overrides?: Partial<CreateGroupResponseDTO>): CreateGroupResponseDTO {
  return {
    record: makeGroupRecord(),
    invite: JSON.stringify({ version: 1, groupId: defaultGroupId }),
    link: "screenlink://group?v=1&data=test",
    ...overrides,
  };
}

function makeConnectionConfig(overrides?: Partial<GroupConnectionConfigDTO>): GroupConnectionConfigDTO {
  return {
    groupId: defaultGroupId,
    controlRoomId: "control-room-abc",
    groupSecret: "group-secret-xyz",
    nodeId: "node-1",
    ...overrides,
  };
}

// ─── Mock helpers ─────────────────────────────────────────────────────────

interface MockAPI extends ScreenLinkAPI {
  [key: string]: any;
}

let mockApi: MockAPI;

function setupMockApi() {
  const api: MockAPI = {
    getDeviceIdentity: vi.fn().mockResolvedValue({
      deviceId: "node-1",
      displayName: "Test User",
      createdAt: Date.now(),
    }),
    getGroupConnectionConfig: vi.fn().mockResolvedValue(makeConnectionConfig()),
    createGroup: vi.fn().mockResolvedValue(makeCreateGroupResponse()),
    joinGroup: vi.fn().mockResolvedValue(makeGroupRecord()),
    leaveGroup: vi.fn().mockResolvedValue(undefined),
    getSources: vi.fn().mockResolvedValue([]),
    setSource: vi.fn().mockResolvedValue(undefined),
    getSourceFingerprint: vi.fn().mockResolvedValue(null),
    getSettings: vi.fn().mockResolvedValue(null),
    updateSettings: vi.fn().mockResolvedValue(undefined),
    encryptToken: vi.fn().mockResolvedValue("encrypted"),
    decryptToken: vi.fn().mockResolvedValue("plaintext"),
    getVdoCredentials: vi.fn().mockResolvedValue({ streamId: "vdo-1", password: "pass" }),
    startVdoSession: vi.fn().mockResolvedValue({ streamId: "vdo-1", password: "pass" }),
    stopVdoSession: vi.fn().mockResolvedValue(undefined),
    minimizeToTray: vi.fn().mockResolvedValue(undefined),
    updateDisplayName: vi.fn().mockResolvedValue({ deviceId: "node-1", displayName: "Test", createdAt: Date.now() }),
    safeStorageAvailable: vi.fn().mockResolvedValue(true),
    listGroups: vi.fn().mockResolvedValue([]),
    getGroup: vi.fn().mockResolvedValue(null),
    getGroupInvite: vi.fn().mockResolvedValue({ link: "test-link" }),
    updateGroupSharedState: vi.fn().mockResolvedValue(null),
    updateGroupClock: vi.fn().mockResolvedValue(undefined),
    setGroupNotifications: vi.fn().mockResolvedValue(undefined),
    listQualityPresets: vi.fn().mockResolvedValue([]),
    getQualityPreset: vi.fn().mockResolvedValue(null),
    createQualityPreset: vi.fn().mockResolvedValue({ id: "preset-1", name: "Test", settings: {} }),
    updateQualityPreset: vi.fn().mockResolvedValue({ id: "preset-1", name: "Test", settings: {} }),
    duplicateQualityPreset: vi.fn().mockResolvedValue({ id: "preset-2", name: "Copy", settings: {} }),
    deleteQualityPreset: vi.fn().mockResolvedValue(true),
    exportQualityPreset: vi.fn().mockResolvedValue("export-data"),
    importQualityPreset: vi.fn().mockResolvedValue({ id: "preset-3", name: "Import", settings: {} }),
    traySetSharing: vi.fn(),
    traySetViewing: vi.fn(),
    toggleFullscreen: vi.fn().mockResolvedValue(false),
    onFullscreenChanged: vi.fn().mockReturnValue(vi.fn()),
    getAppInfo: vi.fn().mockResolvedValue({ version: "1.0.0", electronVersion: "30.0.0", chromeVersion: "120.0.0" }),
    clipboardWriteText: vi.fn().mockResolvedValue({ success: true, length: 5 }),
    windowControls: {
      minimize: vi.fn().mockResolvedValue(undefined),
      toggleMaximize: vi.fn().mockResolvedValue(true),
      close: vi.fn().mockResolvedValue(undefined),
    },
    getAudioCapabilities: vi.fn().mockResolvedValue({ success: true }),
    requestAudioPort: vi.fn().mockResolvedValue({ success: true }),
    ensureAudioHelper: vi.fn().mockResolvedValue({ success: true }),
    getAudioState: vi.fn().mockResolvedValue("disabled"),
    startSyntheticAudio: vi.fn().mockResolvedValue({ success: true }),
    stopAudio: vi.fn().mockResolvedValue(undefined),
    enumerateAudioSessions: vi.fn().mockResolvedValue([]),
    startApplicationAudio: vi.fn().mockResolvedValue({ success: true }),
    startFilteredMonitorAudio: vi.fn().mockResolvedValue({ success: true }),
    startSystemAudio: vi.fn().mockResolvedValue({ success: true, streamGeneration: 1 }),
    getMixerState: vi.fn().mockResolvedValue({}),
    getMixerDiagnostics: vi.fn().mockResolvedValue({}),
    getPipelineSnapshot: vi.fn().mockResolvedValue({}),
    getQuickShareConfig: vi.fn().mockResolvedValue({
      shortcutEnabled: false, shortcutAccelerator: "", lastGroupId: null, lastSourceKind: null, lastPresetId: null,
    }),
    updateQuickShareConfig: vi.fn().mockResolvedValue(undefined),
    onQuickShareOpen: vi.fn().mockReturnValue(vi.fn()),
    onOpenSourcePicker: vi.fn().mockReturnValue(vi.fn()),
    onStopSharing: vi.fn().mockReturnValue(vi.fn()),
    onOpenDiagnostics: vi.fn().mockReturnValue(vi.fn()),
    getUpdateStatus: vi.fn().mockResolvedValue({
      phase: "idle", currentVersion: "1.0.0", userMessage: "", isPackaged: false, isPortable: false, updaterSupported: false,
    }),
    checkForUpdates: vi.fn().mockResolvedValue({
      phase: "idle", currentVersion: "1.0.0", userMessage: "", isPackaged: false, isPortable: false, updaterSupported: false,
    }),
    downloadUpdate: vi.fn().mockResolvedValue({
      phase: "idle", currentVersion: "1.0.0", userMessage: "", isPackaged: false, isPortable: false, updaterSupported: false,
    }),
    restartAndInstallUpdate: vi.fn().mockResolvedValue({
      phase: "idle", currentVersion: "1.0.0", userMessage: "", isPackaged: false, isPortable: false, updaterSupported: false,
    }),
    onUpdateStatusChanged: vi.fn().mockReturnValue(vi.fn()),
  } as unknown as MockAPI;

  mockApi = api;
  (globalThis as any).window = { screenlink: api };
}

function setupMockRuntime() {
  const mockConn = {
    peerForDevice: vi.fn().mockReturnValue("peer-uuid"),
    sendToPeer: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn().mockResolvedValue(undefined),
  };
  mockConnGetConnection.mockReturnValue(mockConn);

  mockRuntimeAddGroup.mockResolvedValue(undefined);
  mockRuntimeRemoveGroup.mockResolvedValue(undefined);
  mockRuntimeWaitForJoin.mockResolvedValue({
    logicalStreamId: "stream-1",
    accepted: true,
    viewerDeviceId: "node-1",
    mediaJoinMetadata: "bind-token-abc",
    mediaSessionId: "ms-1",
    streamId: "vdo-stream-abc",
    password: "vdo-password-xyz",
    bindingToken: "bind-token-abc",
    requestId: "req-1",
  });

  mockGetRuntime.mockReturnValue({
    isDestroyed: () => false,
    addGroup: mockRuntimeAddGroup,
    removeGroup: mockRuntimeRemoveGroup,
    waitForJoinResponse: mockRuntimeWaitForJoin,
    get deviceId() { return "node-1"; },
    get displayName() { return "Test User"; },
    getConnectionManager: () => ({
      getConnection: mockConnGetConnection,
    }),
  });

  // Reset ViewerClient mocks
  mockViewerClientCreateAndConnect.mockResolvedValue(undefined);
  mockViewerClientView.mockResolvedValue(undefined);
  mockViewerClientStopViewing.mockResolvedValue(undefined);
  mockViewerClientDisconnect.mockResolvedValue(undefined);
  mockViewerClientGetSDK.mockReturnValue({ connections: [] });
  mockViewerClientSendMediaBind.mockResolvedValue(undefined);
  // SDK 1.3.18 fires track events as CustomEvent with event.detail = { track, streams, uuid }.
  // Fire a video track so the join flow transitions to "watching".
  mockViewerClientOn.mockImplementation((event: string, cb: (...args: any[]) => void) => {
    if (event === "track") {
      cb({
        detail: {
          track: { kind: "video", id: "vt-default", enabled: true, readyState: "live" },
          streams: [{ id: "s-default" }],
          uuid: "peer-viewer",
        },
      });
    }
  });
  mockViewerClientConstructor.mockClear();
}

function cleanupMocks() {
  delete (globalThis as any).window;
  vi.clearAllMocks();
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("Task 2 — Group Create/Join DTO & Runtime Integration", () => {
  beforeEach(() => {
    useStore.getState().reset();
    setupMockApi();
    setupMockRuntime();
  });

  afterEach(() => {
    cleanupMocks();
  });

  // ── Group Record DTO shape ──────────────────────────────────────

  it("createGroup response has real { record, invite, link } shape", async () => {
    const { createGroupAction } = await import("../src/renderer/services/group-actions.js");
    const groupId = await createGroupAction("Test Group");

    expect(mockApi.createGroup).toHaveBeenCalledWith({ groupName: "Test Group" });
    expect(groupId).toBe("test-group-uuid");
  });

  it("createGroup no longer reads undefined sharedState/groupId from wrong shape", async () => {
    const { createGroupAction } = await import("../src/renderer/services/group-actions.js");

    const response = makeCreateGroupResponse({
      record: makeGroupRecord({ groupId: "uuid-123" }),
    });
    mockApi.createGroup.mockResolvedValueOnce(response);
    mockApi.getGroupConnectionConfig.mockResolvedValueOnce(
      makeConnectionConfig({ groupId: "uuid-123" }),
    );

    const groupId = await createGroupAction("Test");
    expect(groupId).toBe("uuid-123");

    // Verify runtime.addGroup was called with proper args
    expect(mockRuntimeAddGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: "uuid-123",
        controlRoomId: "control-room-abc",
        groupSecret: "group-secret-xyz",
        nodeId: "node-1",
        displayName: "Test User",
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("create calls runtime.addGroup with correct config", async () => {
    const { createGroupAction } = await import("../src/renderer/services/group-actions.js");
    await createGroupAction("Test Group");

    expect(mockRuntimeAddGroup).toHaveBeenCalledTimes(1);
    const config = mockRuntimeAddGroup.mock.calls[0][0];
    expect(config.groupId).toBe("test-group-uuid");
    expect(config.controlRoomId).toBe("control-room-abc");
    expect(config.groupSecret).toBe("group-secret-xyz");
    expect(config.nodeId).toBe("node-1");
    expect(config.displayName).toBe("Test User");
  });

  it("joinGroup response uses real record shape (GroupRecordDTO directly)", async () => {
    const { joinGroupAction } = await import("../src/renderer/services/group-actions.js");

    const record = makeGroupRecord({ groupId: "join-uuid-456" });
    mockApi.joinGroup.mockResolvedValueOnce(record);
    mockApi.getGroupConnectionConfig.mockResolvedValueOnce(
      makeConnectionConfig({ groupId: "join-uuid-456" }),
    );

    const groupId = await joinGroupAction("screenlink://...");
    expect(groupId).toBe("join-uuid-456");
    expect(mockApi.joinGroup).toHaveBeenCalledWith({ link: "screenlink://..." });

    expect(mockRuntimeAddGroup).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: "join-uuid-456" }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("join calls runtime.addGroup", async () => {
    const { joinGroupAction } = await import("../src/renderer/services/group-actions.js");
    await joinGroupAction("screenlink://...");

    expect(mockRuntimeAddGroup).toHaveBeenCalledTimes(1);
  });

  it("group is selected in store only after normalization/runtime setup", async () => {
    const { createGroupAction } = await import("../src/renderer/services/group-actions.js");

    expect(useStore.getState().selectedGroupId).toBeNull();

    await createGroupAction("Test Group");

    expect(useStore.getState().selectedGroupId).toBe("test-group-uuid");
    expect(useStore.getState().groupsById["test-group-uuid"]).toBeDefined();
    expect(useStore.getState().groupsById["test-group-uuid"].name).toBe("Test Group");

    // addGroup must be called before the store update
    expect(mockRuntimeAddGroup).toHaveBeenCalledTimes(1);
  });

  // ── Leave group ─────────────────────────────────────────────────

  it("leave calls persisted leaveGroup and runtime.removeGroup", async () => {
    const { leaveGroupAction } = await import("../src/renderer/services/group-leave-action.js");

    const result = await leaveGroupAction("test-group-uuid");

    expect(result.success).toBe(true);
    expect(result.groupId).toBe("test-group-uuid");
    expect(mockApi.leaveGroup).toHaveBeenCalledWith("test-group-uuid");
    expect(mockRuntimeRemoveGroup).toHaveBeenCalledWith("test-group-uuid");
  });

  it("leaving clears renderer group state (connection, online, active streams)", async () => {
    // Set up some state
    useStore.setState({
      groupsById: { "test-group-uuid": { id: "test-group-uuid", name: "Test", members: {} } },
      groupOrder: ["test-group-uuid"],
      selectedGroupId: "test-group-uuid",
      groupConnectionStateById: {
        "test-group-uuid": { groupId: "test-group-uuid", state: "connected", onlinePeers: [], error: null },
      },
      onlineDeviceIdsByGroup: { "test-group-uuid": ["peer-1"] },
      activeStreamsByGroup: {
        "test-group-uuid": [{
          logicalStreamId: "s1", mediaSessionId: "ms1", groupId: "test-group-uuid",
          hostDeviceId: "peer-1", hostDisplayName: "Peer", sourceKind: "screen",
          sourceName: "Screen", startedAt: Date.now(), appliedSettingsRevision: 0,
          heartbeatSequence: 0, replacesSessionId: null,
        }],
      },
      isViewing: true,
      viewStatus: "watching",
    });

    const { leaveGroupAction } = await import("../src/renderer/services/group-leave-action.js");
    await leaveGroupAction("test-group-uuid");

    const state = useStore.getState();
    expect(state.groupsById["test-group-uuid"]).toBeUndefined();
    expect(state.groupOrder).not.toContain("test-group-uuid");
    expect(state.groupConnectionStateById["test-group-uuid"]).toBeUndefined();
    expect(state.onlineDeviceIdsByGroup["test-group-uuid"]).toBeUndefined();
    expect(state.activeStreamsByGroup["test-group-uuid"]).toBeUndefined();
    expect(state.selectedGroupId).toBeNull();
    expect(state.isViewing).toBe(false);
    expect(state.viewStatus).toBe("");
  });

  it("leave re-selects another group if one exists", async () => {
    useStore.setState({
      groupsById: {
        "group-a": { id: "group-a", name: "A", members: {} },
        "group-b": { id: "group-b", name: "B", members: {} },
      },
      groupOrder: ["group-a", "group-b"],
      selectedGroupId: "group-a",
    });

    const { leaveGroupAction } = await import("../src/renderer/services/group-leave-action.js");
    await leaveGroupAction("group-a");

    const state = useStore.getState();
    expect(state.groupsById["group-a"]).toBeUndefined();
    expect(state.selectedGroupId).toBe("group-b");
  });

  it("leave navigates home when no groups remain", async () => {
    useStore.setState({
      groupsById: { "group-a": { id: "group-a", name: "A", members: {} } },
      groupOrder: ["group-a"],
      selectedGroupId: "group-a",
    });

    const { leaveGroupAction } = await import("../src/renderer/services/group-leave-action.js");
    await leaveGroupAction("group-a");

    const state = useStore.getState();
    expect(state.selectedGroupId).toBeNull();
    expect(state.currentPage).toBe("home");
  });
});

// ─── ViewerSession Tests ──────────────────────────────────────────────────

describe("Task 2 — ViewerSession", () => {
  beforeEach(() => {
    setupMockApi();
    setupMockRuntime();
  });

  afterEach(() => {
    cleanupMocks();
  });

  it("sends a real join request via group control connection", async () => {
    const { ViewerSession } = await import("../src/renderer/services/viewer-session.js");
    const session = new ViewerSession();

    await session.start({
      groupId: "test-group",
      hostDeviceId: "host-device-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      hostName: "Host User",
    });

    expect(mockConnGetConnection).toHaveBeenCalledWith("test-group");
    const conn = mockConnGetConnection();
    expect(conn.sendToPeer).toHaveBeenCalledWith(
      "peer-uuid",
      expect.objectContaining({
        type: "stream.join.request",
        logicalStreamId: "stream-1",
      }),
    );
  });

  it("waits for a matching join response", async () => {
    const { ViewerSession } = await import("../src/renderer/services/viewer-session.js");
    const session = new ViewerSession();

    await session.start({
      groupId: "test-group",
      hostDeviceId: "host-device-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      hostName: "Host User",
    });

    expect(mockRuntimeWaitForJoin).toHaveBeenCalled();
  });

  it("reports rejected join as error", async () => {
    mockRuntimeWaitForJoin.mockResolvedValueOnce({
      logicalStreamId: "stream-1",
      accepted: false,
      viewerDeviceId: "node-1",
      reason: "host declined",
      requestId: "req-1",
    });

    const { ViewerSession } = await import("../src/renderer/services/viewer-session.js");
    const session = new ViewerSession();
    let lastState = "";
    session.onStateChange = (state) => { lastState = state; };

    await session.start({
      groupId: "test-group",
      hostDeviceId: "host-device-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      hostName: "Host User",
    });

    expect(lastState).toBe("error");
    expect(session.state).toBe("error");
  });

  it("creates and connects ViewerClient on accepted response", async () => {
    const { ViewerSession } = await import("../src/renderer/services/viewer-session.js");
    const session = new ViewerSession();

    // Simulate track event firing after creation with SDK 1.3.18 event-detail shape:
    // handler receives (event) where event.detail = { track, streams, uuid }
    // Fire synchronously so the state transition to "watching" is observable after start().
    mockViewerClientOn.mockImplementation((event: string, cb: (...args: any[]) => void) => {
      if (event === "track") {
        cb({
          detail: {
            track: { kind: "video", id: "vt-1", enabled: true, readyState: "live" },
            streams: [{ id: "s-1" }],
            uuid: "peer-1",
          },
        });
      }
    });

    await session.start({
      groupId: "test-group",
      hostDeviceId: "host-device-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      hostName: "Host User",
    });

    expect(session.state).toBe("watching");
    // ViewerClient should have been instantiated
    expect(mockViewerClientConstructor).toHaveBeenCalled();
  });

  it("stop disconnects and clears state", async () => {
    const { ViewerSession } = await import("../src/renderer/services/viewer-session.js");
    const session = new ViewerSession();

    await session.start({
      groupId: "test-group",
      hostDeviceId: "host-device-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      hostName: "Host User",
    });

    session.stop();

    expect(session.state).toBe("ended");
  });

  it("retry invokes the real join flow again", async () => {
    const { ViewerSession } = await import("../src/renderer/services/viewer-session.js");
    const session = new ViewerSession();

    await session.start({
      groupId: "test-group",
      hostDeviceId: "host-device-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      hostName: "Host User",
    });

    expect(session.state).toBe("watching");
    const firstCallCount = mockRuntimeWaitForJoin.mock.calls.length;

    // Retry
    await session.retry();

    expect(mockRuntimeWaitForJoin.mock.calls.length).toBeGreaterThan(firstCallCount);
    expect(session.state).toBe("watching");
  });

  it("exit cleanup disconnects ViewerClient", async () => {
    const { ViewerSession } = await import("../src/renderer/services/viewer-session.js");
    const session = new ViewerSession();

    await session.start({
      groupId: "test-group",
      hostDeviceId: "host-device-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      hostName: "Host User",
    });

    session.destroy();
    expect(session.state).toBe("ended");
    expect(() => session.stop()).not.toThrow();
    expect(() => session.destroy()).not.toThrow();
  });
});

// ─── Quality Control Tests ────────────────────────────────────────────────

describe("Task 2 — Quality control removal", () => {
  it("QualityPopover no longer calls toast('Quality request sent')", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync(
      new URL("../src/renderer/components/workspace/viewer/QualityPopover.tsx", import.meta.url),
      "utf-8",
    );
    expect(content).not.toContain("toast");
    expect(content).not.toContain("Quality request sent");
  });

  it("VideoControls hides quality popover by default", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync(
      new URL("../src/renderer/components/workspace/viewer/VideoControls.tsx", import.meta.url),
      "utf-8",
    );
    expect(content).toContain("hideQuality = true");
    expect(content).toContain("!hideQuality");
  });
});

// ─── API type shape verification ──────────────────────────────────────────

describe("Task 2 — API type shape correctness", () => {
  it("GroupRecordDTO has groupId, sharedState, lastClock, and persistence metadata", () => {
    const record: GroupRecordDTO = {
      groupId: "test-id",
      controlRoomId: "room-1",
      encryptedGroupSecret: "encrypted-placeholder",
      sharedState: makeSharedState() as unknown as GroupSharedState,
      lastClock: makeStamp(),
      joinedAt: 1,
      notificationsEnabled: true,
    };
    expect(record.groupId).toBe("test-id");
    expect(record.controlRoomId).toBe("room-1");
    expect(typeof record.encryptedGroupSecret).toBe("string");
    expect(record.joinedAt).toBe(1);
    expect(record.notificationsEnabled).toBe(true);
    expect((record.sharedState as unknown as SharedGroupState).groupId).toBe("test-group-uuid");
    expect((record.sharedState as unknown as SharedGroupState).name.value).toBe("Test Group");
  });

  it("CreateGroupResponseDTO has record, invite, and link", () => {
    const response: CreateGroupResponseDTO = {
      record: makeGroupRecord(),
      invite: JSON.stringify({}),
      link: "screenlink://...",
    };
    expect(response.record).toBeDefined();
    expect(response.record.groupId).toBeDefined();
    expect(typeof response.invite).toBe("string");
    expect(typeof response.link).toBe("string");
  });

  it("GroupConnectionConfigDTO has groupId, controlRoomId, groupSecret, and nodeId", () => {
    const config: GroupConnectionConfigDTO = {
      groupId: "g-1",
      controlRoomId: "room-1",
      groupSecret: "secret-1",
      nodeId: "node-1",
    };
    expect(config.groupId).toBe("g-1");
    expect(config.controlRoomId).toBe("room-1");
    expect(config.groupSecret).toBe("secret-1");
    expect(config.nodeId).toBe("node-1");
  });
});

// ─── Integration-contract regression: real GroupStore shape ────────────────

/**
 * Reproduces the production bug where the renderer's DTO used `id` instead of
 * `groupId`, causing `getGroupConnectionConfig(undefined)`. The fixtures here
 * match the exact shape `GroupStore.create()` / `GroupStore.import()` returns.
 */
describe("Task 2 — GroupStore / attachGroupRecordToRuntime contract", () => {
  beforeEach(() => {
    useStore.getState().reset();
    setupMockApi();
    setupMockRuntime();
  });

  afterEach(() => {
    cleanupMocks();
  });

  function makeRealShapeRecord(overrides?: Partial<GroupRecordDTO>): GroupRecordDTO {
    return {
      groupId: "real-group-id",
      controlRoomId: "room-id",
      encryptedGroupSecret: "encrypted",
      sharedState: makeSharedState() as unknown as GroupSharedState,
      lastClock: makeStamp("node-1"),
      joinedAt: 1,
      notificationsEnabled: true,
      ...overrides,
    };
  }

  it("createGroup action threads the real-shape groupId through to the runtime", async () => {
    mockApi.getGroupConnectionConfig.mockResolvedValue({
      groupId: "real-group-id",
      controlRoomId: "room-id",
      groupSecret: "real-secret",
      nodeId: "node-1",
    });
    mockApi.createGroup.mockResolvedValueOnce({
      record: makeRealShapeRecord(),
      invite: JSON.stringify({ version: 1, groupId: "real-group-id" }),
      link: "screenlink://group?v=1&data=real",
    });

    const { createGroupAction } = await import(
      "../src/renderer/services/group-actions.js"
    );
    const groupId = await createGroupAction("Real Group");

    // 1. getGroupConnectionConfig was called with the real groupId
    expect(mockApi.getGroupConnectionConfig).toHaveBeenCalledWith("real-group-id");
    // 2. never called with undefined
    const calls = (mockApi.getGroupConnectionConfig as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    for (const call of calls) {
      expect(call[0]).not.toBeUndefined();
    }
    // 3. runtime.addGroup received the real groupId
    expect(mockRuntimeAddGroup).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: "real-group-id" }),
      expect.any(Object),
      expect.any(Object),
    );
    // 4. Zustand stored the group under the real groupId key
    const state = useStore.getState();
    expect(state.groupsById["real-group-id"]).toBeDefined();
    expect(state.groupOrder).toContain("real-group-id");
    // 5. The selected group is the real groupId
    expect(state.selectedGroupId).toBe("real-group-id");
    expect(groupId).toBe("real-group-id");
  });

  it("joinGroup action threads the real-shape groupId through to the runtime", async () => {
    mockApi.getGroupConnectionConfig.mockResolvedValue({
      groupId: "real-group-id",
      controlRoomId: "room-id",
      groupSecret: "real-secret",
      nodeId: "node-1",
    });
    mockApi.joinGroup.mockResolvedValueOnce(makeRealShapeRecord());

    const { joinGroupAction } = await import(
      "../src/renderer/services/group-actions.js"
    );
    const groupId = await joinGroupAction("screenlink://invite?v=1");

    expect(mockApi.getGroupConnectionConfig).toHaveBeenCalledWith("real-group-id");
    const calls = (mockApi.getGroupConnectionConfig as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    for (const call of calls) {
      expect(call[0]).not.toBeUndefined();
    }
    expect(mockRuntimeAddGroup).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: "real-group-id" }),
      expect.any(Object),
      expect.any(Object),
    );
    const state = useStore.getState();
    expect(state.groupsById["real-group-id"]).toBeDefined();
    expect(state.groupOrder).toContain("real-group-id");
    expect(state.selectedGroupId).toBe("real-group-id");
    expect(groupId).toBe("real-group-id");
  });

  it("createGroup rejects when record is missing groupId before any IPC call", async () => {
    mockApi.getGroupConnectionConfig.mockClear();
    // Build a malformed record (still satisfies the typed surface) by passing
    // through unknown and clearing groupId.
    mockApi.createGroup.mockResolvedValueOnce({
      record: {
        ...makeRealShapeRecord(),
        groupId: "",
      } as unknown as GroupRecordDTO,
      invite: "{}",
      link: "x",
    });

    const { createGroupAction } = await import(
      "../src/renderer/services/group-actions.js"
    );

    await expect(createGroupAction("Bad")).rejects.toThrow(
      /Invalid group record: missing groupId/,
    );
    // getGroupConnectionConfig must never be called for an invalid record.
    expect(mockApi.getGroupConnectionConfig).not.toHaveBeenCalled();
  });

  it("createGroup rejects when the connection config refers to a different group", async () => {
    mockApi.getGroupConnectionConfig.mockResolvedValueOnce({
      groupId: "some-other-group",
      controlRoomId: "room-id",
      groupSecret: "real-secret",
      nodeId: "node-1",
    });
    mockApi.createGroup.mockResolvedValueOnce({
      record: makeRealShapeRecord(),
      invite: "{}",
      link: "x",
    });

    const { createGroupAction } = await import(
      "../src/renderer/services/group-actions.js"
    );

    await expect(createGroupAction("Mismatch")).rejects.toThrow(
      /does not match group record/,
    );
  });
});
