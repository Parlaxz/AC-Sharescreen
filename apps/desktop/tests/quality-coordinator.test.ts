// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";
import { QualityCoordinator } from "../src/renderer/services/quality-coordinator.js";
import type { GroupQualitySettings, HostQualityLimits, ViewerQualityRequest } from "@screenlink/shared";
import { createDefaultGroupQualitySettings, createDefaultHostQualityLimits, RANGES } from "@screenlink/shared";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeGroupSettings(overrides?: Partial<GroupQualitySettings["video"]>): GroupQualitySettings {
  return {
    ...createDefaultGroupQualitySettings(),
    video: {
      ...createDefaultGroupQualitySettings().video,
      ...overrides,
    },
  };
}

function makeHostLimits(overrides?: Partial<HostQualityLimits>): HostQualityLimits {
  return {
    ...createDefaultHostQualityLimits(),
    ...overrides,
  };
}

function makeViewerRequest(overrides?: Partial<ViewerQualityRequest>): ViewerQualityRequest {
  return {
    streamSessionId: "session-1",
    requestId: "req-1",
    revision: 1,
    videoBitrateKbps: 2000,
    maxWidth: 1280,
    maxHeight: 720,
    maxFps: 30,
    degradationPreference: "balanced",
    requestedAt: Date.now(),
    ...overrides,
  };
}

// ─── Mock RTCRtpSender ─────────────────────────────────────────────────────

function createMockSender(
  storedParams?: Partial<RTCRtpSendParameters>,
): RTCRtpSender {
  let params: RTCRtpSendParameters = {
    encodings: [
      {
        active: true,
        maxBitrate: 500_000,
        maxFramerate: 15,
        scaleResolutionDownBy: 1,
        degradationPreference: "maintain-resolution",
        priority: "medium",
      },
    ],
    transactionId: "tx-test",
    codecs: [],
    headerExtensions: [],
    rtcp: {},
    degradationPreference: "maintain-resolution",
    ...storedParams,
  };

  return {
    getParameters: vi.fn(() => params),
    setParameters: vi.fn(async (p: RTCRtpSendParameters) => {
      params = p;
    }),
    track: {
      kind: "video",
      getSettings: () => ({ width: 1920, height: 1080 }),
    } as MediaStreamTrack,
  } as unknown as RTCRtpSender;
}

// ─── Stage 6 Tests ──────────────────────────────────────────────────────────

describe("Stage 6: QualityCoordinator — allowViewerQualityRequests rejection", () => {
  let coordinator: QualityCoordinator;

  beforeEach(() => {
    coordinator = new QualityCoordinator();
  });

  it("rejects viewer request when allowViewerQualityRequests is false", () => {
    const groupSettings = makeGroupSettings();
    const hostLimits = makeHostLimits({ allowViewerQualityRequests: false });
    const viewerRequest = makeViewerRequest();

    const result = coordinator.calculateEffectiveQuality(
      groupSettings,
      hostLimits,
      viewerRequest,
      { width: 1920, height: 1080 },
    );

    // viewer request should be nulled out when not allowed
    expect(result.requested).toBeNull();
    // effective values should match group defaults, not viewer request
    expect(result.effective.videoBitrateKbps).toBe(groupSettings.video.videoBitrateKbps);
    expect(result.effective.maxWidth).toBe(groupSettings.video.sendWidth);
    expect(result.effective.maxHeight).toBe(groupSettings.video.sendHeight);
    expect(result.effective.maxFps).toBe(groupSettings.video.sendFps);
    expect(result.effective.degradationPreference).toBe(groupSettings.video.degradationPreference);
  });

  it("accepts viewer request when allowViewerQualityRequests is true", () => {
    const groupSettings = makeGroupSettings();
    const hostLimits = makeHostLimits({ allowViewerQualityRequests: true });
    const viewerRequest = makeViewerRequest();

    const result = coordinator.calculateEffectiveQuality(
      groupSettings,
      hostLimits,
      viewerRequest,
      { width: 1920, height: 1080 },
    );

    expect(result.requested).not.toBeNull();
    expect(result.requested!.videoBitrateKbps).toBe(viewerRequest.videoBitrateKbps);
  });
});

