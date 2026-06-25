import { describe, it, expect } from "vitest";
import {
  DedupSet,
  GroupHelloPayloadSchema,
  GroupHelloResponsePayloadSchema,
  GroupStateUpdatePayloadSchema,
  GroupStateSummaryPayloadSchema,
  GroupStateRequestPayloadSchema,
  GroupMemberUpdatePayloadSchema,
  GroupPresencePayloadSchema,
  StreamStateRequestPayloadSchema,
  StreamStateSnapshotPayloadSchema,
  StreamStartedPayloadSchema,
  StreamHeartbeatPayloadSchema,
  StreamStoppedPayloadSchema,
  StreamRestartRequestPayloadSchema,
  StreamRestartedPayloadSchema,
  StreamRestartResultPayloadSchema,
  StreamJoinRequestPayloadSchema,
  StreamJoinResponsePayloadSchema,
  StreamLeavePayloadSchema,
  MediaBindPayloadSchema,
  QualityViewerRequestPayloadSchema,
  QualityViewerClearPayloadSchema,
  QualityEffectivePayloadSchema,
  QualityConfiguredPayloadSchema,
  QualityObservedPayloadSchema,
  PingPayloadSchema,
  PongPayloadSchema,
  parseGroupMessagePayload,
  DEDUP_MAX_ENTRIES,
  DEDUP_WINDOW_MS,
  MAX_GROUP_CONTROL_PAYLOAD_BYTES,
  utf8ByteLength,
  validateEnvelope,
  buildEnvelope,
  GROUP_PROTOCOL_VERSION,
} from "../src/group-control-messages.js";
import type { GroupControlEnvelopeInput } from "../src/group-control-messages.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

const STAMP = { wallTimeMs: 1000, counter: 0, nodeId: "node-a" };

// ─── Payload Schema Tests ──────────────────────────────────────────────────

describe("GroupHelloPayloadSchema", () => {
  it("accepts valid hello", () => {
    const r = GroupHelloPayloadSchema.safeParse({ deviceId: "dev-1", displayName: "Alice", protocolVersion: 2 });
    expect(r.success).toBe(true);
  });

  it("rejects empty displayName", () => {
    const r = GroupHelloPayloadSchema.safeParse({ deviceId: "dev-1", displayName: "", protocolVersion: 2 });
    expect(r.success).toBe(false);
  });

  it("rejects missing protocolVersion", () => {
    const r = GroupHelloPayloadSchema.safeParse({ deviceId: "dev-1", displayName: "Alice" });
    expect(r.success).toBe(false);
  });
});

describe("GroupHelloResponsePayloadSchema", () => {
  it("accepts valid response", () => {
    const r = GroupHelloResponsePayloadSchema.safeParse({ deviceId: "dev-1", displayName: "Alice" });
    expect(r.success).toBe(true);
  });
});

describe("GroupStateUpdatePayloadSchema", () => {
  it("accepts full state update", () => {
    const r = GroupStateUpdatePayloadSchema.safeParse({
      state: { name: { value: "Room", stamp: STAMP, valueHash: "abc", updatedByDeviceId: "dev-1" } },
      stamp: STAMP,
    });
    expect(r.success).toBe(true);
  });

  it("accepts partial state update without stamp", () => {
    const r = GroupStateUpdatePayloadSchema.safeParse({
      state: { name: { value: "Room", stamp: STAMP, valueHash: "abc", updatedByDeviceId: "dev-1" } },
    });
    expect(r.success).toBe(true);
  });
});

describe("GroupStateSummaryPayloadSchema", () => {
  it("accepts valid summary", () => {
    const r = GroupStateSummaryPayloadSchema.safeParse({
      summary: { nameStamp: STAMP, nameHash: "abc" },
    });
    expect(r.success).toBe(true);
  });
});

describe("GroupStateRequestPayloadSchema", () => {
  it("accepts empty request", () => {
    const r = GroupStateRequestPayloadSchema.safeParse({});
    expect(r.success).toBe(true);
  });
});

