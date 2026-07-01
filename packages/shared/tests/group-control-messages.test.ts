import { describe, it, expect } from "vitest";
import {
  validateEnvelope,
  signEnvelope,
  verifyEnvelope,
  buildEnvelope,
  DedupSet,
  GROUP_PROTOCOL_VERSION,
  GroupControlEnvelopeSchema,
  type GroupControlEnvelopeInput,
} from "@screenlink/shared";

const GROUP_SECRET = "test-group-secret-abcdef123456";
const GROUP_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const SENDER_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

async function makeSigned(
  overrides?: Partial<GroupControlEnvelopeInput>,
): Promise<GroupControlEnvelopeInput & { mac: string }> {
  const input: GroupControlEnvelopeInput = {
    version: GROUP_PROTOCOL_VERSION,
    type: "group.hello",
    messageId: crypto.randomUUID(),
    sentAt: Date.now(),
    senderDeviceId: SENDER_ID,
    groupId: GROUP_ID,
    logicalStamp: { wallTimeMs: Date.now(), counter: 0, nodeId: SENDER_ID },
    payload: { displayName: "Alice" },
    ...overrides,
  } as GroupControlEnvelopeInput;
  return await buildEnvelope(input, GROUP_SECRET);
}

describe("GroupControlMessages (HMAC-only)", () => {
  it("buildEnvelope creates a valid envelope with MAC", async () => {
    const envelope = await makeSigned();
    expect(envelope.version).toBe(GROUP_PROTOCOL_VERSION);
    expect(envelope.type).toBe("group.hello");
    expect(envelope.mac).toMatch(/^[0-9a-f]+$/);
    expect(envelope.mac.length).toBe(64);
    expect(GroupControlEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it("signEnvelope produces a consistent signature for the same input", async () => {
    const input: GroupControlEnvelopeInput = {
      version: GROUP_PROTOCOL_VERSION,
      type: "group.hello",
      messageId: "11111111-1111-4111-1111-111111111111",
      sentAt: 1000,
      senderDeviceId: SENDER_ID,
      groupId: GROUP_ID,
      logicalStamp: { wallTimeMs: 1000, counter: 0, nodeId: SENDER_ID },
      payload: { displayName: "Alice" },
    } as GroupControlEnvelopeInput;
    const sig1 = await signEnvelope(input, GROUP_SECRET);
    const sig2 = await signEnvelope(input, GROUP_SECRET);
    expect(sig1).toBe(sig2);
  });

  it("verifyEnvelope returns true for a valid envelope", async () => {
    const envelope = await makeSigned();
    const valid = await verifyEnvelope(envelope, GROUP_SECRET);
    expect(valid).toBe(true);
  });

  it("verifyEnvelope returns false for tampered payload", async () => {
    const envelope = await makeSigned();
    envelope.payload = { evil: "data" };
    const valid = await verifyEnvelope(envelope, GROUP_SECRET);
    expect(valid).toBe(false);
  });

  it("verifyEnvelope returns false for tampered MAC", async () => {
    const envelope = await makeSigned();
    envelope.mac = "0".repeat(64);
    const valid = await verifyEnvelope(envelope, GROUP_SECRET);
    expect(valid).toBe(false);
  });

  it("validateEnvelope rejects wrong group ID", async () => {
    const envelope = await makeSigned();
    const wrongGroupId = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
    const dedup = new DedupSet();
    const result = await validateEnvelope(envelope, wrongGroupId, GROUP_SECRET, dedup);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Wrong group");
    }
  });

  it("validateEnvelope rejects invalid schema", async () => {
    const dedup = new DedupSet();
    const result = await validateEnvelope(
      { malformed: true },
      GROUP_ID,
      GROUP_SECRET,
      dedup,
    );
    expect(result.ok).toBe(false);
  });

  it("DedupSet prevents duplicate message IDs", async () => {
    const envelope = await makeSigned();
    const dedup = new DedupSet(60000);
    const r1 = await validateEnvelope(envelope, GROUP_ID, GROUP_SECRET, dedup);
    expect(r1.ok).toBe(true);
    const r2 = await validateEnvelope(envelope, GROUP_ID, GROUP_SECRET, dedup);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.reason).toContain("Duplicate");
    }
  });

  it("DedupSet evicts old entries", async () => {
    const dedup = new DedupSet(0);
    dedup.add("test-id");
    await new Promise((r) => setTimeout(r, 10));
    expect(dedup.has("test-id")).toBe(false);
  });

  it("validateEnvelope rejects unsupported version", async () => {
    const envelope = await makeSigned({ version: 99 });
    const dedup = new DedupSet();
    const result = await validateEnvelope(envelope, GROUP_ID, GROUP_SECRET, dedup);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/version|Unsupported/);
    }
  });

  it("validateEnvelope rejects oversized payload", async () => {
    // Create a payload larger than the 64 KB cap
    const big = "x".repeat(70 * 1024);
    const envelope = await makeSigned({ payload: { big } });
    const dedup = new DedupSet();
    const result = await validateEnvelope(envelope, GROUP_ID, GROUP_SECRET, dedup);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/Payload|size|exceeds/i);
    }
  });
});

