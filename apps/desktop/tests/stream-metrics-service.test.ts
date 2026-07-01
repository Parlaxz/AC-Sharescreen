import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StreamMetricsService, type StreamHistoryRecord } from "../src/renderer/services/stream-metrics-service.js";
import type { PersistenceRecordV2 } from "../src/renderer/services/bandwidth-telemetry-types.js";

function makeMockPC(videoBytes: number, ssrc: number): RTCPeerConnection {
  const pc = createMockPC();
  const stats = (pc as unknown as { _stats: Map<string, Record<string, unknown>> })._stats;
  stats.set("rtp-video", {
    type: "inbound-rtp",
    kind: "video",
    bytesReceived: videoBytes,
    ssrc,
    mid: "0",
    codecId: "codec-vp9",
    frameWidth: 1920,
    frameHeight: 1080,
    framesPerSecond: 60,
  });
  stats.set("codec-vp9", { type: "codec", id: "codec-vp9", mimeType: "video/VP9" });
  stats.set("cp", {
    type: "candidate-pair",
    state: "succeeded",
    selected: true,
    bytesReceived: videoBytes,
    currentRoundTripTime: 0.01,
    localCandidateId: "lc",
    remoteCandidateId: "rc",
  });
  stats.set("lc", { type: "local-candidate", candidateType: "host" });
  stats.set("rc", { type: "remote-candidate", candidateType: "host" });
  return pc;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function createMockScreenlink() {
  let store: PersistenceRecordV2[] = [];
  return {
    getStreamHistory: vi.fn<() => Promise<PersistenceRecordV2[]>>().mockImplementation(async () => [...store]),
    saveStreamHistory: vi.fn<(r: PersistenceRecordV2[]) => Promise<void>>().mockImplementation(async (r) => { store = r.map(x => ({ ...x })); }),
    upsertStreamHistory: vi.fn<(record: unknown) => Promise<void>>().mockImplementation(async (record) => {
      const r = record as PersistenceRecordV2;
      const idx = store.findIndex(x => x.historyId === r.historyId);
      if (idx >= 0) store[idx] = { ...r };
      else store.push({ ...r });
    }),
    _getStore: () => store,
    _setStore: (s: PersistenceRecordV2[]) => { store = s.map(x => ({ ...x })); },
  };
}

function createMockPC(): RTCPeerConnection {
  const stats = new Map<string, Record<string, unknown>>();
  return {
    getStats: vi.fn().mockImplementation(async () => stats),
    _stats: stats,
  } as unknown as RTCPeerConnection;
}

function setupTest() {
  vi.useFakeTimers();
  const mock = createMockScreenlink();
  (globalThis as any).window = { screenlink: mock };
  return { mock };
}

function teardownTest() {
  StreamMetricsService.setInstance(null);
  vi.useRealTimers();
  delete (globalThis as any).window;
}

async function flushPromises() {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}

async function advanceTime(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await flushPromises();
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("StreamMetricsService", () => {
  let svc: StreamMetricsService;

  beforeEach(() => { setupTest(); svc = StreamMetricsService.getInstance(); });
  afterEach(() => { teardownTest(); });

  describe("startHostSession", () => {
    it("returns unique historyId on each call", () => {
      const id1 = svc.startHostSession("ms1", "ls1", "g1", "G1");
      const id2 = svc.startHostSession("ms2", "ls2", "g1", "G1");
      expect(id1).not.toBe(id2);
    });

    it("starts the timer when first session is created", () => {
      expect((svc as any).timer).toBeNull();
      svc.startHostSession("ms1", "ls1", "g1", "G1");
      expect((svc as any).timer).not.toBeNull();
    });

    it("does not start a second timer when another session starts", () => {
      svc.startHostSession("ms1", "ls1", "g1", "G1");
      const timer1 = (svc as any).timer;
      svc.startHostSession("ms2", "ls2", "g1", "G1");
      expect((svc as any).timer).toBe(timer1);
    });
  });

  describe("startViewerSession", () => {
    it("creates active viewer session", () => {
      const historyId = svc.startViewerSession("ms1", "ls1", "g1", "G1");
      expect(svc.getActiveSessionIds()).toContain(historyId);
    });

    it("rejoin creates different historyId", () => {
      const id1 = svc.startViewerSession("ms1", "ls1", "g1", "G1");
      const id2 = svc.startViewerSession("ms2", "ls2", "g1", "G1");
      expect(id1).not.toBe(id2);
    });
  });

  describe("registerConnection", () => {
    it("registers and unregisters a connection", () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "G1");
      const pc = createMockPC();
      const unreg = svc.registerConnection({
        historyId,
        connectionId: "host:dev1:uuid1",
        viewerDeviceId: "dev1",
        displayName: "Viewer 1",
        peerConnection: pc,
        direction: "outbound",
        configuredVideoBitsPerSecond: 5000000,
      });
      const snapshot = svc.getSnapshot(historyId);
      expect(snapshot.connections.length).toBe(1);
      expect(snapshot.connections[0].connectionId).toBe("host:dev1:uuid1");

      unreg();
      const snapshot2 = svc.getSnapshot(historyId);
      expect(snapshot2.connections.length).toBe(0);
    });
  });

  describe("addMarker", () => {
    it("adds a marker to the session via snapshot", () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "G1");
      svc.addMarker(historyId, "resolution", "1920x1080", "1280x720", "Res changed");
      const snapshot = svc.getSnapshot(historyId);
      expect(snapshot.aggregate.markers.length).toBe(1);
      expect(snapshot.aggregate.markers[0].type).toBe("resolution");
    });

    it("does not add markers for unknown historyId", () => {
      svc.addMarker("nonexistent", "other", null, "value", "label");
    });
  });

  describe("setSessionState", () => {
    it("transitions state and creates pause/resume markers", () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "G1");
      svc.setSessionState(historyId, "paused");
      const snapshot = svc.getSnapshot(historyId);
      expect(snapshot.aggregate.state).toBe("paused");

      svc.setSessionState(historyId, "playing");
      const snapshot2 = svc.getSnapshot(historyId);
      expect(snapshot2.aggregate.state).toBe("playing");
    });
  });

  describe("timer", () => {
    it("stops timer when no active sessions remain", async () => {
      const id1 = svc.startHostSession("ms1", "ls1", "g1", "G1");
      expect((svc as any).timer).not.toBeNull();
      await svc.finalizeSession(id1);
      expect((svc as any).timer).toBeNull();
    });

    it("does not stop timer when one of two sessions ends", async () => {
      const id1 = svc.startHostSession("ms1", "ls1", "g1", "G1");
      const id2 = svc.startHostSession("ms2", "ls2", "g1", "G1");
      await svc.finalizeSession(id1);
      expect((svc as any).timer).not.toBeNull();
      await svc.finalizeSession(id2);
      expect((svc as any).timer).toBeNull();
    });
  });

  describe("finalizeSession", () => {
    it("idempotent: repeated calls finalize once", async () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "G1");
      await advanceTime(100);
      await svc.finalizeSession(historyId);
      await svc.finalizeSession(historyId);
      expect(svc.getActiveSessionIds()).not.toContain(historyId);
    });
  });

  describe("getSnapshot", () => {
    it("returns empty snapshot for unknown historyId", () => {
      const snapshot = svc.getSnapshot("unknown");
      expect(snapshot.aggregate.rawSamples.length).toBe(0);
      expect(snapshot.connections.length).toBe(0);
    });

    it("snapshot contains aggregate and connections", () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "G1");
      const pc = createMockPC();
      svc.registerConnection({
        historyId, connectionId: "host:dev1:uuid1",
        viewerDeviceId: "dev1", displayName: "V1",
        peerConnection: pc, direction: "outbound",
      });
      const snapshot = svc.getSnapshot(historyId);
      expect(snapshot.aggregate).toBeDefined();
      expect(snapshot.connections).toBeDefined();
      expect(snapshot.role).toBe("host");
    });
  });

  describe("schema migration", () => {
    it("converts legacy v1 record to StreamHistoryRecord", async () => {
      const mock = (globalThis as any).window.screenlink;
      const now = Date.now();
      // Simulate a v1 record (schemaVersion undefined/1)
      const v1 = {
        historyId: "hist1", role: "host", status: "completed",
        startedAt: now - 60000, lastCheckpointAt: now, stoppedAt: now,
        durationMs: 60000, totalBytes: 5000000,
        averageBytesPerSecond: 83333, bytesPerSecond: 83333,
        samples: [{ timestamp: now, bytesPerSecond: 83333, totalBytes: 5000000 }],
        markers: [],
        interrupted: false,
      };
      mock._setStore([v1]);
      const history = await svc.getHistory();
      expect(history.length).toBe(1);
    });
  });

  describe("replaceConnectionPeer", () => {
    it("regression: updates the polled peer connection after pause/resume so KB/s counter recovers", async () => {
      const historyId = svc.startViewerSession("ms1", "ls1", "g1", "G1");

      const oldPc = makeMockPC(500_000, 1);
      svc.registerConnection({
        historyId,
        connectionId: "viewer-conn",
        viewerDeviceId: null,
        displayName: null,
        peerConnection: oldPc,
        direction: "inbound",
      });

      await advanceTime(1000);
      expect(oldPc.getStats).toHaveBeenCalledTimes(1);

      vi.clearAllMocks();

      svc.setSessionState(historyId, "paused");

      await advanceTime(1000);
      expect(oldPc.getStats).not.toHaveBeenCalled();
      vi.clearAllMocks();

      svc.setSessionState(historyId, "playing");

      await advanceTime(1000);
      expect(oldPc.getStats).toHaveBeenCalled();

      let snapshot = svc.getSnapshot(historyId);
      const oldCallCountAfterResume = (oldPc.getStats as ReturnType<typeof vi.fn>).mock.calls.length;

      const newPc = makeMockPC(1_000_000, 2);
      svc.replaceConnectionPeer(historyId, "viewer-conn", newPc);

      const conn = (svc as unknown as { connections: Map<string, { generation: number }> }).connections.get("viewer-conn");
      expect(conn?.generation).toBe(1);
      expect(oldCallCountAfterResume).toBeGreaterThan(0);

      vi.clearAllMocks();

      await advanceTime(1000);
      expect(newPc.getStats).toHaveBeenCalled();
      expect(oldPc.getStats).not.toHaveBeenCalled();

      snapshot = svc.getSnapshot(historyId);
      expect(snapshot.aggregate.currentBitsPerSecond).toBeGreaterThanOrEqual(0);
      expect(snapshot.connections.length).toBe(1);
    });
  });

  // ─── Extended telemetry: RTP evidence, bandwidth breakdown ────────────

  describe("extended telemetry - RTP evidence", () => {
    // ── Helpers ────────────────────────────────────────────────────────

    function setVideo(
      stats: Map<string, Record<string, unknown>>,
      bytes: number, ssrc: number, extra?: Record<string, unknown>,
    ): void {
      stats.set("rtp-video", {
        type: "inbound-rtp", kind: "video",
        bytesReceived: bytes, ssrc, mid: "0", codecId: "codec-vp9",
        frameWidth: 1920, frameHeight: 1080, framesPerSecond: 60,
        packetsReceived: 1000, packetsLost: 0, jitter: 0.005,
        ...extra,
      });
      stats.set("codec-vp9", { type: "codec", id: "codec-vp9", mimeType: "video/VP9" });
    }

    function setAudio(
      stats: Map<string, Record<string, unknown>>,
      id: string, bytes: number, ssrc: number, extra?: Record<string, unknown>,
    ): void {
      stats.set(id, {
        type: "inbound-rtp", kind: "audio",
        bytesReceived: bytes, ssrc, mid: "0", codecId: "codec-opus",
        packetsReceived: 200, packetsLost: 0, jitter: 0.003,
        ...extra,
      });
      stats.set("codec-opus", { type: "codec", id: "codec-opus", mimeType: "audio/opus" });
    }

    function setTransport(
      stats: Map<string, Record<string, unknown>>, bytes: number,
    ): void {
      stats.set("cp", {
        type: "candidate-pair", state: "succeeded", selected: true,
        bytesReceived: bytes, currentRoundTripTime: 0.01,
        localCandidateId: "lc", remoteCandidateId: "rc",
      });
      stats.set("lc", { type: "local-candidate", candidateType: "host" });
      stats.set("rc", { type: "remote-candidate", candidateType: "host" });
    }

    function setupConn(): {
      historyId: string;
      pc: RTCPeerConnection;
      stats: Map<string, Record<string, unknown>>;
    } {
      const historyId = svc.startViewerSession("ms-ext", "ls-ext", "g1", "G1");
      const pc = createMockPC();
      const stats = (pc as unknown as { _stats: Map<string, Record<string, unknown>> })._stats;
      svc.registerConnection({
        historyId, connectionId: "ext-conn", viewerDeviceId: null,
        displayName: null, peerConnection: pc, direction: "inbound",
      });
      return { historyId, pc, stats };
    }

    // ── Tests ─────────────────────────────────────────────────────────

    it("first sample baseline creates no spike", async () => {
      const { historyId, stats } = setupConn();
      setVideo(stats, 1_000_000, 1);
      setAudio(stats, "rtp-audio", 20_000, 101);
      setTransport(stats, 1_020_000);

      await advanceTime(1000); // tick 1 — baselines, rate 0
      let snapshot = svc.getSnapshot(historyId);
      expect(snapshot.aggregate.rawSamples.length).toBe(1);
      expect(snapshot.aggregate.rawSamples[0].mediaBitsPerSecond).toBe(0);
      // Per-connection sample exists and shows 0
      expect(snapshot.connections[0].rawSamples[0].mediaBitsPerSecond).toBe(0);
      expect(snapshot.connections[0].rawSamples[0].videoBitsPerSecond).toBe(0);
      expect(snapshot.connections[0].rawSamples[0].audioBitsPerSecond).toBe(0);

      await advanceTime(1000); // tick 2 — same bytes, delta zero
      snapshot = svc.getSnapshot(historyId);
      expect(snapshot.aggregate.rawSamples.length).toBe(2);
      expect(snapshot.aggregate.rawSamples[1].mediaBitsPerSecond).toBe(0);
    });

    it("video and audio bandwidth computed correctly", async () => {
      const { historyId, stats } = setupConn();

      // Tick 1: baseline with zero bytes
      setVideo(stats, 0, 1);
      setAudio(stats, "rtp-audio", 0, 101);
      setTransport(stats, 0);
      await advanceTime(1000);

      // Tick 2: accumulated bytes over ~1s
      setVideo(stats, 1_000_000, 1);
      setAudio(stats, "rtp-audio", 20_000, 101);
      setTransport(stats, 1_020_000);
      await advanceTime(1000);

      const snapshot = svc.getSnapshot(historyId);
      const sample = snapshot.aggregate.rawSamples[1];
      // Video: 1_000_000 × 8 ÷ ~1s ≈ 8_000_000 bps
      expect(sample.videoBitsPerSecond).toBeGreaterThanOrEqual(7_900_000);
      expect(sample.videoBitsPerSecond).toBeLessThanOrEqual(8_100_000);
      // Audio: 20_000 × 8 ÷ ~1s ≈ 160_000 bps
      expect(sample.audioBitsPerSecond).toBeGreaterThanOrEqual(150_000);
      expect(sample.audioBitsPerSecond).toBeLessThanOrEqual(170_000);
      // Total media = video + audio
      expect(sample.mediaBitsPerSecond)
        .toBe((sample.videoBitsPerSecond ?? 0) + (sample.audioBitsPerSecond ?? 0));
      expect(snapshot.aggregate.currentBitsPerSecond).toBe(sample.mediaBitsPerSecond);
      // Cumulative media = video + audio bytes
      expect(sample.cumulativeMediaBytes).toBe(1_020_000);
      expect(snapshot.aggregate.totalBytes).toBe(1_020_000);
    });

    it("multiple active audio streams summed correctly", async () => {
      const { historyId, stats } = setupConn();

      // Tick 1: baseline
      setVideo(stats, 0, 1);
      setAudio(stats, "rtp-audio-1", 0, 101);
      stats.set("rtp-audio-2", {
        type: "inbound-rtp", kind: "audio",
        bytesReceived: 0, ssrc: 102, mid: "0", codecId: "codec-opus",
        packetsReceived: 100, packetsLost: 0, jitter: 0.002,
      });
      setTransport(stats, 0);
      await advanceTime(1000);

      // Tick 2: both audio streams have bytes
      setAudio(stats, "rtp-audio-1", 10_000, 101);
      stats.set("rtp-audio-2", {
        type: "inbound-rtp", kind: "audio",
        bytesReceived: 5_000, ssrc: 102, mid: "0", codecId: "codec-opus",
        packetsReceived: 100, packetsLost: 0, jitter: 0.002,
      });
      setVideo(stats, 1_000_000, 1);
      setTransport(stats, 1_015_000);
      await advanceTime(1000);

      const snapshot = svc.getSnapshot(historyId);
      const sample = snapshot.aggregate.rawSamples[1];
      // Two audio streams: (10_000 + 5_000) = 15_000 bytes × 8 / ~1s ≈ 120_000 bps
      expect(sample.audioBitsPerSecond).toBeGreaterThanOrEqual(110_000);
      expect(sample.audioBitsPerSecond).toBeLessThanOrEqual(130_000);
    });

    it("candidate-pair transport not added to media totals", async () => {
      const { historyId, stats } = setupConn();

      setVideo(stats, 0, 1);
      setAudio(stats, "rtp-audio", 0, 101);
      setTransport(stats, 0);
      await advanceTime(1000);

      // Tick 2: transport bytes far exceed media bytes
      setVideo(stats, 1_000_000, 1);
      setAudio(stats, "rtp-audio", 20_000, 101);
      setTransport(stats, 5_000_000);
      await advanceTime(1000);

      const snapshot = svc.getSnapshot(historyId);
      const sample = snapshot.aggregate.rawSamples[1];
      // Cumulative media bytes = video + audio only
      expect(sample.cumulativeMediaBytes).toBe(1_020_000);
      expect(snapshot.aggregate.totalBytes).toBe(1_020_000);
      // mediaBitsPerSecond reflects media only
      expect(sample.mediaBitsPerSecond)
        .toBe((sample.videoBitsPerSecond ?? 0) + (sample.audioBitsPerSecond ?? 0));
      // transportBitsPerSecond is separate (not added to media)
      expect(sample.transportBitsPerSecond).toBeGreaterThan(0);
    });

    it("SSRC change does not spike rate", async () => {
      const { historyId, stats } = setupConn();

      // Tick 1: SSRC=1
      setVideo(stats, 500_000, 1);
      setAudio(stats, "rtp-audio", 10_000, 101);
      setTransport(stats, 510_000);
      await advanceTime(1000);

      // Tick 2: SSRC changes to 2 — new baseline, rate 0
      stats.clear();
      setVideo(stats, 600_000, 2);
      setAudio(stats, "rtp-audio", 15_000, 201);
      setTransport(stats, 615_000);
      await advanceTime(1000);
      let snapshot = svc.getSnapshot(historyId);
      expect(snapshot.aggregate.rawSamples.length).toBe(2);
      expect(snapshot.aggregate.rawSamples[1].mediaBitsPerSecond).toBe(0);

      // Tick 3: bytes increase from new baseline — normal rate
      setVideo(stats, 700_000, 2);
      setAudio(stats, "rtp-audio", 25_000, 201);
      setTransport(stats, 725_000);
      await advanceTime(1000);
      snapshot = svc.getSnapshot(historyId);
      expect(snapshot.aggregate.rawSamples.length).toBe(3);
      expect(snapshot.aggregate.rawSamples[2].mediaBitsPerSecond).toBeGreaterThan(0);
    });

    it("missing audio clears stale audio measurements", async () => {
      const { historyId, stats } = setupConn();

      // Tick 1: with audio
      setVideo(stats, 1_000_000, 1);
      setAudio(stats, "rtp-audio", 20_000, 101);
      setTransport(stats, 1_020_000);
      await advanceTime(1000);

      // Tick 2: audio stream removed from stats
      stats.delete("rtp-audio");
      stats.delete("codec-opus");
      setVideo(stats, 2_000_000, 1);
      setTransport(stats, 2_000_000);
      await advanceTime(1000);

      const snapshot = svc.getSnapshot(historyId);
      expect(snapshot.connections[0].currentAudioBitsPerSecond).toBeNull();
      expect(snapshot.connections[0].currentVideoBitsPerSecond).not.toBeNull();
      expect(snapshot.connections[0].currentBitsPerSecond).toBeGreaterThan(0);
    });

    it("codec resolved via codecId from active RTP stream", async () => {
      const { historyId, stats } = setupConn();

      // Manual setup: avoid setVideo helper to prevent codecMap ordering confusion
      stats.clear();
      stats.set("rtp-video", {
        type: "inbound-rtp", kind: "video",
        bytesReceived: 1_000_000, ssrc: 1, mid: "0", codecId: "codec-h264",
        frameWidth: 1920, frameHeight: 1080, framesPerSecond: 60,
        packetsReceived: 1000, packetsLost: 0, jitter: 0.005,
      });
      stats.set("rtp-audio", {
        type: "inbound-rtp", kind: "audio",
        bytesReceived: 20_000, ssrc: 101, mid: "0", codecId: "codec-opus",
        packetsReceived: 200, packetsLost: 0, jitter: 0.003,
      });
      // Add codecs in wrong order: VP9 first, H264 second, AV1 third
      // The RTP stream's codecId points to "codec-h264" — should resolve to H264
      stats.set("codec-vp9", { type: "codec", id: "codec-vp9", mimeType: "video/VP9" });
      stats.set("codec-h264", { type: "codec", id: "codec-h264", mimeType: "video/H264" });
      stats.set("codec-av1", { type: "codec", id: "codec-av1", mimeType: "video/AV1" });
      stats.set("codec-opus", { type: "codec", id: "codec-opus", mimeType: "audio/opus" });
      setTransport(stats, 1_020_000);

      await advanceTime(2000); // two ticks: baseline + measurement

      const snapshot = svc.getSnapshot(historyId);
      // Per-stream evidence (per-connection sample) has codec resolved via codecId
      const connSample = snapshot.connections[0].rawSamples[1];
      expect(connSample.videoRtpStreams.length).toBe(1);
      expect(connSample.videoRtpStreams[0].codecId).toBe("codec-h264");
      expect(connSample.videoRtpStreams[0].codecMimeType).toBe("video/H264");
    });

    it("jitter seconds converted to ms exactly once", async () => {
      const { historyId, stats } = setupConn();

      setVideo(stats, 1_000_000, 1, { jitter: 0.005 });
      setAudio(stats, "rtp-audio", 20_000, 101, { jitter: 0.003 });
      setTransport(stats, 1_020_000);

      await advanceTime(2000);

      // Per-stream evidence is per-connection, not carried in aggregate samples
      const snapshot = svc.getSnapshot(historyId);
      const connSample = snapshot.connections[0].rawSamples[1];
      expect(connSample.videoRtpStreams.length).toBe(1);
      // 0.005 seconds × 1000 = 5 ms
      expect(connSample.videoRtpStreams[0].jitterMs).toBe(5);
      expect(connSample.audioRtpStreams.length).toBe(1);
      // 0.003 seconds × 1000 = 3 ms
      expect(connSample.audioRtpStreams[0].jitterMs).toBe(3);
    });

    it("jitter-buffer delay and concealment delta calculations correct", async () => {
      const { historyId, stats } = setupConn();

      // Tick 1: initial audio stats
      setVideo(stats, 1_000_000, 1);
      setAudio(stats, "rtp-audio", 20_000, 101, {
        jitterBufferDelay: 0.5,
        jitterBufferEmittedCount: 100,
        concealedSamples: 10,
        concealedEvents: 2,
        totalSamplesReceived: 10000,
      });
      setTransport(stats, 1_020_000);
      await advanceTime(1000);

      // Tick 2: delta values
      setAudio(stats, "rtp-audio", 40_000, 101, {
        jitterBufferDelay: 1.5,
        jitterBufferEmittedCount: 300,
        concealedSamples: 30,
        concealedEvents: 5,
        totalSamplesReceived: 30000,
      });
      setVideo(stats, 2_000_000, 1);
      setTransport(stats, 2_040_000);
      await advanceTime(1000);

      // Per-stream evidence lives in per-connection samples
      const snapshot = svc.getSnapshot(historyId);
      const connSample = snapshot.connections[0].rawSamples[1];
      const audioEvidence = connSample.audioRtpStreams[0];

      // delay = (1.5-0.5) / (300-100) × 1000 = 1.0/200 × 1000 = 5.0 ms
      expect(audioEvidence.jitterBufferDelayMs).toBeCloseTo(5.0, 0);
      expect(audioEvidence.jitterBufferEmittedCount).toBe(200);

      // concealment% = (30-10)/(30000-10000) × 100 = 20/20000 × 100 = 0.1%
      expect(audioEvidence.concealmentPercent).toBeCloseTo(0.1, 0);
      expect(audioEvidence.concealedSamples).toBe(20);
      expect(audioEvidence.concealedEvents).toBe(3);
      expect(audioEvidence.totalSamplesReceived).toBe(20000);
    });

    it("rates null before first tick", async () => {
      const historyId = svc.startViewerSession("ms-pre", "ls-pre", "g1", "G1");
      const pc = createMockPC();
      svc.registerConnection({
        historyId, connectionId: "pre-tick", viewerDeviceId: null,
        displayName: null, peerConnection: pc, direction: "inbound",
      });

      const snapshot = svc.getSnapshot(historyId);
      expect(snapshot.connections.length).toBe(1);
      expect(snapshot.connections[0].currentVideoBitsPerSecond).toBeNull();
      expect(snapshot.connections[0].currentAudioBitsPerSecond).toBeNull();
      expect(snapshot.connections[0].currentTransportBitsPerSecond).toBeNull();
      // backward-compat alias remains 0
      expect(snapshot.connections[0].currentBitsPerSecond).toBe(0);
    });

    it("falls back to report.mediaType when report.kind is missing", async () => {
      const { historyId, stats } = setupConn();
      // Purposely omit kind, only set mediaType
      stats.clear();
      stats.set("rtp-video", {
        type: "inbound-rtp",
        mediaType: "video",
        bytesReceived: 200_000, ssrc: 1, mid: "0", codecId: "codec-vp9",
        frameWidth: 640, frameHeight: 480, framesPerSecond: 30,
      });
      stats.set("codec-vp9", { type: "codec", id: "codec-vp9", mimeType: "video/VP9" });
      // Set a transport pair so tick doesn't fail
      stats.set("cp", {
        type: "candidate-pair", state: "succeeded", selected: true,
        bytesReceived: 200_000, currentRoundTripTime: 0.01,
        localCandidateId: "lc", remoteCandidateId: "rc",
      });
      stats.set("lc", { type: "local-candidate", candidateType: "host" });
      stats.set("rc", { type: "remote-candidate", candidateType: "host" });

      await advanceTime(2000); // two ticks

      const snapshot = svc.getSnapshot(historyId);
      // Should have processed the video observation despite missing kind
      expect(snapshot.aggregate.rawSamples.length).toBeGreaterThanOrEqual(1);
      // Connection should have video bits per second (non-null)
      expect(snapshot.connections[0].currentVideoBitsPerSecond).not.toBeNull();
    });

    it("skips observations with unknown kind and no mediaType", async () => {
      const { historyId, stats } = setupConn();
      stats.clear();
      // Entry with kind="metadata" (not video/audio) and no mediaType
      stats.set("rtp-metadata", {
        type: "inbound-rtp",
        kind: "metadata",
        bytesReceived: 100_000, ssrc: 99, mid: "0", codecId: null,
      });
      stats.set("cp", {
        type: "candidate-pair", state: "succeeded", selected: true,
        bytesReceived: 100_000, currentRoundTripTime: 0.01,
        localCandidateId: "lc", remoteCandidateId: "rc",
      });
      stats.set("lc", { type: "local-candidate", candidateType: "host" });
      stats.set("rc", { type: "remote-candidate", candidateType: "host" });

      await advanceTime(1000);

      const snapshot = svc.getSnapshot(historyId);
      // No video or audio observations should have been processed
      expect(snapshot.connections[0].currentVideoBitsPerSecond).toBeNull();
      expect(snapshot.connections[0].currentAudioBitsPerSecond).toBeNull();
    });
  });
});
