// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GroupSettingsLiveApply } from "../src/renderer/services/group-settings-live-apply.js";
import { createDefaultGroupQualitySettings, type GroupQualitySettings } from "@screenlink/shared";
import * as qualityCoordinator from "../src/renderer/services/quality-coordinator.js";

function makeSettings(overrides: Partial<GroupQualitySettings["video"]> = {}): GroupQualitySettings {
  const s = createDefaultGroupQualitySettings();
  s.video = { ...s.video, ...overrides };
  return s;
}

describe("GroupSettingsLiveApply (Gate 9.5 / 9.6)", () => {
  it("delegates sender parameter application to shared applySenderSettings from quality-coordinator", async () => {
    const spy = vi.spyOn(qualityCoordinator, "applySenderSettings");
    const setParameters = vi.fn().mockResolvedValue(undefined);
    const getParameters = vi.fn().mockReturnValue({ encodings: [{}] });
    const sender = { setParameters, getParameters } as unknown as RTCRtpSender;
    const runtime = {
      getViewerMediaBinding: () => ({
        getAllViewers: () => [
          {
            groupId: "g-1",
            logicalStreamId: "ls-1",
            viewerDeviceId: "viewer-1",
            videoSender: sender,
          },
        ],
      }),
    };
    const live = new GroupSettingsLiveApply(runtime as never);
    const before = makeSettings({ videoBitrateKbps: 1000, sendFps: 30, degradationPreference: "balanced" });
    const after = makeSettings({ videoBitrateKbps: 2000, sendFps: 60, degradationPreference: "maintain-resolution" });
    await live.applyChange({ groupId: "g-1", before, after });
    expect(spy).toHaveBeenCalledWith(sender, {
      maxBitrate: 2000,
      maxFramerate: 60,
      degradationPreference: "maintain-resolution",
      scaleResolutionDownBy: 1,
    });
    spy.mockRestore();
  });

  it("classifies bitrate change as live-safe and applies to the sender", async () => {
    const setParameters = vi.fn().mockResolvedValue(undefined);
    const getParameters = vi.fn().mockReturnValue({ encodings: [{}] });
    const sender = { setParameters, getParameters } as unknown as RTCRtpSender;
    const runtime = {
      getViewerMediaBinding: () => ({
        getAllViewers: () => [
          {
            groupId: "g-1",
            logicalStreamId: "ls-1",
            viewerDeviceId: "viewer-1",
            videoSender: sender,
          },
        ],
      }),
    };
    const live = new GroupSettingsLiveApply(runtime as never);
    const before = makeSettings({ videoBitrateKbps: 1000 });
    const after = makeSettings({ videoBitrateKbps: 2000 });
    const r = await live.applyChange({ groupId: "g-1", before, after });
    expect(r.liveSafe).toContain("video.videoBitrateKbps");
    expect(r.restartRequired).toEqual([]);
    expect(r.appliedToViewers).toEqual(["viewer-1"]);
    expect(setParameters).toHaveBeenCalled();
  });

  it("classifies codec change as restart-required and does not apply live", async () => {
    const setParameters = vi.fn();
    const getParameters = vi.fn().mockReturnValue({ encodings: [{}] });
    const sender = { setParameters, getParameters } as unknown as RTCRtpSender;
    const runtime = {
      getViewerMediaBinding: () => ({
        getAllViewers: () => [
          { groupId: "g-1", logicalStreamId: "ls-1", viewerDeviceId: "viewer-1", videoSender: sender },
        ],
      }),
    };
    const live = new GroupSettingsLiveApply(runtime as never);
    const before = makeSettings({ codec: "auto" });
    const after = makeSettings({ codec: "h264" });
    const r = await live.applyChange({ groupId: "g-1", before, after });
    expect(r.restartRequired).toContain("video.codec");
    expect(r.liveSafe).toEqual([]);
    expect(r.restartSuggested).toBe(true);
    expect(setParameters).not.toHaveBeenCalled();
  });

  it("classifies capture dimensions as restart-required", async () => {
    const setParameters = vi.fn();
    const getParameters = vi.fn().mockReturnValue({ encodings: [{}] });
    const sender = { setParameters, getParameters } as unknown as RTCRtpSender;
    const runtime = {
      getViewerMediaBinding: () => ({
        getAllViewers: () => [
          { groupId: "g-1", logicalStreamId: "ls-1", viewerDeviceId: "viewer-1", videoSender: sender },
        ],
      }),
    };
    const live = new GroupSettingsLiveApply(runtime as never);
    const before = makeSettings({ captureWidth: 1920 });
    const after = makeSettings({ captureWidth: 1280 });
    const r = await live.applyChange({ groupId: "g-1", before, after });
    expect(r.restartRequired).toContain("video.captureWidth");
    expect(r.liveSafe).toEqual([]);
  });

  it("only applies to viewers in the matching group", async () => {
    const setParameters = vi.fn().mockResolvedValue(undefined);
    const getParameters = vi.fn().mockReturnValue({ encodings: [{}] });
    const sender1 = { setParameters, getParameters } as unknown as RTCRtpSender;
    const sender2 = { setParameters: vi.fn(), getParameters } as unknown as RTCRtpSender;
    const runtime = {
      getViewerMediaBinding: () => ({
        getAllViewers: () => [
          { groupId: "g-1", logicalStreamId: "ls-1", viewerDeviceId: "viewer-1", videoSender: sender1 },
          { groupId: "g-2", logicalStreamId: "ls-1", viewerDeviceId: "viewer-2", videoSender: sender2 },
        ],
      }),
    };
    const live = new GroupSettingsLiveApply(runtime as never);
    const before = makeSettings({ videoBitrateKbps: 1000 });
    const after = makeSettings({ videoBitrateKbps: 2000 });
    const r = await live.applyChange({ groupId: "g-1", before, after });
    expect(r.appliedToViewers).toEqual(["viewer-1"]);
    expect((sender2.setParameters as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("audio.* fields are always restart-required", async () => {
    const setParameters = vi.fn();
    const getParameters = vi.fn().mockReturnValue({ encodings: [{}] });
    const sender = { setParameters, getParameters } as unknown as RTCRtpSender;
    const runtime = {
      getViewerMediaBinding: () => ({
        getAllViewers: () => [
          { groupId: "g-1", logicalStreamId: "ls-1", viewerDeviceId: "viewer-1", videoSender: sender },
        ],
      }),
    };
    const live = new GroupSettingsLiveApply(runtime as never);
    const before = makeSettings();
    const after = makeSettings();
    // Default audio channels is "stereo"; flip to "mono" to force a diff.
    after.audio = { ...after.audio, channels: "mono" };
    const r = await live.applyChange({ groupId: "g-1", before, after });
    expect(r.restartRequired.some((p) => p.startsWith("audio."))).toBe(true);
    expect(setParameters).not.toHaveBeenCalled();
  });
});