// ─── Compile-only contract: buildEnvelope requires the group secret ────────

describe("buildEnvelope contract (HMAC-only)", () => {
  it("requires a group secret argument", () => {
    const input: GroupControlEnvelopeInput = {
      version: GROUP_PROTOCOL_VERSION,
      type: "group.hello",
      messageId: crypto.randomUUID(),
      sentAt: 1,
      senderDeviceId: "x",
      groupId: GROUP_ID,
      logicalStamp: { wallTimeMs: 1, counter: 0, nodeId: "x" },
      payload: {},
    } as GroupControlEnvelopeInput;
    // @ts-expect-error — buildEnvelope must take a group secret; single arg is invalid.
    void buildEnvelope(input);
    // @ts-expect-error — third "device private key" argument is no longer part of the API.
    void buildEnvelope(input, "secret", {} as CryptoKey);
    // Correct call: must pass the group secret.
    void buildEnvelope(input, "secret");
  });
});

// ─── Compare Extension Tests ──────────────────────────────────────────────

import {
  GROUP_CONTROL_MESSAGE_TYPES,
  StreamStartedPayloadSchema,
  StreamJoinRequestPayloadSchema,
  StreamJoinResponsePayloadSchema,
  StreamLeavePayloadSchema,
  StreamBindAckPayloadSchema,
  ViewerStatusPayloadSchema,
  ViewerPausedPayloadSchema,
  ViewerPauseRequestPayloadSchema,
  ViewerPauseResultPayloadSchema,
  parseGroupMessagePayload,
} from "@screenlink/shared";

// compare.variant.updated tests removed — all compare is now viewer-only,
// no protocol messages needed.

describe("Backward compatibility — old payloads still parse", () => {
  it("stream.started without compare metadata", () => {
    const oldPayload = {
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      groupId: "group-1",
      hostDeviceId: "dev-1",
      hostDisplayName: "Alice",
      sourceKind: "screen",
      sourceName: "Display 1",
      startedAt: 1000,
      appliedSettingsRevision: 1,
      heartbeatSequence: 1,
      streamRevision: 1,
      mediaJoinMetadata: "meta",
      replacesSessionId: null,
    };
    const result = StreamStartedPayloadSchema.safeParse(oldPayload);
    expect(result.success).toBe(true);
  });

  it("stream.join.request without compare fields", () => {
    const oldPayload = {
      logicalStreamId: "ls-1",
      viewerDeviceId: "dev-2",
      viewerDisplayName: "Bob",
    };
    const result = StreamJoinRequestPayloadSchema.safeParse(oldPayload);
    expect(result.success).toBe(true);
  });

  it("stream.join.response without compare fields", () => {
    const oldPayload = {
      logicalStreamId: "ls-1",
      accepted: true,
      viewerDeviceId: "dev-2",
      mediaJoinMetadata: "meta",
      mediaSessionId: "ms-1",
      streamId: "s-1",
      password: "p-1",
    };
    const result = StreamJoinResponsePayloadSchema.safeParse(oldPayload);
    expect(result.success).toBe(true);
  });

  it("stream.leave without compare fields", () => {
    const oldPayload = {
      logicalStreamId: "ls-1",
      viewerDeviceId: "dev-2",
    };
    const result = StreamLeavePayloadSchema.safeParse(oldPayload);
    expect(result.success).toBe(true);
  });

  it("stream.bind.ack without compare fields", () => {
    const oldPayload = {
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      viewerDeviceId: "dev-2",
      accepted: true,
      boundMediaPeer: "peer-1",
    };
    const result = StreamBindAckPayloadSchema.safeParse(oldPayload);
    expect(result.success).toBe(true);
  });

  it("viewer.paused without compare fields", () => {
    const oldPayload = {
      logicalStreamId: "ls-1",
      viewerDeviceId: "dev-2",
      paused: true,
    };
    const result = ViewerPausedPayloadSchema.safeParse(oldPayload);
    expect(result.success).toBe(true);
  });

  it("viewer.status without compare fields", () => {
    const oldPayload = {
      viewerDeviceId: "dev-2",
      streamId: "s-1",
      state: "playing" as const,
      receivedBitrateKbps: null,
      receivedWidth: null,
      receivedHeight: null,
      displayedFps: null,
      sampledAt: 1000,
    };
    const result = ViewerStatusPayloadSchema.safeParse(oldPayload);
    expect(result.success).toBe(true);
  });
});

