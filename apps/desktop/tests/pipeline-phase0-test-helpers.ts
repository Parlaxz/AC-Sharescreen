// @vitest-environment node
/**
 * Phase 0 test helpers for screen-sharing pipeline characterization.
 *
 * Provides deterministic fake primitives:
 * - ControllableDeferred — promise that resolves/rejects on demand
 * - FakeMediaStreamTrack — controllable track lifecycle
 * - FakeMediaStream — controllable stream
 * - FakeRTCRtpSender — controllable sender with getParameters/setParameters
 * - FakeRTCPeerConnection — controllable peer connection
 * - Factory functions for BindingToken, ViewerMapping, StreamAnnouncement
 * - Event trace fixtures
 *
 * These are intentionally simple object factories, not full mock classes,
 * matching the existing test patterns in the codebase.
 */

import { vi, type Mock } from "vitest";
import type {
  ViewerMapping,
  BindingToken,
} from "../src/renderer/services/viewer-media-binding.js";
import type { StreamAnnouncement } from "../src/renderer/services/active-stream-registry.js";

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Controllable Deferred Promise
// ═══════════════════════════════════════════════════════════════════════════════

export interface ControllableDeferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  /** True after resolve() or reject() has been called */
  settled: boolean;
  /** The resolved value, if settled and resolved */
  value: T | undefined;
  /** The rejection reason, if settled and rejected */
  reason: unknown;
}

/**
 * Create a promise whose resolve/reject are exposed for manual control.
 * This is the key primitive for deterministic async testing without real
 * timers or network I/O.
 */
export function createDeferred<T = void>(): ControllableDeferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  let settled = false;
  let value: T | undefined;
  let reason: unknown;

  const promise = new Promise<T>((res, rej) => {
    resolve = (v: T) => {
      settled = true;
      value = v;
      res(v);
    };
    reject = (r: unknown) => {
      settled = true;
      reason = r;
      rej(r);
    };
  });

  return { promise, resolve, reject, get settled() { return settled; }, get value() { return value; }, get reason() { return reason; } };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Fake Media Stream / Track
// ═══════════════════════════════════════════════════════════════════════════════

export interface FakeMediaStreamTrackControls {
  /** Whether stop() has been called */
  stopped: boolean;
  /** Whether onended was set */
  endedCallback: ((this: MediaStreamTrack, ev: Event) => unknown) | null;
  /** Simulate the browser firing 'ended' */
  simulateEnded: () => void;
  /** Get the fake track instance */
  track: MediaStreamTrack;
}

/**
 * Create a controllable fake MediaStreamTrack.
 * Tracks whether stop() was called and allows simulation of 'ended' events.
 */
export function createFakeVideoTrack(label = "Fake Screen Capture"): FakeMediaStreamTrackControls {
  let stopped = false;
  let endedCallback: ((this: MediaStreamTrack, ev: Event) => unknown) | null = null;
  const endedListeners = new Set<() => void>();

  const track = {
    kind: "video",
    label,
    id: `fake-video-track-${Math.random().toString(36).slice(2, 10)}`,
    enabled: true,
    muted: false,
    readyState: "live" as MediaStreamTrackState,
    onended: null as ((this: MediaStreamTrack, ev: Event) => unknown) | null,

    get ended() {
      return this.readyState === "ended";
    },

    stop() {
      stopped = true;
      this.readyState = "ended" as MediaStreamTrackState;
    },

    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === "ended" && typeof listener === "function") {
        endedListeners.add(listener as () => void);
      }
    },

    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === "ended" && typeof listener === "function") {
        endedListeners.delete(listener as () => void);
      }
    },

    getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }),
    getCapabilities: () => ({}),
    getConstraints: () => ({}),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
    clone: () => track,
  } as unknown as MediaStreamTrack;

  // Wire onended property to the listeners set
  Object.defineProperty(track, "onended", {
    get: () => endedCallback,
    set: (cb: ((this: MediaStreamTrack, ev: Event) => unknown) | null) => {
      endedCallback = cb;
    },
    configurable: true,
  });

  return {
    get stopped() { return stopped; },
    get endedCallback() { return endedCallback; },
    track,
    simulateEnded() {
      track.readyState = "ended" as MediaStreamTrackState;
      if (endedCallback) {
        endedCallback.call(track, new Event("ended"));
      }
      for (const listener of endedListeners) {
        listener();
      }
    },
  };
}

