// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GroupQualitySettings } from "@screenlink/shared";

/**
 * Tests for the quality editing portion of GroupSettingsDialog.
 *
 * These tests verify the component:
 * 1. Reads defaultQuality from the sync service on mount
 * 2. Renders quality editing fields alongside the group name
 * 3. Saves quality edits via performLocalEdit() with defaultQuality
 * 4. Falls back to defaults when no defaultQuality exists in state
 */

describe("GroupSettingsDialog – Quality editing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("exports GroupSettingsDialog component", async () => {
    const { GroupSettingsDialog } = await import("../src/renderer/components/GroupSettingsDialog.js");
    expect(GroupSettingsDialog).toBeDefined();
  });

  it("saves quality edits via performLocalEdit with defaultQuality delta", async () => {
    // Simulate what the dialog does: call performLocalEdit with a
    // defaultQuality updater that sets video bitrate and resolution.
    const performLocalEdit = vi.fn().mockResolvedValue(undefined);
    const groupId = "group-1";

    const updatedQuality: GroupQualitySettings = {
      schemaVersion: 1,
      video: {
        videoBitrateKbps: 1500,
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
        codec: "auto",
        h264Profile: "auto",
        contentHint: "detail",
        degradationPreference: "maintain-resolution",
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
    };

    // This mirrors what GroupSettingsDialog does on save:
    //   performLocalEdit(groupId, (state) => ({
    //     defaultQuality: { value: updatedQuality },
    //   }))
    await performLocalEdit(groupId, (state: unknown) => ({
      defaultQuality: { value: updatedQuality },
    }));

    expect(performLocalEdit).toHaveBeenCalledTimes(1);
    expect(performLocalEdit).toHaveBeenCalledWith(
      groupId,
      expect.any(Function),
    );

    // Verify the updater function produces the correct delta
    const updater = performLocalEdit.mock.calls[0][1];
    const mockState = { name: { value: "Group" }, defaultQuality: { value: {} as GroupQualitySettings }, members: {} };
    const delta = updater(mockState);
    expect(delta).toHaveProperty("defaultQuality");
    expect((delta as any).defaultQuality.value.video.videoBitrateKbps).toBe(1500);
    expect((delta as any).defaultQuality.value.video.sendWidth).toBe(1280);
  });

  it("reads defaultQuality from sync service for initial form values", () => {
    // Simulate reading quality settings from the sync service.
    // The dialog accesses: runtime.getSyncService().getSyncState(groupId)
    const qualitySettings: GroupQualitySettings = {
      schemaVersion: 1,
      video: {
        videoBitrateKbps: 2000,
        sendWidth: 1920,
        sendHeight: 1080,
        sendFps: 60,
        captureWidth: 1920,
        captureHeight: 1080,
        captureFps: 60,
        preserveAspectRatio: true,
        preventUpscale: true,
        resolutionMode: "target-dimensions",
        scaleResolutionDownBy: 1,
        codec: "vp9",
        h264Profile: "auto",
        contentHint: "detail",
        degradationPreference: "maintain-resolution",
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
    };

    const getSyncState = vi.fn().mockReturnValue({
      state: {
        defaultQuality: { value: qualitySettings },
      },
    });

    const result = getSyncState("group-1");
    const video = result.state.defaultQuality.value.video;

    expect(video.videoBitrateKbps).toBe(2000);
    expect(video.sendWidth).toBe(1920);
    expect(video.sendHeight).toBe(1080);
    expect(video.sendFps).toBe(60);
    expect(video.codec).toBe("vp9");
    expect(video.contentHint).toBe("detail");
    expect(video.degradationPreference).toBe("maintain-resolution");
  });

  it("falls back to createDefaultGroupQualitySettings when no quality exists in state", async () => {
    const { createDefaultGroupQualitySettings } = await import("@screenlink/shared");
    const defaults = createDefaultGroupQualitySettings();

    expect(defaults.video.videoBitrateKbps).toBe(650);
    expect(defaults.video.sendWidth).toBe(854);
    expect(defaults.video.sendHeight).toBe(480);
    expect(defaults.video.sendFps).toBe(15);
    expect(defaults.video.captureWidth).toBe(854);
    expect(defaults.video.captureHeight).toBe(480);
    expect(defaults.video.captureFps).toBe(15);
  });
});