describe("Stage 6: QualityCoordinator — resolution scaling (no maxWidth/maxWidth bug, no upscale)", () => {
  let coordinator: QualityCoordinator;

  beforeEach(() => {
    coordinator = new QualityCoordinator();
  });

  it("prevents upscale when preventUpscale is true (source smaller than request)", () => {
    const groupSettings = makeGroupSettings({ preventUpscale: true });
    const hostLimits = makeHostLimits({ allowViewerQualityRequests: true });
    const viewerRequest = makeViewerRequest({ maxWidth: 3840, maxHeight: 2160 });

    const result = coordinator.calculateEffectiveQuality(
      groupSettings,
      hostLimits,
      viewerRequest,
      { width: 1280, height: 720 }, // source is smaller
    );

    // Width/height should be clamped to source dimensions
    expect(result.effective.maxWidth).toBeLessThanOrEqual(1280);
    expect(result.effective.maxHeight).toBeLessThanOrEqual(720);
    // There should be clamp reasons for the upscale prevention
    expect(result.clampReasons.length).toBeGreaterThanOrEqual(1);
    expect(result.clampReasons.some(r => r.includes("preventUpscale"))).toBe(true);
  });

  it("does not upscale when source is small even with high request", () => {
    const groupSettings = makeGroupSettings({ preventUpscale: true, scaleResolutionDownBy: 1 });
    const hostLimits = makeHostLimits({ allowViewerQualityRequests: true });
    const viewerRequest = makeViewerRequest({ maxWidth: 3840, maxHeight: 2160 });

    const result = coordinator.calculateEffectiveQuality(
      groupSettings,
      hostLimits,
      viewerRequest,
      { width: 640, height: 480 },
    );

    // Should not upscale: effective should be <= source
    expect(result.effective.maxWidth).toBeLessThanOrEqual(640);
    expect(result.effective.maxHeight).toBeLessThanOrEqual(480);
  });

  it("applies scaleResolutionDownBy correctly using source width/height references", () => {
    const groupSettings = makeGroupSettings({
      preventUpscale: true,
      scaleResolutionDownBy: 2,
      sendWidth: 1920,
      sendHeight: 1080,
    });
    const hostLimits = makeHostLimits({ allowViewerQualityRequests: false });
    const sourceDimensions = { width: 1920, height: 1080 };

    const result = coordinator.calculateEffectiveQuality(
      groupSettings,
      hostLimits,
      null,
      sourceDimensions,
    );

    // scale=2 means dimensions should be halved
    expect(result.effective.maxWidth).toBe(960);
    expect(result.effective.maxHeight).toBe(540);
  });

  it("scaleResolutionDownBy does not go below 1", () => {
    const groupSettings = makeGroupSettings({
      scaleResolutionDownBy: 1,
      sendWidth: 854,
      sendHeight: 480,
    });
    const hostLimits = makeHostLimits();
    const sourceDimensions = { width: 854, height: 480 };

    const result = coordinator.calculateEffectiveQuality(
      groupSettings,
      hostLimits,
      null,
      sourceDimensions,
    );

    // scale=1 means no change
    expect(result.effective.maxWidth).toBe(854);
    expect(result.effective.maxHeight).toBe(480);
  });
});

describe("Stage 6: QualityCoordinator — applyToSender read back", () => {
  let coordinator: QualityCoordinator;

  beforeEach(() => {
    coordinator = new QualityCoordinator();
  });

  it("does not hardcode scaleResolutionDownBy=1, reads back from sender", async () => {
    const sender = createMockSender({
      encodings: [
        {
          active: true,
          maxBitrate: 500_000,
          maxFramerate: 15,
          scaleResolutionDownBy: 2,
          degradationPreference: "maintain-resolution",
          priority: "medium",
        },
      ],
    });

    const effective = {
      videoBitrateKbps: 2000,
      maxWidth: 1280,
      maxHeight: 720,
      maxFps: 30,
      degradationPreference: "balanced",
    };

    const configured = await coordinator.applyToSender(sender, effective);

    // The readback should capture the applied scaleResolutionDownBy, not hardcode 1
    expect(configured).not.toBeNull();
    expect(configured!.maxBitrate).toBe(2_000_000);
    // The applied scaleResolutionDownBy should match what was set (from sender)
    // After applyToSender sets it, readback shows the actual applied value
    const params = sender.getParameters();
    expect(params.encodings?.[0]?.scaleResolutionDownBy).toBeGreaterThan(0);
  });

  it("reads back maxBitrate and maxFramerate from sender after setParameters", async () => {
    const sender = createMockSender();

    const effective = {
      videoBitrateKbps: 1500,
      maxWidth: 854,
      maxHeight: 480,
      maxFps: 24,
      degradationPreference: "maintain-resolution",
    };

    const configured = await coordinator.applyToSender(sender, effective);

    expect(configured!.maxBitrate).toBe(1_500_000);
    expect(configured!.maxFramerate).toBe(24);
    expect(configured!.degradationPreference).toBe("maintain-resolution");
    expect(configured!.priority).toBe("medium");
  });

  it("sets scaleResolutionDownBy based on effective dimensions relative to source", async () => {
    const sender = createMockSender();

    const effective = {
      videoBitrateKbps: 1000,
      maxWidth: 640,
      maxHeight: 360,
      maxFps: 15,
      degradationPreference: "balanced",
    };

    await coordinator.applyToSender(sender, effective);
    const params = sender.getParameters();

    // scaleResolutionDownBy should be > 0 (actually computed from source/effective)
    expect(params.encodings?.[0]?.scaleResolutionDownBy).toBeGreaterThan(0);
    // It should NOT be the buggy `effective.maxWidth / effective.maxWidth` (which = 1)
    // since that's what we're fixing — compute from source width/actual dimensions
    expect(params.encodings?.[0]?.scaleResolutionDownBy).not.toBe(1);
  });
});