describe("Compare correlation fields", () => {
  it("stream.started accepts optional compare metadata", () => {
    const payload = {
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      groupId: "group-1",
      hostDeviceId: "dev-1",
      hostDisplayName: "Alice",
      sourceKind: "screen",
      sourceName: "Display 1",
      startedAt: 1000,
      appliedSettingsRevision: 1,
      heartbeatSequence: 1,
      streamRevision: 1,
      mediaJoinMetadata: "meta",
      replacesSessionId: null,
      compareMode: "side-by-side",
      compareVersion: 1,
      primaryVariant: "A",
      variantADescriptor: {
        mediaSessionId: "ms-a",
        configSnapshot: {
          resolutionWidth: 1920,
          resolutionHeight: 1080,
          fps: 30,
          videoBitrateKbps: 5000,
          sourceKind: "screen",
          sourceName: "Display 1",
        },
      },
      variantBDescriptor: {
        mediaSessionId: "ms-b",
        configSnapshot: {
          resolutionWidth: 1280,
          resolutionHeight: 720,
          fps: 30,
          videoBitrateKbps: 3000,
          sourceKind: "window",
          sourceName: "Browser",
        },
      },
      appliedConfigSnapshot: {
        resolutionWidth: 1920,
        resolutionHeight: 1080,
        fps: 30,
        videoBitrateKbps: 5000,
        sourceKind: "screen",
        sourceName: "Display 1",
      },
      appliedCompareRevision: 1,
    };
    const result = StreamStartedPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("stream.started accepts partial compare metadata", () => {
    const payload = {
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      groupId: "group-1",
      hostDeviceId: "dev-1",
      hostDisplayName: "Alice",
      sourceKind: "screen",
      sourceName: "Display 1",
      startedAt: 1000,
      appliedSettingsRevision: 1,
      heartbeatSequence: 1,
      streamRevision: 1,
      mediaJoinMetadata: "meta",
      replacesSessionId: null,
      compareMode: "single",
      compareVersion: 1,
      primaryVariant: "A",
    };
    const result = StreamStartedPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("stream.join.request accepts optional compareVariantId and mediaSessionId", () => {
    const payload = {
      logicalStreamId: "ls-1",
      viewerDeviceId: "dev-2",
      viewerDisplayName: "Bob",
      compareVariantId: "A",
      mediaSessionId: "ms-1",
    };
    const result = StreamJoinRequestPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("stream.join.response accepts optional compareVariantId", () => {
    const payload = {
      logicalStreamId: "ls-1",
      accepted: true,
      viewerDeviceId: "dev-2",
      mediaSessionId: "ms-1",
      streamId: "s-1",
      password: "p-1",
      compareVariantId: "B",
    };
    const result = StreamJoinResponsePayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("stream.leave accepts optional mediaSessionId and compareVariantId", () => {
    const payload = {
      logicalStreamId: "ls-1",
      viewerDeviceId: "dev-2",
      mediaSessionId: "ms-1",
      compareVariantId: "A",
    };
    const result = StreamLeavePayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("stream.bind.ack accepts optional compareVariantId", () => {
    const payload = {
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      viewerDeviceId: "dev-2",
      accepted: true,
      compareVariantId: "A",
    };
    const result = StreamBindAckPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  // viewer.paused and viewer.status compare correlation tests removed —
  // all compare is now viewer-only, no protocol compare fields needed.
});

// ─── Viewer Pause Request / Result Schemas ──────────────────────────────

describe("ViewerPauseRequestPayloadSchema", () => {
  it("accepts valid pause request", () => {
    const result = ViewerPauseRequestPayloadSchema.safeParse({
      groupId: "g-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      viewerSessionId: "vs-1",
      viewerDeviceId: "vd-1",
      operationId: "op-1",
      paused: true,
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid resume request", () => {
    const result = ViewerPauseRequestPayloadSchema.safeParse({
      groupId: "g-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      viewerSessionId: "vs-1",
      viewerDeviceId: "vd-1",
      operationId: "op-2",
      paused: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing groupId", () => {
    const result = ViewerPauseRequestPayloadSchema.safeParse({
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      viewerSessionId: "vs-1",
      viewerDeviceId: "vd-1",
      operationId: "op-1",
      paused: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing paused field", () => {
    const result = ViewerPauseRequestPayloadSchema.safeParse({
      groupId: "g-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      viewerSessionId: "vs-1",
      viewerDeviceId: "vd-1",
      operationId: "op-1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra unknown fields (strict mode)", () => {
    const result = ViewerPauseRequestPayloadSchema.safeParse({
      groupId: "g-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      viewerSessionId: "vs-1",
      viewerDeviceId: "vd-1",
      operationId: "op-1",
      paused: true,
      extra: "should-not-be-here",
    });
    expect(result.success).toBe(false);
  });
});

describe("ViewerPauseResultPayloadSchema", () => {
  it("accepts successful pause result", () => {
    const result = ViewerPauseResultPayloadSchema.safeParse({
      groupId: "g-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      viewerSessionId: "vs-1",
      viewerDeviceId: "vd-1",
      operationId: "op-1",
      paused: true,
      success: true,
    });
    expect(result.success).toBe(true);
  });

  it("accepts failed pause result with failureReason", () => {
    const result = ViewerPauseResultPayloadSchema.safeParse({
      groupId: "g-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      viewerSessionId: "vs-1",
      viewerDeviceId: "vd-1",
      operationId: "op-1",
      paused: true,
      success: false,
      failureReason: "Host rejected pause",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing success field", () => {
    const result = ViewerPauseResultPayloadSchema.safeParse({
      groupId: "g-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      viewerSessionId: "vs-1",
      viewerDeviceId: "vd-1",
      operationId: "op-1",
      paused: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing operationId", () => {
    const result = ViewerPauseResultPayloadSchema.safeParse({
      groupId: "g-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      viewerSessionId: "vs-1",
      viewerDeviceId: "vd-1",
      paused: true,
      success: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra unknown fields (strict mode)", () => {
    const result = ViewerPauseResultPayloadSchema.safeParse({
      groupId: "g-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      viewerSessionId: "vs-1",
      viewerDeviceId: "vd-1",
      operationId: "op-1",
      paused: true,
      success: true,
      extra: "should-not-be-here",
    });
    expect(result.success).toBe(false);
  });
});

describe("viewer.pause.request/result in GROUP_CONTROL_MESSAGE_TYPES", () => {
  it("includes viewer.pause.request in the message types list", () => {
    expect(GROUP_CONTROL_MESSAGE_TYPES).toContain("viewer.pause.request");
  });

  it("includes viewer.pause.result in the message types list", () => {
    expect(GROUP_CONTROL_MESSAGE_TYPES).toContain("viewer.pause.result");
  });

  it("no longer includes viewer.paused in the message types list", () => {
    expect(GROUP_CONTROL_MESSAGE_TYPES).not.toContain("viewer.paused");
  });
});

describe("parseGroupMessagePayload for viewer.pause.request/result", () => {
  it("parses viewer.pause.request successfully", () => {
    const result = parseGroupMessagePayload("viewer.pause.request", {
      groupId: "g-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      viewerSessionId: "vs-1",
      viewerDeviceId: "vd-1",
      operationId: "op-1",
      paused: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.paused).toBe(true);
      expect(result.data.operationId).toBe("op-1");
    }
  });

  it("parses viewer.pause.result successfully", () => {
    const result = parseGroupMessagePayload("viewer.pause.result", {
      groupId: "g-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      viewerSessionId: "vs-1",
      viewerDeviceId: "vd-1",
      operationId: "op-1",
      paused: true,
      success: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.success).toBe(true);
      expect(result.data.operationId).toBe("op-1");
    }
  });

  it("returns ok:false for viewer.pause.request with invalid payload", () => {
    const result = parseGroupMessagePayload("viewer.pause.request", {
      logicalStreamId: "ls-1",
    });
    expect(result.ok).toBe(false);
  });
});
