import { describe, it, expect } from "vitest";
import {
  validateEnvelope,
  signEnvelope,
  verifyEnvelope,
  DedupSet,
  GROUP_PROTOCOL_VERSION,
  GroupControlEnvelopeSchema,
} from "@screenlink/shared";
import { buildEnvelope } from "../src/group-control-messages.js";
import type { GroupControlEnvelopeInput } from "@screenlink/shared";

// ─── Helpers ───────────────────────────────────────────────────────────────

const GROUP_SECRET = "test-group-secret-abcdef123456";
const GROUP_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const SENDER_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

function makeInput(overrides?: Partial<GroupControlEnvelopeInput>): GroupControlEnvelopeInput {
  return {
    version: GROUP_PROTOCOL_VERSION,
    type: "group.hello",
    messageId: crypto.randomUUID(),
    sentAt: Date.now(),
    senderDeviceId: SENDER_ID,
    groupId: GROUP_ID,
    logicalStamp: { wallTimeMs: Date.now(), counter: 0, nodeId: SENDER_ID },
    payload: { displayName: "Alice" },
    ...overrides,
  };
}

describe("GroupControlMessages", () => {
  it("buildEnvelope creates a valid envelope with MAC", async () => {
    const input = makeInput();
    const envelope = await buildEnvelope(input, GROUP_SECRET);
    expect(envelope.version).toBe(GROUP_PROTOCOL_VERSION);
    expect(envelope.type).toBe("group.hello");
    expect(envelope.mac).toMatch(/^[0-9a-f]+$/);
    expect(envelope.mac.length).toBe(64); // SHA-256 HMAC = 32 bytes = 64 hex chars
    expect(GroupControlEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it("signEnvelope produces a consistent signature", async () => {
    const input = makeInput();
    const sig1 = await signEnvelope(input, GROUP_SECRET);
    const sig2 = await signEnvelope(input, GROUP_SECRET);
    expect(sig1).toBe(sig2);
  });

  it("verifyEnvelope returns true for valid envelope", async () => {
    const input = makeInput();
    const envelope = await buildEnvelope(input, GROUP_SECRET);
    const valid = await verifyEnvelope(envelope, GROUP_SECRET);
    expect(valid).toBe(true);
  });

  it("verifyEnvelope returns false for tampered payload", async () => {
    const input = makeInput();
    const envelope = await buildEnvelope(input, GROUP_SECRET);
    // Tamper with payload
    envelope.payload = { evil: "data" };
    const valid = await verifyEnvelope(envelope, GROUP_SECRET);
    expect(valid).toBe(false);
  });

  it("verifyEnvelope returns false for tampered MAC", async () => {
    const input = makeInput();
    const envelope = await buildEnvelope(input, GROUP_SECRET);
    envelope.mac = "0".repeat(64);
    const valid = await verifyEnvelope(envelope, GROUP_SECRET);
    expect(valid).toBe(false);
  });

  it("validateEnvelope rejects wrong group ID", async () => {
    const input = makeInput();
    const envelope = await buildEnvelope(input, GROUP_SECRET);
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
    const input = makeInput();
    const envelope = await buildEnvelope(input, GROUP_SECRET);
    const dedup = new DedupSet(60000); // 1 min window

    // First validation should succeed
    const r1 = await validateEnvelope(envelope, GROUP_ID, GROUP_SECRET, dedup);
    expect(r1.ok).toBe(true);

    // Second validation with same envelope should fail (duplicate messageId)
    const r2 = await validateEnvelope(envelope, GROUP_ID, GROUP_SECRET, dedup);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.reason).toContain("Duplicate");
    }
  });

  it("DedupSet evicts old entries", async () => {
    const dedup = new DedupSet(0); // 0ms window — immediate eviction
    dedup.add("test-id");
    // Wait a tick for eviction
    await new Promise((r) => setTimeout(r, 10));
    expect(dedup.has("test-id")).toBe(false);
  });

  it("validateEnvelope rejects unsupported version", async () => {
    const input = makeInput({ version: 99 });
    // Build envelope manually without validation
    const envelope = {
      ...input,
      mac: "0".repeat(64),
    };
    const dedup = new DedupSet();
    const result = await validateEnvelope(envelope, GROUP_ID, GROUP_SECRET, dedup);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("version");
    }
  });
});