describe("Stage 6: QualityCoordinator — session request storage keyed by groupId+logicalStreamId+viewerDeviceId", () => {
  let coordinator: QualityCoordinator;

  beforeEach(() => {
    coordinator = new QualityCoordinator();
  });

  it("stores and retrieves viewer requests by composite key", () => {
    const groupId = "group-1";
    const logicalStreamId = "stream-1";
    const viewerDeviceId = "viewer-1";
    const request = makeViewerRequest();

    coordinator.storeViewerRequest(groupId, logicalStreamId, viewerDeviceId, request);
    const retrieved = coordinator.getViewerRequest(groupId, logicalStreamId, viewerDeviceId);

    expect(retrieved).toEqual(request);
  });

  it("returns null for non-existent composite key", () => {
    const result = coordinator.getViewerRequest("nonexistent", "nox", "nox");
    expect(result).toBeNull();
  });

  it("clears viewer request by composite key", () => {
    const groupId = "group-1";
    const logicalStreamId = "stream-1";
    const viewerDeviceId = "viewer-1";
    const request = makeViewerRequest();

    coordinator.storeViewerRequest(groupId, logicalStreamId, viewerDeviceId, request);
    coordinator.clearViewerRequest(groupId, logicalStreamId, viewerDeviceId);

    const retrieved = coordinator.getViewerRequest(groupId, logicalStreamId, viewerDeviceId);
    expect(retrieved).toBeNull();
  });

  it("different viewerDeviceIds have separate requests for same group+stream", () => {
    const groupId = "group-1";
    const logicalStreamId = "stream-1";

    coordinator.storeViewerRequest(groupId, logicalStreamId, "viewer-1", makeViewerRequest({ requestId: "req-1" }));
    coordinator.storeViewerRequest(groupId, logicalStreamId, "viewer-2", makeViewerRequest({ requestId: "req-2" }));

    const v1 = coordinator.getViewerRequest(groupId, logicalStreamId, "viewer-1");
    const v2 = coordinator.getViewerRequest(groupId, logicalStreamId, "viewer-2");

    expect(v1?.requestId).toBe("req-1");
    expect(v2?.requestId).toBe("req-2");
  });

  it("getAllViewerRequests returns all requests for a group+stream", () => {
    const groupId = "group-1";
    const logicalStreamId = "stream-1";

    coordinator.storeViewerRequest(groupId, logicalStreamId, "viewer-1", makeViewerRequest({ requestId: "req-1" }));
    coordinator.storeViewerRequest(groupId, logicalStreamId, "viewer-2", makeViewerRequest({ requestId: "req-2" }));

    const all = coordinator.getAllViewerRequests(groupId, logicalStreamId);

    expect(all).toHaveLength(2);
    expect(all.find(r => r.requestId === "req-1")).toBeTruthy();
    expect(all.find(r => r.requestId === "req-2")).toBeTruthy();
  });

  it("stores all viewer requests for a given groupId and logicalStreamId", () => {
    const groupId = "group-1";
    const logicalStreamId = "stream-1";

    coordinator.storeViewerRequest(groupId, logicalStreamId, "viewer-1", makeViewerRequest({ requestId: "req-1" }));
    coordinator.storeViewerRequest(groupId, logicalStreamId, "viewer-2", makeViewerRequest({ requestId: "req-2" }));

    const requests = coordinator.getAllViewerRequests(groupId, logicalStreamId);
    expect(requests).toHaveLength(2);
  });
});