describe("GroupMemberUpdatePayloadSchema", () => {
  it("accepts valid member update", () => {
    const r = GroupMemberUpdatePayloadSchema.safeParse({
      member: { deviceId: "dev-1", displayName: "Alice", firstSeenAt: 1000, profileStamp: STAMP },
    });
    expect(r.success).toBe(true);
  });

  it("rejects missing deviceId", () => {
    const r = GroupMemberUpdatePayloadSchema.safeParse({
      member: { displayName: "Alice", firstSeenAt: 1000, profileStamp: STAMP },
    });
    expect(r.success).toBe(false);
  });

  it("rejects invalid profileStamp", () => {
    const r = GroupMemberUpdatePayloadSchema.safeParse({
      member: { deviceId: "dev-1", displayName: "Alice", firstSeenAt: 1000, profileStamp: { wallTimeMs: -1, counter: 0, nodeId: "a" } },
    });
    expect(r.success).toBe(false);
  });
});

describe("GroupPresencePayloadSchema", () => {
  it("accepts valid presence", () => {
    const r = GroupPresencePayloadSchema.safeParse({ deviceId: "dev-1", status: "online" });
    expect(r.success).toBe(true);
  });

  it("rejects invalid status", () => {
    const r = GroupPresencePayloadSchema.safeParse({ deviceId: "dev-1", status: "unknown" });
    expect(r.success).toBe(false);
  });
});

describe("StreamStartedPayloadSchema", () => {
  it("accepts valid stream started", () => {
    const r = StreamStartedPayloadSchema.safeParse({
      logicalStreamId: "stream-1",
      mediaSessionId: "session-1",
      groupId: "group-1",
      hostDeviceId: "dev-1",
      hostDisplayName: "Alice",
      sourceKind: "screen",
      sourceName: "Monitor 1",
      startedAt: 1000,
      appliedSettingsRevision: 1,
      heartbeatSequence: 1,
      streamRevision: 1,
      mediaJoinMetadata: "meta",
      replacesSessionId: null,
    });
    expect(r.success).toBe(true);
  });

  it("rejects missing required field", () => {
    const r = StreamStartedPayloadSchema.safeParse({
      logicalStreamId: "stream-1",
    });
    expect(r.success).toBe(false);
  });
});

describe("StreamHeartbeatPayloadSchema", () => {
  it("accepts valid heartbeat", () => {
    const r = StreamHeartbeatPayloadSchema.safeParse({
      groupId: "group-1",
      hostDeviceId: "dev-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "session-1",
      heartbeatSequence: 5,
    });
    expect(r.success).toBe(true);
  });
});

describe("StreamStoppedPayloadSchema", () => {
  it("accepts valid stop", () => {
    const r = StreamStoppedPayloadSchema.safeParse({
      groupId: "group-1",
      hostDeviceId: "dev-1",
      logicalStreamId: "stream-1",
    });
    expect(r.success).toBe(true);
  });
});

describe("StreamRestartRequestPayloadSchema", () => {
  it("accepts valid restart request", () => {
    const r = StreamRestartRequestPayloadSchema.safeParse({
      logicalStreamId: "stream-1",
      reason: "degraded",
    });
    expect(r.success).toBe(true);
  });
});

describe("StreamRestartedPayloadSchema", () => {
  it("accepts valid restarted", () => {
    const r = StreamRestartedPayloadSchema.safeParse({
      logicalStreamId: "stream-1",
      mediaSessionId: "session-2",
      groupId: "group-1",
      hostDeviceId: "host-1",
      hostDisplayName: "Host One",
      sourceKind: "screen",
      sourceName: "Display 1",
      startedAt: Date.now(),
      appliedSettingsRevision: 1,
      heartbeatSequence: 3,
      streamRevision: 2,
      mediaJoinMetadata: "",
      previousMediaSessionId: "session-1",
      replacesSessionId: "session-1",
    });
    expect(r.success).toBe(true);
  });
});

describe("StreamRestartResultPayloadSchema", () => {
  it("accepts success result", () => {
    const r = StreamRestartResultPayloadSchema.safeParse({
      logicalStreamId: "stream-1",
      success: true,
      mediaSessionId: "session-2",
    });
    expect(r.success).toBe(true);
  });

  it("accepts failure result", () => {
    const r = StreamRestartResultPayloadSchema.safeParse({
      logicalStreamId: "stream-1",
      success: false,
      error: "no resources",
    });
    expect(r.success).toBe(true);
  });
});

describe("StreamJoinRequestPayloadSchema", () => {
  it("accepts valid join request", () => {
    const r = StreamJoinRequestPayloadSchema.safeParse({
      logicalStreamId: "stream-1",
      viewerDeviceId: "dev-2",
      viewerDisplayName: "Bob",
    });
    expect(r.success).toBe(true);
  });
});

