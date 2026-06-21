import { describe, it, expect } from "vitest";
import {
  ProvisionShareRequestSchema,
  CaptureInfoSchema,
  PolicySchema,
  SessionResponseSchema,
  ShareIdSchema,
} from "@screenlink/shared";

describe("ProvisionShareRequestSchema", () => {
  it("accepts a valid provision share request", () => {
    const result = ProvisionShareRequestSchema.safeParse({
      shareId: "abc123_def456",
      hostToken: "abc123_def456_ghi789",
      viewerToken: "xyz789_uvw456_rst123",
      displayName: "My Display",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid share ID", () => {
    const result = ProvisionShareRequestSchema.safeParse({
      shareId: "short", // too short (< 10 chars)
      hostToken: "abc123_def456_ghi789",
      viewerToken: "xyz789_uvw456_rst123",
      displayName: "My Display",
    });
    expect(result.success).toBe(false);
  });

  it("rejects share ID with invalid characters", () => {
    const result = ProvisionShareRequestSchema.safeParse({
      shareId: "abc!@#def123456",
      hostToken: "abc123_def456_ghi789",
      viewerToken: "xyz789_uvw456_rst123",
      displayName: "My Display",
    });
    expect(result.success).toBe(false);
  });
});

describe("CaptureInfoSchema", () => {
  it("accepts valid capture info", () => {
    const result = CaptureInfoSchema.safeParse({
      width: 1920,
      height: 1080,
      fps: 30,
      systemAudio: true,
      contentHint: "motion",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid capture info (negative width)", () => {
    const result = CaptureInfoSchema.safeParse({
      width: -1,
      height: 1080,
      fps: 30,
      systemAudio: false,
      contentHint: "detail",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid capture info (bad contentHint)", () => {
    const result = CaptureInfoSchema.safeParse({
      width: 1920,
      height: 1080,
      fps: 30,
      systemAudio: false,
      contentHint: "unknown",
    });
    expect(result.success).toBe(false);
  });

  it("rejects with missing fields", () => {
    const result = CaptureInfoSchema.safeParse({
      width: 1920,
    });
    expect(result.success).toBe(false);
  });
});

describe("PolicySchema", () => {
  it("accepts a valid policy", () => {
    const result = PolicySchema.safeParse({
      allowViewerGlobalChanges: true,
      allowViewerSystemAudioChanges: false,
      maxVideoCeilingPerViewerKbps: 2500,
      maxConfiguredMediaBudgetKbps: 5000,
      maxCaptureWidth: 1920,
      maxCaptureHeight: 1080,
      maxCaptureFps: 30,
      allowedCodecs: ["h264", "vp9"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid policy with negative values", () => {
    const result = PolicySchema.safeParse({
      allowViewerGlobalChanges: true,
      allowViewerSystemAudioChanges: false,
      maxVideoCeilingPerViewerKbps: -100,
      maxConfiguredMediaBudgetKbps: 5000,
      maxCaptureWidth: 1920,
      maxCaptureHeight: 1080,
      maxCaptureFps: 30,
      allowedCodecs: ["h264"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid policy with unsupported codec", () => {
    const result = PolicySchema.safeParse({
      allowViewerGlobalChanges: true,
      allowViewerSystemAudioChanges: false,
      maxVideoCeilingPerViewerKbps: 2500,
      maxConfiguredMediaBudgetKbps: 5000,
      maxCaptureWidth: 1920,
      maxCaptureHeight: 1080,
      maxCaptureFps: 30,
      allowedCodecs: ["h264", "hevc"],
    });
    expect(result.success).toBe(false);
  });
});

describe("SessionResponseSchema", () => {
  it("validates an online session response", () => {
    const result = SessionResponseSchema.safeParse({
      version: 1,
      requestId: "550e8400-e29b-41d4-a716-446655440000",
      status: "online",
      serverTime: Date.now(),
      session: {
        generation: 1,
        sessionId: "550e8400-e29b-41d4-a716-446655440001",
        streamId: "stream_abc",
        password: "p@ssw0rd!",
        startedAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        hostName: "Test Host",
        capture: {
          width: 1920,
          height: 1080,
          fps: 30,
          systemAudio: true,
          contentHint: "detail",
        },
        policy: {
          allowViewerGlobalChanges: true,
          allowViewerSystemAudioChanges: false,
          maxVideoCeilingPerViewerKbps: 2500,
          maxConfiguredMediaBudgetKbps: 5000,
          maxCaptureWidth: 1920,
          maxCaptureHeight: 1080,
          maxCaptureFps: 30,
          allowedCodecs: ["h264"],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("validates an offline session response (no session object)", () => {
    const result = SessionResponseSchema.safeParse({
      version: 1,
      requestId: "550e8400-e29b-41d4-a716-446655440000",
      status: "offline",
      serverTime: Date.now(),
      retryAfterMs: 5000,
    });
    expect(result.success).toBe(true);
  });
});