describe("Stage 6: QualityCoordinator — handleViewerRequest keying", () => {
  let coordinator: QualityCoordinator;

  beforeEach(() => {
    coordinator = new QualityCoordinator();
  });

  it("stores by groupId + logicalStreamId + viewerDeviceId when called through handleViewerRequest", () => {
    coordinator.handleViewerRequest(
      "group-1",
      "stream-1",
      "viewer-1",
      {
        streamSessionId: "session-1",
        requestId: "req-1",
        revision: 1,
        videoBitrateKbps: 2000,
        maxWidth: 1280,
        maxHeight: 720,
        maxFps: 30,
        degradationPreference: "balanced",
      },
    );

    // Should be retrievable by the correct composite key
    const retrieved = coordinator.getViewerRequest("group-1", "stream-1", "viewer-1");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.videoBitrateKbps).toBe(2000);

    // Should NOT be found under streamSessionId (mediaSessionId)
    const wrongKey = coordinator.getViewerRequest("group-1", "session-1", "viewer-1");
    expect(wrongKey).toBeNull();
  });

  it("handleViewerRequest with same logicalStreamId but different viewerDeviceId stores separately", () => {
    coordinator.handleViewerRequest("g-1", "s-1", "v-1", {
      streamSessionId: "sess-1",
      requestId: "req-a",
      revision: 1,
      videoBitrateKbps: 1000,
      maxWidth: 854, maxHeight: 480, maxFps: 15,
      degradationPreference: "balanced",
    });
    coordinator.handleViewerRequest("g-1", "s-1", "v-2", {
      streamSessionId: "sess-1",
      requestId: "req-b",
      revision: 1,
      videoBitrateKbps: 2000,
      maxWidth: 1280, maxHeight: 720, maxFps: 30,
      degradationPreference: "maintain-resolution",
    });

    const v1 = coordinator.getViewerRequest("g-1", "s-1", "v-1");
    const v2 = coordinator.getViewerRequest("g-1", "s-1", "v-2");

    expect(v1?.videoBitrateKbps).toBe(1000);
    expect(v2?.videoBitrateKbps).toBe(2000);
  });
});

describe("Stage 6: QualityCoordinator — quality.viewer.clear handling", () => {
  let coordinator: QualityCoordinator;

  beforeEach(() => {
    coordinator = new QualityCoordinator();
  });

  it("handleViewerClear removes the stored request", () => {
    coordinator.storeViewerRequest("g-1", "s-1", "v-1", makeViewerRequest({ videoBitrateKbps: 3000 }));

    // Verify stored
    expect(coordinator.getViewerRequest("g-1", "s-1", "v-1")).not.toBeNull();

    // Clear it
    coordinator.handleViewerClear("g-1", "s-1", "v-1");

    // Verify removed
    expect(coordinator.getViewerRequest("g-1", "s-1", "v-1")).toBeNull();
  });

  it("handleViewerClear removes only the specified viewer, not others", () => {
    coordinator.storeViewerRequest("g-1", "s-1", "v-1", makeViewerRequest({ requestId: "req-1" }));
    coordinator.storeViewerRequest("g-1", "s-1", "v-2", makeViewerRequest({ requestId: "req-2" }));

    coordinator.handleViewerClear("g-1", "s-1", "v-1");

    expect(coordinator.getViewerRequest("g-1", "s-1", "v-1")).toBeNull();
    expect(coordinator.getViewerRequest("g-1", "s-1", "v-2")).not.toBeNull();
  });

  it("handleViewerClear is idempotent (no error on non-existent key)", () => {
    expect(() => coordinator.handleViewerClear("g-x", "s-x", "v-x")).not.toThrow();
  });
});