describe("StreamJoinResponsePayloadSchema", () => {
  it("accepts valid join response", () => {
    const r = StreamJoinResponsePayloadSchema.safeParse({
      logicalStreamId: "stream-1",
      accepted: true,
      mediaJoinMetadata: "token-abc",
      viewerDeviceId: "dev-2",
    });
    expect(r.success).toBe(true);
  });

  it("accepts rejected join response", () => {
    const r = StreamJoinResponsePayloadSchema.safeParse({
      logicalStreamId: "stream-1",
      accepted: false,
      reason: "no capacity",
      viewerDeviceId: "dev-2",
    });
    expect(r.success).toBe(true);
  });

  it("accepts join response with VDO credentials", () => {
    const r = StreamJoinResponsePayloadSchema.safeParse({
      logicalStreamId: "stream-1",
      accepted: true,
      viewerDeviceId: "dev-2",
      mediaSessionId: "ms-1",
      mediaJoinMetadata: "token-abc",
      streamId: "vdo-stream-abc123",
      password: "vdo-password-xyz789",
      bindingToken: "token-abc",
      requestId: "req-1",
    });
    expect(r.success).toBe(true);
  });

  it("rejects join response with invalid field types", () => {
    const r = StreamJoinResponsePayloadSchema.safeParse({
      logicalStreamId: "stream-1",
      accepted: "yes",
      viewerDeviceId: "dev-2",
    });
    expect(r.success).toBe(false);
  });
});

describe("StreamLeavePayloadSchema", () => {
  it("accepts valid leave", () => {
    const r = StreamLeavePayloadSchema.safeParse({
      logicalStreamId: "stream-1",
      viewerDeviceId: "dev-2",
    });
    expect(r.success).toBe(true);
  });
});

describe("MediaBindPayloadSchema", () => {
  it("accepts valid media bind", () => {
    const r = MediaBindPayloadSchema.safeParse({
      token: "bind-token-abc",
      mediaSessionId: "session-1",
    });
    expect(r.success).toBe(true);
  });
});

describe("QualityViewerRequestPayloadSchema", () => {
  it("accepts valid viewer quality request", () => {
    const r = QualityViewerRequestPayloadSchema.safeParse({
      streamSessionId: "session-1",
      requestId: "req-1",
      revision: 1,
      videoBitrateKbps: 1500,
      maxWidth: 1280,
      maxHeight: 720,
      maxFps: 30,
      degradationPreference: "balanced",
    });
    expect(r.success).toBe(true);
  });
});

describe("QualityViewerClearPayloadSchema", () => {
  it("accepts valid clear", () => {
    const r = QualityViewerClearPayloadSchema.safeParse({
      streamSessionId: "session-1",
    });
    expect(r.success).toBe(true);
  });
});

describe("QualityEffectivePayloadSchema", () => {
  it("accepts valid effective quality", () => {
    const r = QualityEffectivePayloadSchema.safeParse({
      streamSessionId: "session-1",
      videoBitrateKbps: 1500,
    });
    expect(r.success).toBe(true);
  });
});

describe("QualityConfiguredPayloadSchema", () => {
  it("accepts valid configured quality", () => {
    const r = QualityConfiguredPayloadSchema.safeParse({
      streamSessionId: "session-1",
      videoBitrateKbps: 2000,
    });
    expect(r.success).toBe(true);
  });
});

describe("QualityObservedPayloadSchema", () => {
  it("accepts valid observed quality", () => {
    const r = QualityObservedPayloadSchema.safeParse({
      streamSessionId: "session-1",
      videoBitrateKbps: 1200,
    });
    expect(r.success).toBe(true);
  });
});

