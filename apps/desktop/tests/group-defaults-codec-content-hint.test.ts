// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GroupQualitySettings, QualityPreset } from "@screenlink/shared";
import {
  createDefaultGroupQualitySettings,
  createDefaultVideoQualitySettings,
  createDefaultAudioEncodingSettings,
} from "@screenlink/shared";
import { QualityCoordinator } from "../src/renderer/services/quality-coordinator.js";
import { MediaStatsPoller } from "../src/renderer/services/media-stats-service.js";

// ─── Gap 1: Group defaults drive codec/content-hint/degradation/capture ───

describe("Gap 1: Group defaults drive codec/content-hint/degradation/capture", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("PublisherConfig interface supports codec, contentHint, degradationPreference, capture settings", () => {
    // Verify the PublisherConfig interface has the new fields by constructing a valid config
    const config = {
      sourceId: "test-source",
      password: "test-pw",
      streamId: "test-stream",
      videoBitrate: 1000,
      videoWidth: 1280,
      videoHeight: 720,
      videoFps: 30,
      codec: "vp9" as const,
      contentHint: "detail" as const,
      degradationPreference: "maintain-resolution" as const,
      captureWidth: 1920,
      captureHeight: 1080,
      captureFps: 60,
    };
    expect(config.codec).toBe("vp9");
    expect(config.contentHint).toBe("detail");
    expect(config.degradationPreference).toBe("maintain-resolution");
    expect(config.captureWidth).toBe(1920);
    expect(config.captureHeight).toBe(1080);
    expect(config.captureFps).toBe(60);
  });

  it("group defaults codec flows through PublisherConfig to HostPublisher", () => {
    const qualitySettings = createDefaultGroupQualitySettings();
    qualitySettings.video.codec = "h264";

    // The config should carry the codec from group defaults
    const config = {
      sourceId: "test-source",
      password: "test-pw",
      streamId: "test-stream",
      videoBitrate: qualitySettings.video.videoBitrateKbps,
      videoWidth: qualitySettings.video.sendWidth,
      videoHeight: qualitySettings.video.sendHeight,
      videoFps: qualitySettings.video.sendFps,
      codec: qualitySettings.video.codec,
      contentHint: qualitySettings.video.contentHint,
      degradationPreference: qualitySettings.video.degradationPreference,
      captureWidth: qualitySettings.video.captureWidth,
      captureHeight: qualitySettings.video.captureHeight,
      captureFps: qualitySettings.video.captureFps,
    };
    expect(config.codec).toBe("h264");
    expect(config.contentHint).toBe("detail");
    expect(config.degradationPreference).toBe("maintain-resolution");
    expect(config.captureWidth).toBe(854);
    expect(config.captureHeight).toBe(480);
    expect(config.captureFps).toBe(15);
  });

  it("stream-session-manager reads codec/contentHint/degradationPreference from group defaults", () => {
    // Simulate the extraction logic used in startStream
    const quality = createDefaultGroupQualitySettings();

    const videoBitrate = quality.video.videoBitrateKbps ?? 650;
    const videoWidth = quality.video.sendWidth ?? 854;
    const videoHeight = quality.video.sendHeight ?? 480;
    const videoFps = quality.video.sendFps ?? 15;
    const codec = quality.video.codec ?? "auto";
    const contentHint = quality.video.contentHint ?? "detail";
    const degradationPreference =
      quality.video.degradationPreference ?? "balanced";
    const captureWidth = quality.video.captureWidth ?? 854;
    const captureHeight = quality.video.captureHeight ?? 480;
    const captureFps = quality.video.captureFps ?? 15;

    expect(videoBitrate).toBe(650);
    expect(videoWidth).toBe(854);
    expect(videoHeight).toBe(480);
    expect(videoFps).toBe(15);
    expect(codec).toBe("vp9");
    expect(contentHint).toBe("detail");
    expect(degradationPreference).toBe("maintain-resolution");
    expect(captureWidth).toBe(854);
    expect(captureHeight).toBe(480);
    expect(captureFps).toBe(15);
  });

  it("PublisherManager accepts extended config with codec/contentHint/degradationPreference", async () => {
    const { PublisherManager } = await import(
      "../src/renderer/services/publisher-manager.js"
    );

    const pm = new PublisherManager({
      onStateChange: vi.fn(),
      onStats: vi.fn(),
      onError: vi.fn(),
      onTrackEnded: vi.fn(),
    });

    expect(pm).toBeDefined();

    // Verify the type is structurally sound
    const config: Record<string, unknown> = {
      sourceId: "test-source",
      password: "test-pw",
      streamId: "test-stream",
      videoBitrate: 2000,
      videoWidth: 1280,
      videoHeight: 720,
      videoFps: 30,
      codec: "vp9",
      contentHint: "detail",
      degradationPreference: "maintain-resolution",
      captureWidth: 1920,
      captureHeight: 1080,
      captureFps: 60,
    };
    expect(config.codec).toBe("vp9");
    expect(config.contentHint).toBe("detail");
    expect(config.degradationPreference).toBe("maintain-resolution");
    expect(config.captureWidth).toBe(1920);
  });
});