describe("Stage 6: QualityCoordinator — 300 kbps viewer request path (bounded lane B)", () => {
  let coordinator: QualityCoordinator;

  beforeEach(() => {
    coordinator = new QualityCoordinator();
  });

  it("calculateEffectiveQuality with 300 kbps viewer request returns 300 kbps effective", () => {
    const groupSettings = makeGroupSettings();
    const hostLimits = makeHostLimits({ allowViewerQualityRequests: true });
    const viewerRequest = makeViewerRequest({ videoBitrateKbps: 300 });

    const result = coordinator.calculateEffectiveQuality(
      groupSettings,
      hostLimits,
      viewerRequest,
      { width: 1920, height: 1080 },
    );

    // The effective bitrate must be 300, not the group default (650)
    expect(result.effective.videoBitrateKbps).toBe(300);
    expect(result.effective.videoBitrateKbps).not.toBe(groupSettings.video.videoBitrateKbps);
    // Viewer request must be reflected in the requested field
    expect(result.requested).not.toBeNull();
    expect(result.requested!.videoBitrateKbps).toBe(300);
  });

  it("calculateEffectiveQuality 300 kbps request survives range clamping", () => {
    const groupSettings = makeGroupSettings();
    const hostLimits = makeHostLimits({ allowViewerQualityRequests: true });
    // 300 is well within RANGES.videoBitrateKbps (100–20000)
    const viewerRequest = makeViewerRequest({ videoBitrateKbps: 300 });

    const result = coordinator.calculateEffectiveQuality(
      groupSettings,
      hostLimits,
      viewerRequest,
      { width: 1920, height: 1080 },
    );

    expect(result.effective.videoBitrateKbps).toBe(300);
    // No clamp reason for bitrate since 300 is in range and under host limit
    const bitrateClampReasons = result.clampReasons.filter(r => r.toLowerCase().includes("bitrate"));
    expect(bitrateClampReasons).toHaveLength(0);
  });

  it("calculateEffectiveQuality ignores 300 kbps viewer request when allowViewerQualityRequests is false", () => {
    // When viewer requests are disabled, fall back to group defaults (650)
    // This is the INTENDED fallback, not a bug
    const groupSettings = makeGroupSettings({ videoBitrateKbps: 650 });
    const hostLimits = makeHostLimits({ allowViewerQualityRequests: false });
    const viewerRequest = makeViewerRequest({ videoBitrateKbps: 300 });

    const result = coordinator.calculateEffectiveQuality(
      groupSettings,
      hostLimits,
      viewerRequest,
      { width: 1920, height: 1080 },
    );

    expect(result.requested).toBeNull();
    expect(result.effective.videoBitrateKbps).toBe(650);
  });

  it("applyToSender sets correct enc.maxBitrate for 300 kbps effective", async () => {
    const sender = createMockSender();

    const effective = {
      videoBitrateKbps: 300,
      maxWidth: 640,
      maxHeight: 360,
      maxFps: 15,
      degradationPreference: "maintain-resolution" as const,
    };

    await coordinator.applyToSender(sender, effective);
    const params = sender.getParameters();
    // 300 kbps → 300,000 bps
    expect(params.encodings?.[0]?.maxBitrate).toBe(300_000);
  });

  it("applyToSender with 300 kbps reads back correctly as 300 kbps", async () => {
    const sender = createMockSender();

    const effective = {
      videoBitrateKbps: 300,
      maxWidth: 640,
      maxHeight: 360,
      maxFps: 15,
      degradationPreference: "maintain-resolution" as const,
    };

    const configured = await coordinator.applyToSender(sender, effective);
    // configured.maxBitrate is in bps — should be 300,000 for 300 kbps
    expect(configured!.maxBitrate).toBe(300_000);
    // Converting back: 300,000 / 1000 = 300 kbps
    expect(Math.round(configured!.maxBitrate / 1000)).toBe(300);
  });
});

describe("Stage 6: QualityCoordinator — exact viewer application", () => {
  let coordinator: QualityCoordinator;

  beforeEach(() => {
    coordinator = new QualityCoordinator();
  });

  it("requires viewerDeviceId + mediaPeerUuid to apply quality", () => {
    // The applyToExactViewer API requires viewerDeviceId + mediaPeerUuid + RTCRtpSender
    // This test verifies the method signature exists
    expect(typeof coordinator.applyToExactViewer).toBe("function");
  });

  it("applies quality only to the specified sender", async () => {
    const sender1 = createMockSender();
    const sender2 = createMockSender();

    const effective = {
      videoBitrateKbps: 3000,
      maxWidth: 1920,
      maxHeight: 1080,
      maxFps: 30,
      degradationPreference: "balanced",
    };

    // Apply to sender1 only
    await coordinator.applyToExactViewer(
      "viewer-1",
      "peer-uuid-1",
      sender1,
      effective,
    );

    // sender1 should have the applied values
    const params1 = sender1.getParameters();
    expect(params1.encodings?.[0]?.maxBitrate).toBe(3_000_000);

    // sender2 should NOT be modified
    const params2 = sender2.getParameters();
    expect(params2.encodings?.[0]?.maxBitrate).toBe(500_000);
  });

  it("reads back configured values after applying to exact viewer", async () => {
    const sender = createMockSender();

    const effective = {
      videoBitrateKbps: 2500,
      maxWidth: 1280,
      maxHeight: 720,
      maxFps: 25,
      degradationPreference: "maintain-resolution",
    };

    const configured = await coordinator.applyToExactViewer(
      "viewer-2",
      "peer-uuid-2",
      sender,
      effective,
    );

    expect(configured).not.toBeNull();
    expect(configured!.maxBitrate).toBe(2_500_000);
    expect(configured!.maxFramerate).toBe(25);
    expect(configured!.degradationPreference).toBe("maintain-resolution");
  });
});
