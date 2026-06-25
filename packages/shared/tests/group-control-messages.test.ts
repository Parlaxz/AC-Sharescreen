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
