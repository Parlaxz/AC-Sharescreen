import { describe, it, expect } from "vitest";
import {
  StreamViewerReadyPayloadSchema,
  parseGroupMessagePayload,
  GROUP_CONTROL_MESSAGE_TYPES,
} from "../src/group-control-messages.js";

describe("StreamViewerReadyPayloadSchema", () => {
  const validPayload = {
    groupId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    logicalStreamId: "stream-1",
    mediaSessionId: "session-1",
    viewerSessionId: "vsid-abc123",
    viewerNodeId: "node-1",
    viewerDeviceId: "dev-2",
    readyAt: 1000,
    presentation: "native-video" as const,
  };

  it("accepts valid native-video ready payload", () => {
    const r = StreamViewerReadyPayloadSchema.safeParse(validPayload);
    expect(r.success).toBe(true);
  });

  it("accepts webgl presentation", () => {
    const r = StreamViewerReadyPayloadSchema.safeParse({
      ...validPayload,
      presentation: "webgl",
    });
    expect(r.success).toBe(true);
  });

  it("accepts nvidia presentation", () => {
    const r = StreamViewerReadyPayloadSchema.safeParse({
      ...validPayload,
      presentation: "nvidia",
    });
    expect(r.success).toBe(true);
  });

  it("accepts fallback presentation", () => {
    const r = StreamViewerReadyPayloadSchema.safeParse({
      ...validPayload,
      presentation: "fallback",
    });
    expect(r.success).toBe(true);
  });

  it("rejects invalid presentation value", () => {
    const r = StreamViewerReadyPayloadSchema.safeParse({
      ...validPayload,
      presentation: "invalid",
    });
    expect(r.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const r = StreamViewerReadyPayloadSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it("rejects missing groupId", () => {
    const r = StreamViewerReadyPayloadSchema.safeParse({
      ...validPayload,
      groupId: undefined,
    });
    expect(r.success).toBe(false);
  });

  it("rejects missing viewerSessionId", () => {
    const r = StreamViewerReadyPayloadSchema.safeParse({
      ...validPayload,
      viewerSessionId: undefined,
    });
    expect(r.success).toBe(false);
  });
});

describe("parseGroupMessagePayload for stream.viewer.ready", () => {
  it("parses stream.viewer.ready successfully", () => {
    const r = parseGroupMessagePayload("stream.viewer.ready", {
      groupId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      logicalStreamId: "stream-1",
      mediaSessionId: "session-1",
      viewerSessionId: "vsid-abc123",
      viewerNodeId: "node-1",
      viewerDeviceId: "dev-2",
      readyAt: 1000,
      presentation: "native-video",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.groupId).toBe("aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa");
      expect(r.data.presentation).toBe("native-video");
    }
  });

  it("returns ok:false for unknown type", () => {
    const r = parseGroupMessagePayload("unknown.type" as any, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("Unknown");
  });
});

describe("stream.viewer.ready is in GROUP_CONTROL_MESSAGE_TYPES", () => {
  it("includes stream.viewer.ready in the message types list", () => {
    expect(GROUP_CONTROL_MESSAGE_TYPES.includes("stream.viewer.ready" as any)).toBe(true);
  });

  it("stream.viewer.ready is a valid GroupControlMessageType", () => {
    // This just checks the type system at runtime — the const assertion
    // means the array values are literal types.
    const types: readonly string[] = GROUP_CONTROL_MESSAGE_TYPES;
    expect(types).toContain("stream.viewer.ready");
  });
});