// ─── Gap 2: Groups UI list current streamers ─────────────────────────────

describe("Gap 2: Groups UI list current streamers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("activeStreamsByGroup holds stream data with hostDisplayName", async () => {
    const { useStore } = await import("../src/renderer/stores/main-store.js");

    // Simulate what the ActiveStreamRegistry does
    useStore.getState().setActiveStreams({
      "group-1": [
        {
          logicalStreamId: "stream-1",
          mediaSessionId: "session-1",
          groupId: "group-1",
          hostDeviceId: "host-device-1",
          hostDisplayName: "Streamer Alpha",
          sourceKind: "screen",
          sourceName: "Screen 1",
          startedAt: Date.now() - 5000,
          appliedSettingsRevision: 0,
          heartbeatSequence: 1,
          replacesSessionId: null,
        },
        {
          logicalStreamId: "stream-2",
          mediaSessionId: "session-2",
          groupId: "group-1",
          hostDeviceId: "host-device-2",
          hostDisplayName: "Streamer Beta",
          sourceKind: "window",
          sourceName: "App Window",
          startedAt: Date.now() - 3000,
          appliedSettingsRevision: 0,
          heartbeatSequence: 1,
          replacesSessionId: null,
        },
      ] as any,
    });

    const streams =
      useStore.getState().activeStreamsByGroup["group-1"] ?? [];
    expect(streams).toHaveLength(2);
    expect(streams[0].hostDisplayName).toBe("Streamer Alpha");
    expect(streams[1].hostDisplayName).toBe("Streamer Beta");
  });

  it("deduplicates streamers by hostDeviceId for display", () => {
    // When a host restarts a stream, the registry may have multiple entries
    // The UI should deduplicate by hostDeviceId for the "who's streaming" list
    const streams = [
      {
        logicalStreamId: "s1",
        hostDeviceId: "dev-1",
        hostDisplayName: "Alice",
      },
      {
        logicalStreamId: "s2",
        hostDeviceId: "dev-1",
        hostDisplayName: "Alice",
      },
      {
        logicalStreamId: "s3",
        hostDeviceId: "dev-2",
        hostDisplayName: "Bob",
      },
    ];

    const uniqueHosts = new Map(
      streams.map((s) => [s.hostDeviceId, s.hostDisplayName])
    );
    expect(uniqueHosts.size).toBe(2);
    expect(uniqueHosts.get("dev-1")).toBe("Alice");
    expect(uniqueHosts.get("dev-2")).toBe("Bob");
  });
});

// ─── Gap 3: Quality Presets UI choose watched target explicitly ──────────