export function createFakeAudioTrack(label = "Fake System Audio"): MediaStreamTrack {
  return {
    kind: "audio",
    label,
    id: `fake-audio-track-${Math.random().toString(36).slice(2, 10)}`,
    enabled: true,
    muted: false,
    readyState: "live" as MediaStreamTrackState,
    onended: null,
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getSettings: () => ({ sampleRate: 48000 }),
    getCapabilities: () => ({}),
    getConstraints: () => ({}),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
    clone: vi.fn(),
  } as unknown as MediaStreamTrack;
}

export function createFakeMediaStream(videoTrack?: MediaStreamTrack, audioTrack?: MediaStreamTrack): MediaStream {
  const tracks: MediaStreamTrack[] = [];
  if (videoTrack) tracks.push(videoTrack);
  if (audioTrack) tracks.push(audioTrack);

  return {
    id: `fake-stream-${Math.random().toString(36).slice(2, 10)}`,
    active: true,
    getAudioTracks: () => tracks.filter(t => t.kind === "audio"),
    getVideoTracks: () => tracks.filter(t => t.kind === "video"),
    getTracks: () => [...tracks],
    addTrack: vi.fn((t: MediaStreamTrack) => { tracks.push(t); }),
    removeTrack: vi.fn((t: MediaStreamTrack) => {
      const idx = tracks.indexOf(t);
      if (idx >= 0) tracks.splice(idx, 1);
    }),
    clone: vi.fn(),
    getTrackById: (id: string) => tracks.find(t => t.id === id) ?? null,
    onaddtrack: null,
    onremovetrack: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaStream;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Fake RTCRtpSender
// ═══════════════════════════════════════════════════════════════════════════════

export interface FakeSenderControls {
  /** The underlying fake sender */
  sender: RTCRtpSender;
  /** Get the current parameters snapshot */
  getParams: () => RTCRtpSendParameters;
  /** Set the entire parameters object (simulates SDK readback) */
  setParams: (p: RTCRtpSendParameters) => void;
  /** Get the count of setParameters calls */
  setParametersCallCount: () => number;
  /** Track passed to replaceTrack */
  replaceTrackTrack: MediaStreamTrack | null;
}

/**
 * Create a controllable fake RTCRtpSender.
 * Stores parameters independently so getParameters returns a snapshot
 * and setParameters replaces it — no real WebRTC dependency.
 */
export function createFakeSender(
  initialParams?: Partial<RTCRtpSendParameters>,
  track?: MediaStreamTrack | null,
): FakeSenderControls {
  let internalParams: RTCRtpSendParameters = {
    encodings: [
      {
        active: true,
        maxBitrate: 2_000_000,
        maxFramerate: 30,
        scaleResolutionDownBy: 1,
        degradationPreference: "balanced",
        priority: "medium",
      },
    ],
    transactionId: `tx-${Math.random().toString(36).slice(2, 10)}`,
    codecs: [],
    headerExtensions: [],
    rtcp: { cname: "", reducedSize: false, mux: true },
    degradationPreference: "balanced",
    ...initialParams,
  };

  let setParametersCallCount = 0;
  let replaceTrackTrack: MediaStreamTrack | null = null;

  // Ensure encodings exist
  if (!internalParams.encodings || internalParams.encodings.length === 0) {
    internalParams.encodings = [{ active: true }];
  }

  const sender = {
    getParameters: vi.fn(() => ({ ...internalParams, encodings: [...(internalParams.encodings ?? [])] })),

    setParameters: vi.fn(async (p: RTCRtpSendParameters) => {
      setParametersCallCount++;
      internalParams = p;
    }),

    replaceTrack: vi.fn(async (newTrack: MediaStreamTrack | null) => {
      replaceTrackTrack = newTrack;
    }),

    track: track ?? null,

    get dtmf() { return null; },
    get rtcpTransport() { return null; },
    get transport() { return null; },
  } as unknown as RTCRtpSender;

  return {
    sender,
    getParams: () => ({ ...internalParams, encodings: [...(internalParams.encodings ?? [])] }),
    setParams: (p: RTCRtpSendParameters) => { internalParams = p; },
    setParametersCallCount: () => setParametersCallCount,
    get replaceTrackTrack() { return replaceTrackTrack; },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Fake RTCPeerConnection
// ═══════════════════════════════════════════════════════════════════════════════

export interface FakePeerConnectionControls {
  pc: RTCPeerConnection;
  /** Add a sender to the connection's getSenders() */
  addSender: (sender: RTCRtpSender) => void;
  /** Remove a sender */
  removeSender: (sender: RTCRtpSender) => void;
  /** Get all senders */
  getSenders: () => RTCRtpSender[];
  /** Simulate connection state change */
  setConnectionState: (state: RTCPeerConnectionState) => void;
  /** Simulate ICE connection state change */
  setIceConnectionState: (state: RTCIceConnectionState) => void;
}

export function createFakePeerConnection(): FakePeerConnectionControls {
  const senders: RTCRtpSender[] = [];
  let connectionState: RTCPeerConnectionState = "new";
  let iceConnectionState: RTCIceConnectionState = "new";
  const connectionStateListeners = new Set<() => void>();
  const iceConnectionStateListeners = new Set<() => void>();

  const pc = {
    getSenders: () => [...senders],

    addTrack: vi.fn((_track: MediaStreamTrack) => {
      const sender = createFakeSender().sender;
      senders.push(sender);
      return sender;
    }),

    removeTrack: vi.fn((sender: RTCRtpSender) => {
      const idx = senders.indexOf(sender);
      if (idx >= 0) senders.splice(idx, 1);
    }),

    getReceivers: () => [],
    getTransceivers: () => [],
    addTransceiver: vi.fn(),
    createOffer: vi.fn(),
    createAnswer: vi.fn(),
    setLocalDescription: vi.fn(),
    setRemoteDescription: vi.fn(),
    addIceCandidate: vi.fn(),
    close: vi.fn(),
    getStats: vi.fn(),

    get connectionState() { return connectionState; },
    get iceConnectionState() { return iceConnectionState; },
    get signalingState() { return "stable" as RTCSignalingState; },
    get iceGatheringState() { return "complete" as RTCIceGatheringState; },

    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === "connectionstatechange" && typeof listener === "function") {
        connectionStateListeners.add(listener as () => void);
      }
      if (type === "iceconnectionstatechange" && typeof listener === "function") {
        iceConnectionStateListeners.add(listener as () => void);
      }
    }),

    removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === "connectionstatechange" && typeof listener === "function") {
        connectionStateListeners.delete(listener as () => void);
      }
      if (type === "iceconnectionstatechange" && typeof listener === "function") {
        iceConnectionStateListeners.delete(listener as () => void);
      }
    }),

    dispatchEvent: vi.fn(() => true),
  } as unknown as RTCPeerConnection;

  return {
    pc,
    addSender: (s: RTCRtpSender) => { senders.push(s); },
    removeSender: (s: RTCRtpSender) => {
      const idx = senders.indexOf(s);
      if (idx >= 0) senders.splice(idx, 1);
    },
    getSenders: () => [...senders],
    setConnectionState: (state: RTCPeerConnectionState) => {
      connectionState = state;
      for (const listener of connectionStateListeners) listener();
    },
    setIceConnectionState: (state: RTCIceConnectionState) => {
      iceConnectionState = state;
      for (const listener of iceConnectionStateListeners) listener();
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Event Trace Types and Fixtures
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Minimal event trace record as specified by Phase 0.
 * Carries operation identity, viewer binding context, stream identity,
 * and sender revision metadata.
 */
export interface PipelineEventTrace {
  /** Unique operation ID (e.g. UUID generated by the operation) */
  operationId: string;
  /** Wall time when the event was recorded */
  timestamp: number;
  /** Event category */
  type: "pause" | "resume" | "quality-apply" | "quality-request" | "join" | "leave" | "bind" | "stop" | "start" | "restart" | "teardown" | "reconcile" | "lifecycle-queue";
  /** Exact viewer binding composite key */
  viewerBindingId: string | null;
  /** Logical stream ID */
  logicalStreamId: string | null;
  /** Media session ID */
  mediaSessionId: string | null;
  /** Desired sender revision at the time of the event */
  desiredRevision: number | null;
  /** Actual sender revision read back after the operation */
  actualRevision: number | null;
  /** Whether the operation was successful */
  success: boolean;
  /** Error message if not successful */
  error?: string;
  /** Additional event-specific context */
  payload?: Record<string, unknown>;
}

/**
 * Create an event trace for testing assertions.
 */
export function createEventTrace(
  overrides: Partial<PipelineEventTrace> & { operationId: string; type: PipelineEventTrace["type"] },
): PipelineEventTrace {
  return {
    timestamp: Date.now(),
    viewerBindingId: null,
    logicalStreamId: null,
    mediaSessionId: null,
    desiredRevision: null,
    actualRevision: null,
    success: true,
    ...overrides,
  };
}

/**
 * Collect event traces for test assertions.
 */
export class EventTraceCollector {
  private traces: PipelineEventTrace[] = [];

  /** Record a trace event */
  record(trace: PipelineEventTrace): void {
    this.traces.push(trace);
  }

  /** Get all recorded traces */
  getAll(): PipelineEventTrace[] {
    return [...this.traces];
  }

  /** Get traces of a specific type */
  ofType(type: PipelineEventTrace["type"]): PipelineEventTrace[] {
    return this.traces.filter(t => t.type === type);
  }

  /** Find the first trace matching a predicate */
  find(predicate: (t: PipelineEventTrace) => boolean): PipelineEventTrace | undefined {
    return this.traces.find(predicate);
  }

  /** Filter traces by predicate */
  filter(predicate: (t: PipelineEventTrace) => boolean): PipelineEventTrace[] {
    return this.traces.filter(predicate);
  }

  /** Clear all traces */
  clear(): void {
    this.traces = [];
  }

  /** Get count */
  get count(): number {
    return this.traces.length;
  }

  /** Assert that at least one trace matches a predicate */
  assertContains(predicate: (t: PipelineEventTrace) => boolean, message?: string): void {
    const found = this.traces.some(predicate);
    if (!found) {
      throw new Error(message ?? `Expected event trace matching predicate, but none found among ${this.traces.length} traces.`);
    }
  }

  /** Assert that no trace matches a predicate */
  assertNotContains(predicate: (t: PipelineEventTrace) => boolean, message?: string): void {
    const found = this.traces.some(predicate);
    if (found) {
      throw new Error(message ?? `Expected no event trace matching predicate, but found one.`);
    }
  }

  /** Assert exact count of traces matching a predicate */
  assertCount(predicate: (t: PipelineEventTrace) => boolean, expected: number, message?: string): void {
    const actual = this.traces.filter(predicate).length;
    if (actual !== expected) {
      throw new Error(message ?? `Expected ${expected} trace(s) matching predicate, found ${actual}.`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Factory Functions
// ═══════════════════════════════════════════════════════════════════════════════

/** Create a fake BindingToken for ViewerMediaBinding tests. */
export function createFakeBindingToken(
  overrides?: Partial<BindingToken>,
): BindingToken {
  return {
    token: `tok-${Math.random().toString(36).slice(2, 10)}`,
    groupId: "g-test",
    logicalStreamId: `ls-${Math.random().toString(36).slice(2, 10)}`,
    mediaSessionId: `ms-${Math.random().toString(36).slice(2, 10)}`,
    viewerDeviceId: "viewer-test",
    viewerSessionId: `vs-${Math.random().toString(36).slice(2, 10)}`,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    consumed: false,
    ...overrides,
  };
}

/** Create a fake ViewerMapping for ViewerMediaBinding tests. */
export function createFakeViewerMapping(
  overrides?: Partial<ViewerMapping>,
  sender?: RTCRtpSender,
): ViewerMapping {
  return {
    viewerDeviceId: "viewer-test",
    viewerSessionId: `vs-${Math.random().toString(36).slice(2, 10)}`,
    mediaPeerUuid: `peer-${Math.random().toString(36).slice(2, 10)}`,
    groupId: "g-test",
    logicalStreamId: `ls-${Math.random().toString(36).slice(2, 10)}`,
    mediaSessionId: `ms-${Math.random().toString(36).slice(2, 10)}`,
    pc: null,
    videoSender: sender ?? null,
    audioSender: null,
    ...overrides,
  };
}

/** Create a fake StreamAnnouncement for ActiveStreamRegistry tests. */
export function createFakeStreamAnnouncement(
  overrides?: Partial<StreamAnnouncement>,
): StreamAnnouncement {
  const now = Date.now();
  return {
    logicalStreamId: `ls-${Math.random().toString(36).slice(2, 10)}`,
    mediaSessionId: `ms-${Math.random().toString(36).slice(2, 10)}`,
    groupId: "g-test",
    hostDeviceId: "host-test",
    hostDisplayName: "Test Host",
    sourceKind: "screen",
    sourceName: "Test Display",
    startedAt: now,
    appliedSettingsRevision: 0,
    heartbeatSequence: 1,
    streamRevision: 1,
    mediaJoinMetadata: "",
    replacesSessionId: null,
    isAudioDegraded: false,
    ...overrides,
  };
}

/** Create a minimal GroupControlConnection-like object for tests. */
export function createFakeConnection(
  overrides?: {
    state?: string;
    onlinePeers?: string[];
    knownPeers?: Record<string, string>;
  },
): {
  state: string;
  start: Mock;
  destroy: Mock;
  broadcast: Mock;
  sendToPeer: Mock;
  peerForDevice: Mock;
  connectedPeers: string[];
  onlinePeers: string[];
} {
  let _state = overrides?.state ?? "connected";
  return {
    get state() { return _state; },
    set state(s: string) { _state = s; },
    start: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn().mockResolvedValue({ attempted: 1, sent: 1, failed: 0 }),
    sendToPeer: vi.fn().mockResolvedValue(true),
    get connectedPeers() { return []; },
    peerForDevice: vi.fn((deviceId: string) => overrides?.knownPeers?.[deviceId] ?? null),
    onlinePeers: overrides?.onlinePeers ?? [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Dead Service Wiring Recorder (Phase 0 exit criterion)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Records the current runtime wiring for services marked dead before deletion.
 * This creates a snapshot of how the services are connected in production
 * so deletion can verify nothing else depends on them.
 */
export interface DeadServiceWiring {
  serviceName: string;
  sourceFile: string;
  /** Where the service is instantiated */
  instantiatedIn: string;
  /** Where the service's methods/events are consumed */
  consumedBy: Array<{
    file: string;
    method: string;
    description: string;
  }>;
  /** Production construction / import — null if never constructed */
  productionConstruction: string | null;
  /** Whether the service has production tests */
  hasTests: boolean;
  /** Notes about what the deletion must handle */
  deletionNotes: string;
}

/**
 * Record current wiring for dead/obsolete services.
 * This is data, not a live probe — it's the audit finding captured as
 * structured records for the deletion phase.
 */
export const DEAD_SERVICE_WIRING: DeadServiceWiring[] = [
  {
    serviceName: "WatchedStreamManager",
    sourceFile: "src/renderer/services/watched-stream-manager.ts",
    instantiatedIn: "Nowhere (no production construction)",
    consumedBy: [
      {
        file: "src/renderer/components/workspace/ViewerWorkspace.tsx",
        method: "line 962 (direct ViewerSession construction instead)",
        description: "ViewerWorkspace creates ViewerSession directly; WatchedStreamManager is never called.",
      },
      {
        file: "src/renderer/services/restart-coordinator.ts",
        method: "lines 35-49 (stale documentation comment)",
        description: "Comments still reference WatchedStreamManager reconnect, but production uses ViewerSession.",
      },
    ],
    productionConstruction: null,
    hasTests: true,
    deletionNotes:
      "Safe to delete the file and its test file. Update comments in restart-coordinator.ts lines 35-49. " +
      "Verify no import remains in phase3-runtime.ts or elsewhere.",
  },
  {
    serviceName: "GroupSettingsLiveApply",
    sourceFile: "src/renderer/services/group-settings-live-apply.ts",
    instantiatedIn: "No production construction or import found",
    consumedBy: [
      {
        file: "src/renderer/services/group-settings-live-apply.ts",
        method: "exported class",
        description: "Class is exported but never imported in production code.",
      },
    ],
    productionConstruction: null,
    hasTests: true,
    deletionNotes:
      "Safe to delete the file and its test. The applySenderSettings() utility it depends on " +
      "is in quality-coordinator.ts and is used by other production paths. Keep that function.",
  },
  {
    serviceName: "RestartCoordinator.restartHostStreams()",
    sourceFile: "src/renderer/services/restart-coordinator.ts",
    instantiatedIn: "Phase3Runtime (class instantiated, but restartHostStreams is never called)",
    consumedBy: [],
    productionConstruction: "Phase3Runtime line N (class instance), but method is never called in production.",
    hasTests: false,
    deletionNotes:
      "The method fabricates a random media session ID for a remote host without restarting " +
      "publication — dangerous if accidentally called. Delete the method and update " +
      "restart-coordinator.ts comments referencing WatchedStreamManager.",
  },
  {
    serviceName: "QualityCoordinator.acceptedRequests + decideViewerRequest()",
    sourceFile: "src/renderer/services/quality-coordinator.ts",
    instantiatedIn: "Phase3Runtime (always instantiated)",
    consumedBy: [],
    productionConstruction: "Phase3Runtime (always constructed)",
    hasTests: true,
    deletionNotes:
      "DELETED in Phase 2. Replaced with simplified acceptedRevisions map and " +
      "getAcceptedRevision(). The full decideViewerRequest/acceptedRequests/streamViewerIndex " +
      "machinery is removed. handleViewerRequest now stores the revision directly.",
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Manual-Only Reproduction Documentation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Structured record for defects that cannot be fully automated without
 * production code changes.
 */
export interface ManualReproduction {
  defectId: string;
  title: string;
  reason: string;
  manualSteps: string[];
  expectedOutcome: string;
}

/**
 * Defects that require manual reproduction or production changes to test fully.
 * These are documented here so the Phase 0 exit criterion ("each confirmed defect
 * has a failing test or an explicitly documented manual-only reproduction") is met.
 */
export const MANUAL_ONLY_REPRODUCTIONS: ManualReproduction[] = [
  {
    defectId: "B-04",
    title: "Settings alternate between preset and requested settings (multiple quality authorities)",
    reason: "Requires live interaction between QualityCoordinator, group-default changes, viewer requests, " +
      "and UI rendering. The oscillation is timing-dependent when multiple concurrent sender writers exist. " +
      "Production source changes (Phase 6 single-sender-writer) are needed to demonstrate the fix.",
    manualSteps: [
      "1. Host starts sharing with group default preset 'High Quality'.",
      "2. Viewer requests a different quality (e.g., lower bitrate).",
      "3. While viewer request is pending, change group preset to 'Balanced'.",
      "4. Observe the applied sender parameters oscillate between the viewer request, group default, and fallback.",
    ],
    expectedOutcome: "Sender parameters should stabilize at the last authoritative write. " +
      "Currently they can oscillate because no single sender writer serializes the writes.",
  },
  {
    defectId: "B-05",
    title: "After the viewer's internet drops, media may continue while features stop; no automatic refresh",
    reason: "Requires real network conditions or a simulated WebRTC disconnect. The control plane " +
      "(GroupControlConnection WebSocket) and media plane (VDO adapter RTCPeerConnection) are " +
      "independent. Simulating their combined failure in a unit test requires either " +
      "production changes (ConnectionSupervisor) or integration-level test infrastructure.",
    manualSteps: [
      "1. Start a viewer session with an active stream.",
      "2. Disconnect the viewer's network (e.g., disable WiFi or pull network cable).",
      "3. Observe that media playback may continue for a while (buffered) while control features stop.",
      "4. Reconnect the network and check whether the viewer automatically recovers.",
    ],
    expectedOutcome: "The viewer should detect combined control+media health and auto-recover. " +
      "Currently there is no automatic recovery path for mid-session drops.",
  },
  {
    defectId: "B-07",
    title: "A/B testing button should be optional and hidden by default",
    reason: "This is a product/UI preference issue. The A/B compare button is rendered when a callback " +
      "exists at VideoControls.tsx:554-572. No persisted visibility field exists in user settings. " +
      "Testing this requires a UI component test with the actual VideoControls rendering.",
    manualSteps: [
      "1. Observe the A/B compare button in the viewer controls during an active stream.",
      "2. Navigate to user settings — no 'Show A/B controls' toggle exists.",
      "3. The feature is always visible regardless of user preference.",
    ],
    expectedOutcome: "A/B compare button should be hidden by default with a toggle in user settings.",
  },
  {
    defectId: "B-08",
    title: "Frame-rate slider sometimes has no effect",
    reason: "FPS is separately constrained (capture uses ideal and swallows rejection at " +
      "stream-session-manager.ts:1331-1371), captured, encoded, and displayed without closed-loop readback. " +
      "Multiple writers for sender FPS (B-04). Full reproduction requires a real " +
      "capture stream with hardware-constrained FPS values.",
    manualSteps: [
      "1. Host starts sharing with a high FPS value (e.g., 60).",
      "2. Viewer requests a lower FPS value (e.g., 15) via quality request.",
      "3. Check the sender's actual configured maxFramerate — it may remain at 60.",
      "4. Try applying FPS changes via group defaults — they may or may not take effect depending on writer timing.",
    ],
    expectedOutcome: "FPS slider should change the sender's maxFramerate and the change should be " +
      "confirmed via getParameters readback. Currently the readback loop is not closed.",
  },
  {
    defectId: "B-10",
    title: "Failed startup can orphan capture tracks and active metrics history",
    reason: "Startup catch calls only cleanupPublisher() at stream-session-manager.ts:511-517, " +
      "and host metrics starts before capture/publish at :378-384. A failure after metrics starts " +
      "but before publish leaves orphan metrics. Requires a controlled failure injection " +
      "at specific points in the async startStream flow.",
    manualSteps: [
      "1. Start a share that fails during Phase A (media startup), e.g., by making the SDK publisher fail.",
      "2. Check that the display-capture video track is stopped (it will not be — the catch only calls cleanupPublisher).",
      "3. Check that the StreamMetricsService session is finalized (it will not be — it started before the failure).",
    ],
    expectedOutcome: "On failed startup, capture tracks must be stopped and the metrics session must be finalized. " +
      "Currently neither happens in the catch block at line 511-517.",
  },
  {
    defectId: "B-11",
    title: "Restart creates a new host metrics session without finalizing the old one",
    reason: "New session starts at stream-session-manager.ts:958-963; the old history is not finalized " +
      "in the restart preamble at :862-872. This requires SSM in restarting state with an active metrics " +
      "session. Can be partially characterized by ensuring startStream in restarting state does or doesn't finalize.",
    manualSteps: [
      "1. Start a share (creates metrics session A).",
      "2. Initiate a restart (creates metrics session B at line 958-963).",
      "3. Check whether metrics session A was finalized/closed before session B started.",
      "4. Currently it is not finalized, leaving session A as an orphan.",
    ],
    expectedOutcome: "Restart preamble must finalize the prior metrics session before starting a new one.",
  },
  {
    defectId: "B-14",
    title: "Source switch and stop can race",
    reason: "switchSource() checks lifecycle after source approval but not after getDisplayMedia() " +
      "or replaceVideoTrack() at stream-session-manager.ts:616-655. Teardown can null/stop publisher " +
      "state concurrently. Reproducing the exact race requires precise async timing control.",
    manualSteps: [
      "1. Host is actively sharing.",
      "2. User clicks 'Stop Sharing' at the exact moment switchSource completes getDisplayMedia.",
      "3. The new capture source may be acquired (and not stopped) while the share is torn down.",
    ],
    expectedOutcome: "Operations should serialize so stop during switchSource either cancels the switch " +
      "and cleans up the new capture, or waits for the switch to finish before stopping.",
  },
  {
    defectId: "B-15",
    title: "Publisher track replacement and stop can race across an awaited SDK operation",
    reason: "publisher-manager.ts:626-658 checks fields before awaiting replacement; stopCapture() " +
      "can clear the same fields at :661-712. Requires precise interleaving of the two async paths.",
    manualSteps: [
      "1. During active sharing, trigger replaceVideoTrack (source switch).",
      "2. Concurrently trigger stopCapture.",
      "3. The fields checked at line 627-629 (this.publisher, this._publishedVideoTrack) " +
        "may be valid before await, but nulled by stopCapture during the await.",
    ],
    expectedOutcome: "Operations should be serialized via a queue or lock. " +
      "replaceVideoTrack should check state after await and fail gracefully if stopCapture ran.",
  },
];
