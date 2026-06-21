import { describe, it, expect, vi } from "vitest";
import { applyQualityToSender, readSenderParameters } from "../src/sender-parameters.js";

function createMockSender(overrides: Partial<RTCRtpSender> = {}): RTCRtpSender {
  let storedParams: RTCRtpSendParameters = {
    encodings: [{ active: true, maxBitrate: 500000 }],
    transactionId: "test",
    codecs: [],
    headerExtensions: [],
    rtcp: {},
    degradationPreference: "balanced",
  };

  return {
    getParameters: vi.fn(() => storedParams),
    setParameters: vi.fn(async (params: RTCRtpSendParameters) => {
      storedParams = params;
    }),
    track: {
      kind: "video",
      getSettings: () => ({ width: 1920, height: 1080 }),
    } as MediaStreamTrack,
    ...overrides,
  } as unknown as RTCRtpSender;
}

describe("applyQualityToSender", () => {
  it("returns error when no encodings exist", async () => {
    const sender = createMockSender();
    vi.mocked(sender.getParameters).mockReturnValueOnce({
      encodings: [],
      transactionId: "",
      codecs: [],
      headerExtensions: [],
      rtcp: {},
    });

    const result = await applyQualityToSender(sender, {
      videoCeilingKbps: 1000,
      maxFps: 30,
      targetWidth: 1280,
      targetHeight: 720,
      degradationPreference: "balanced",
    });

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toBe("ENCODING_PARAMETERS_UNAVAILABLE");
  });

  it("applies quality and awaits setParameters", async () => {
    const sender = createMockSender();
    const target = {
      videoCeilingKbps: 2000,
      maxFps: 30,
      targetWidth: 1280,
      targetHeight: 720,
      degradationPreference: "balanced",
    };

    const result = await applyQualityToSender(sender, target);

    expect(sender.setParameters).toHaveBeenCalledTimes(1);
    const params = vi.mocked(sender.setParameters).mock.calls[0][0];
    expect(params.encodings[0]!.maxBitrate).toBe(2_000_000);
    expect(params.encodings[0]!.maxFramerate).toBe(30);
  });

  it("reads back parameters after setting them", async () => {
    const sender = createMockSender();
    const target = {
      videoCeilingKbps: 1500,
      maxFps: 24,
      targetWidth: 854,
      targetHeight: 480,
      degradationPreference: "maintain-resolution",
    };

    const result = await applyQualityToSender(sender, target);

    expect(sender.getParameters).toHaveBeenCalledTimes(2);
    const resultTyped = result as { scale: number; success: boolean; configuredBitrate?: number };
    expect(resultTyped.success).toBe(true);
    expect(resultTyped.configuredBitrate).toBe(1_500_000);
  });

  it("returns error when setParameters fails", async () => {
    const sender = createMockSender();
    vi.mocked(sender.setParameters).mockRejectedValueOnce(new Error("Invalid state"));

    const result = await applyQualityToSender(sender, {
      videoCeilingKbps: 1000,
      maxFps: 30,
      targetWidth: 1280,
      targetHeight: 720,
      degradationPreference: "balanced",
    });

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("setParameters failed");
  });
});