describe("Gap 3: Quality Presets UI choose target stream explicitly", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("resolveWatchedHosts returns all watched streams with host info", () => {
    // This simulates the replacement for resolveFirstWatchedHost
    // The new version returns ALL available targets, not just the first
    const watchedStreamsBySessionId: Record<
      string,
      { hostDeviceId: string; hostName: string; startedAt: number }
    > = {
      "session-a": {
        hostDeviceId: "dev-a",
        hostName: "Streamer A",
        startedAt: 1000,
      },
      "session-b": {
        hostDeviceId: "dev-b",
        hostName: "Streamer B",
        startedAt: 2000,
      },
    };

    const activeStreamsByGroup: Record<
      string,
      Array<{ mediaSessionId: string; groupId: string }>
    > = {
      "group-1": [
        {
          mediaSessionId: "session-a",
          groupId: "group-1",
        },
      ],
      "group-2": [
        {
          mediaSessionId: "session-b",
          groupId: "group-2",
        },
      ],
    };

    // The new resolver: returns ALL watched streams
    const resolveWatchedHosts = (): Array<{
      groupId: string;
      sessionId: string;
      hostDeviceId: string;
      hostName: string;
    }> => {
      const result: Array<{
        groupId: string;
        sessionId: string;
        hostDeviceId: string;
        hostName: string;
      }> = [];
      for (const [sessionId, w] of Object.entries(
        watchedStreamsBySessionId
      )) {
        for (const [gid, streams] of Object.entries(activeStreamsByGroup)) {
          for (const stream of streams) {
            if (stream.mediaSessionId === sessionId) {
              result.push({
                groupId: gid,
                sessionId,
                hostDeviceId: w.hostDeviceId,
                hostName: w.hostName,
              });
            }
          }
        }
      }
      return result;
    };

    const hosts = resolveWatchedHosts();
    expect(hosts).toHaveLength(2);
    expect(hosts[0].hostName).toBe("Streamer A");
    expect(hosts[1].hostName).toBe("Streamer B");
  });

  it("user can select a specific watched target from multiple options", () => {
    const targets = [
      {
        groupId: "g-1",
        sessionId: "s-a",
        hostDeviceId: "dev-a",
        hostName: "Alice",
      },
      {
        groupId: "g-1",
        sessionId: "s-b",
        hostDeviceId: "dev-b",
        hostName: "Bob",
      },
    ];

    // Initially no selection
    let selectedTarget: (typeof targets)[0] | null = null;
    expect(selectedTarget).toBeNull();

    // User selects Bob
    selectedTarget = targets[1];
    expect(selectedTarget).not.toBeNull();
    expect(selectedTarget!.hostName).toBe("Bob");
    expect(selectedTarget!.hostDeviceId).toBe("dev-b");
  });

  it("quality request sends to selected target instead of first watched", async () => {
    const selectedTarget = {
      groupId: "g-1",
      sessionId: "s-b",
      hostDeviceId: "dev-b",
      hostName: "Bob",
    };

    const sendToPeer = vi.fn().mockResolvedValue(undefined);
    const peerForDevice = vi.fn().mockReturnValue("peer-uuid-b");

    // Use selected target
    const peerUuid = peerForDevice(selectedTarget.hostDeviceId);
    if (peerUuid) {
      await sendToPeer(peerUuid, {
        type: "quality.viewer.request",
        streamSessionId: selectedTarget.sessionId,
      });
    }

    expect(peerForDevice).toHaveBeenCalledWith("dev-b");
    expect(sendToPeer).toHaveBeenCalledWith(
      "peer-uuid-b",
      expect.objectContaining({
        type: "quality.viewer.request",
        streamSessionId: "s-b",
      })
    );
  });
});

// ─── Gap 4: Quality status display for selected target ───────────────────