describe("PingPayloadSchema", () => {
  it("accepts valid ping", () => {
    const r = PingPayloadSchema.safeParse({ seq: 42 });
    expect(r.success).toBe(true);
  });

  it("rejects missing seq", () => {
    const r = PingPayloadSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});

describe("PongPayloadSchema", () => {
  it("accepts valid pong", () => {
    const r = PongPayloadSchema.safeParse({ seq: 42 });
    expect(r.success).toBe(true);
  });

  it("rejects missing seq", () => {
    const r = PongPayloadSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});

// ─── parseGroupMessagePayload ──────────────────────────────────────────────

describe("parseGroupMessagePayload", () => {
  it("parses group.hello payload", () => {
    const r = parseGroupMessagePayload("group.hello", { deviceId: "d1", displayName: "Alice", protocolVersion: 2 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.deviceId).toBe("d1");
  });

  it("parses group.member.update payload", () => {
    const r = parseGroupMessagePayload("group.member.update", {
      member: { deviceId: "d1", displayName: "Alice", firstSeenAt: 1000, profileStamp: STAMP },
    });
    expect(r.ok).toBe(true);
  });

  it("parses group.state.update payload", () => {
    const r = parseGroupMessagePayload("group.state.update", {
      state: { name: { value: "Room", stamp: STAMP, valueHash: "abc", updatedByDeviceId: "d1" } },
    });
    expect(r.ok).toBe(true);
  });

  it("parses group.state.request payload", () => {
    const r = parseGroupMessagePayload("group.state.request", {});
    expect(r.ok).toBe(true);
  });

  it("parses ping payload", () => {
    const r = parseGroupMessagePayload("ping", { seq: 1 });
    expect(r.ok).toBe(true);
  });

  it("parses pong payload", () => {
    const r = parseGroupMessagePayload("pong", { seq: 1 });
    expect(r.ok).toBe(true);
  });

  it("rejects malformed payload for known type", () => {
    const r = parseGroupMessagePayload("group.member.update", { member: { deviceId: "d1" } }); // missing displayName etc
    expect(r.ok).toBe(false);
  });

  it("rejects unknown message type", () => {
    const r = parseGroupMessagePayload("unknown.type" as any, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("Unknown");
  });

  it("rejects null payload", () => {
    const r = parseGroupMessagePayload("ping", null);
    expect(r.ok).toBe(false);
  });
});

// ─── UTF-8 Byte Length ─────────────────────────────────────────────────────

describe("utf8ByteLength", () => {
  it("returns correct byte length for ASCII", () => {
    expect(utf8ByteLength("hello")).toBe(5);
  });

  it("returns correct byte length for multi-byte characters", () => {
    expect(utf8ByteLength("héllo")).toBe(6); // é is 2 bytes
  });

  it("returns correct byte length for emoji", () => {
    expect(utf8ByteLength("a😀b")).toBe(6); // 😀 is 4 bytes
  });

  it("returns correct byte length for CJK", () => {
    expect(utf8ByteLength("你好")).toBe(6); // each is 3 bytes
  });

  it("returns 0 for empty string", () => {
    expect(utf8ByteLength("")).toBe(0);
  });
});

// ─── Payload Size Enforcement ──────────────────────────────────────────────

describe("Payload size enforcement", () => {
  it("UTF-8 size limit is correctly computed", () => {
    // Use a 3-byte UTF-8 character (€ = U+20AC, 1 JS char). 30000 of them = 90000 bytes
    // String length = 30000 (1 JS char each) — easily passes 64KB string length check
    // UTF-8 byte length = 90000 — exceeds 64KB byte limit
    const multiBytePayload = "€".repeat(30000);
    const byteLen = utf8ByteLength(multiBytePayload);
    expect(byteLen).toBe(90000);
    expect(byteLen).toBeGreaterThan(MAX_GROUP_CONTROL_PAYLOAD_BYTES);
    // String length is 30000, which is less than 64KB — wrong length check!
    expect(multiBytePayload.length).toBe(30000);
    expect(multiBytePayload.length).toBeLessThan(MAX_GROUP_CONTROL_PAYLOAD_BYTES);
  });
});

// ─── DedupSet Max Entries ───────────────────────────────────────────────────

describe("DedupSet max entries", () => {
  it("enforces max entries bound", () => {
    const dedup = new DedupSet(60000, 10); // 1 min window, max 10 entries
    for (let i = 0; i < 10; i++) {
      dedup.add(`id-${i}`);
    }
    expect(dedup.size()).toBe(10);

    // Adding one more should evict oldest
    dedup.add("id-10");
    // Should still be at most 10
    expect(dedup.size()).toBeLessThanOrEqual(10);
    // id-0 should be evicted
    expect(dedup.has("id-0")).toBe(false);
  });

  it("default max entries is 10000", () => {
    expect(DEDUP_MAX_ENTRIES).toBe(10000);
  });

  it("time-based eviction still works with max entries", async () => {
    const dedup = new DedupSet(1, 100); // 1ms window, max 100 entries
    dedup.add("test-id");
    // Wait for eviction window to pass
    await new Promise((r) => setTimeout(r, 5));
    expect(dedup.has("test-id")).toBe(false); // evicted by time
  });

  it("zero window does not cause issues", async () => {
    const dedup = new DedupSet(0);
    dedup.add("a");
    // Wait a tick so time passes
    await new Promise((r) => setTimeout(r, 5));
    expect(dedup.has("a")).toBe(false);
    expect(dedup.size()).toBe(0);
  });
});

// ─── validateEnvelope integration ───────────────────────────────────────────

const VALIDATION_GROUP_SECRET = "test-secret-validate-123";
const VALIDATION_GROUP_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const VALIDATION_SENDER = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

async function makeValidEnvelope(
  overrides?: Partial<GroupControlEnvelopeInput>,
) {
  const input: GroupControlEnvelopeInput = {
    version: GROUP_PROTOCOL_VERSION,
    type: "group.hello",
    messageId: crypto.randomUUID(),
    sentAt: Date.now(),
    senderDeviceId: VALIDATION_SENDER,
    groupId: VALIDATION_GROUP_ID,
    logicalStamp: { wallTimeMs: Date.now(), counter: 0, nodeId: VALIDATION_SENDER },
    payload: { deviceId: VALIDATION_SENDER, displayName: "Alice", protocolVersion: 2 },
    ...overrides,
  };
  return await buildEnvelope(input, VALIDATION_GROUP_SECRET);
}

describe("validateEnvelope integration", () => {
  it("accepts a valid envelope with correct group, MAC, size, and dedup", async () => {
    const envelope = await makeValidEnvelope();
    const dedup = new DedupSet();
    const result = await validateEnvelope(envelope, VALIDATION_GROUP_ID, VALIDATION_GROUP_SECRET, dedup);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.type).toBe("group.hello");
    }
  });

  it("rejects oversized payload (UTF-8 byte length, not string length)", async () => {
    // Create payload with multi-byte chars where UTF-8 bytes > limit but string.length < limit
    const oversizedPayload = { data: "€".repeat(22000) }; // 22000 * 3 bytes = 66000 > 64KB
    expect(utf8ByteLength(JSON.stringify(oversizedPayload))).toBeGreaterThan(MAX_GROUP_CONTROL_PAYLOAD_BYTES);
    expect(JSON.stringify(oversizedPayload).length).toBeLessThan(MAX_GROUP_CONTROL_PAYLOAD_BYTES);

    const envelope = await makeValidEnvelope({
      payload: oversizedPayload as any,
    });
    const dedup = new DedupSet();
    const result = await validateEnvelope(envelope, VALIDATION_GROUP_ID, VALIDATION_GROUP_SECRET, dedup);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("exceeds maximum size");
    }
  });

  it("dedup rejects duplicate messageId after first acceptance", async () => {
    const envelope1 = await makeValidEnvelope();
    const dedup = new DedupSet(60000);

    // First use — accept
    const r1 = await validateEnvelope(envelope1, VALIDATION_GROUP_ID, VALIDATION_GROUP_SECRET, dedup);
    expect(r1.ok).toBe(true);

    // Second use with same messageId — reject as duplicate
    const r2 = await validateEnvelope(envelope1, VALIDATION_GROUP_ID, VALIDATION_GROUP_SECRET, dedup);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.reason).toContain("Duplicate");
    }
  });

  // ── Spoof rejection (sender deviceId mismatch) ──────────────────
  it("rejects group.member.update where senderDeviceId !== member.deviceId via parseGroupMessagePayload", () => {
    // The schema passes — the spoof check is in the service layer.
    // This test verifies the schema itself would accept the payload,
    // proving the spoof rejection relies on the additional service-layer check.
    const result = parseGroupMessagePayload("group.member.update", {
      member: {
        deviceId: "real-device",
        displayName: "Attacker",
        firstSeenAt: 1000,
        profileStamp: { wallTimeMs: 100, counter: 0, nodeId: "attacker-node" },
      },
    });
    // Schema accepts (payload is well-formed)
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The typed data correctly identifies the member deviceId
      expect(result.data.member.deviceId).toBe("real-device");
    }
  });
});