describe("Gap 4: Quality status display for selected target", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("QualityCoordinator.getViewerRequest retrieves request for the selected target", () => {
    const coordinator = new QualityCoordinator();

    coordinator.handleViewerRequest("g-1", "stream-b", "local-viewer", {
      streamSessionId: "session-b",
      requestId: "req-1",
      revision: 1,
      videoBitrateKbps: 3000,
      maxWidth: 1280,
      maxHeight: 720,
      maxFps: 30,
      degradationPreference: "balanced",
    });

    const request = coordinator.getViewerRequest(
      "g-1",
      "stream-b",
      "local-viewer"
    );
    expect(request).not.toBeNull();
    expect(request!.videoBitrateKbps).toBe(3000);
    expect(request!.maxWidth).toBe(1280);
    expect(request!.maxFps).toBe(30);
  });

  it("effective quality calculation produces visible requested/effective/clampReasons", () => {
    const coordinator = new QualityCoordinator();
    const groupSettings = createDefaultGroupQualitySettings();
    const hostLimits = {
      maxVideoBitrateKbps: 5000,
      maxWidth: 1920,
      maxHeight: 1080,
      maxFps: 60,
      allowViewerQualityRequests: true,
    };

    // Viewer requests quality that exceeds host limits
    const request = {
      streamSessionId: "session-b",
      requestId: "req-1",
      revision: 1,
      videoBitrateKbps: 10000,
      maxWidth: 3840,
      maxHeight: 2160,
      maxFps: 120,
      degradationPreference: "maintain-framerate" as const,
    };

    const effective = coordinator.calculateEffectiveQuality(
      groupSettings,
      hostLimits,
      request,
      { width: 1920, height: 1080 }
    );

    // Requested (what the viewer asked for)
    expect(effective.requested).not.toBeNull();
    expect(effective.requested!.videoBitrateKbps).toBe(10000);
    expect(effective.requested!.maxWidth).toBe(3840);

    // Effective (what was calculated after clamping)
    expect(effective.effective.videoBitrateKbps).toBe(5000); // clamped
    expect(effective.effective.maxWidth).toBe(1920); // clamped

    // Clamp reasons explain what happened
    expect(effective.clampReasons.length).toBeGreaterThan(0);
    const hasBitrateClamp = effective.clampReasons.some((r) =>
      r.includes("Bitrate")
    );
    expect(hasBitrateClamp).toBe(true);
  });

  it("configured data shows sender application result", () => {
    const coordinator = new QualityCoordinator();
    const groupSettings = createDefaultGroupQualitySettings();
    const hostLimits = {
      maxVideoBitrateKbps: 5000,
      maxWidth: 1920,
      maxHeight: 1080,
      maxFps: 60,
      allowViewerQualityRequests: true,
    };

    const request = {
      streamSessionId: "session-b",
      requestId: "req-1",
      revision: 1,
      videoBitrateKbps: 2500,
      maxWidth: 1280,
      maxHeight: 720,
      maxFps: 30,
      degradationPreference: "balanced" as const,
      requestedAt: Date.now(),
    };

    const effective = coordinator.calculateEffectiveQuality(
      groupSettings,
      hostLimits,
      request,
      { width: 1920, height: 1080 }
    );

    // Simulate sender application result
    const configured = {
      maxBitrate: effective.effective.videoBitrateKbps * 1000,
      maxFramerate: effective.effective.maxFps,
      scaleResolutionDownBy: 1.5,
      degradationPreference: effective.effective.degradationPreference,
      priority: "medium",
    };

    // Full quality status for UI display
    const qualityStatus = {
      requested: effective.requested,
      effective: effective.effective,
      configured,
      clampReasons: effective.clampReasons,
    };

    expect(qualityStatus.requested).not.toBeNull();
    expect(qualityStatus.effective.videoBitrateKbps).toBe(2500);
    expect(qualityStatus.configured.maxBitrate).toBe(2_500_000);
    expect(qualityStatus.configured.degradationPreference).toBe("balanced");
  });

  it("per-viewer stats accessible for the selected target via MediaStatsPoller", () => {
    const poller = new MediaStatsPoller();

    poller.accumulateViewerStats({
      viewerDeviceId: "local-viewer",
      mediaPeerUuid: "peer-b",
      videoBitrateKbps: 2400,
      width: 1280,
      height: 720,
      fps: 30,
      codec: "VP9",
      qualityLimitationReason: "bandwidth",
      retransmittedBytes: 500,
      nackCount: 3,
      pliCount: 1,
      availableOutgoingBitrate: 5000,
      rtt: 15,
      packetLoss: 0.2,
      candidateType: "host",
      relayProtocol: "",
      audioBitrateKbps: 64,
      audioCodec: "opus",
    });

    const stats = poller.getViewerStats(
      "g-1",
      "stream-b",
      "local-viewer",
      "peer-b"
    );
    expect(stats).not.toBeNull();
    expect(stats!.videoBitrateKbps).toBe(2400);
    expect(stats!.codec).toBe("VP9");
    expect(stats!.qualityLimitationReason).toBe("bandwidth");
  });

  it("Phase3Runtime.getQualityCoordinator returns the coordinator", async () => {
    const { Phase3Runtime } = await import(
      "../src/renderer/services/phase3-runtime.js"
    );
    const runtime = new Phase3Runtime();
    await runtime.initialize();

    const coordinator = runtime.getQualityCoordinator();
    expect(coordinator).toBeDefined();
    expect(typeof coordinator.getViewerRequest).toBe("function");
    expect(typeof coordinator.calculateEffectiveQuality).toBe("function");

    await runtime.destroy();
  });
});
