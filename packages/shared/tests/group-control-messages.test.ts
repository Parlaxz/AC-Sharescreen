import { describe, it, expect, beforeAll } from "vitest";
import {
  validateEnvelope,
  signEnvelope,
  verifyEnvelope,
  DedupSet,
  GROUP_PROTOCOL_VERSION,
  GroupControlEnvelopeSchema,
  buildEnvelopeWithDeviceSignature,
} from "@screenlink/shared";
import { serializeForDeviceSignature, bytesToHex } from "../src/group-control-messages.js";
import type { GroupControlEnvelopeInput } from "@screenlink/shared";
import {
  generateDeviceKeyPair,
  importDevicePrivateKeyForSigning,
  signBytes,
  type DeviceKeyPair,
} from "../src/device-signing-key.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

const GROUP_SECRET = "test-group-secret-abcdef123456";
const GROUP_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const SENDER_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

let kp: DeviceKeyPair;
let privKey: CryptoKey;
let pubKeyObj: DeviceKeyPair["publicKey"];

beforeAll(async () => {
  kp = await generateDeviceKeyPair();
  privKey = await importDevicePrivateKeyForSigning(kp.privateKeySeed);
  pubKeyObj = kp.publicKey;
});

async function makeSigned(
  overrides?: Partial<Omit<GroupControlEnvelopeInput, "deviceSignature">>,
  key: CryptoKey = privKey,
) {
  const input: Omit<GroupControlEnvelopeInput, "deviceSignature"> = {
    version: GROUP_PROTOCOL_VERSION,
    type: "group.hello",
    messageId: crypto.randomUUID(),
    sentAt: Date.now(),
    senderDeviceId: SENDER_ID,
    groupId: GROUP_ID,
    logicalStamp: { wallTimeMs: Date.now(), counter: 0, nodeId: SENDER_ID },
    payload: { displayName: "Alice" },
    ...overrides,
  } as Omit<GroupControlEnvelopeInput, "deviceSignature">;
  const partial: GroupControlEnvelopeInput = {
    ...input,
    deviceSignature: "",
  };
  const sig = await signBytes(key, serializeForDeviceSignature(partial));
  const full: Omit<GroupControlEnvelopeInput, "mac"> = {
    ...input,
    deviceSignature: bytesToHex(sig),
  };
  return await buildEnvelopeWithDeviceSignature(full, GROUP_SECRET);
}

const lookup = () => ({ publicKey: pubKeyObj });

describe("GroupControlMessages", () => {
  it("buildEnvelope creates a valid envelope with MAC and device signature", async () => {
    const envelope = await makeSigned();
    expect(envelope.version).toBe(GROUP_PROTOCOL_VERSION);
    expect(envelope.type).toBe("group.hello");
    expect(envelope.mac).toMatch(/^[0-9a-f]+$/);
    expect(envelope.mac.length).toBe(64);
    expect(envelope.deviceSignature.length).toBe(128);
    expect(GroupControlEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it("signEnvelope produces a consistent signature for the same input", async () => {
    const input: Omit<GroupControlEnvelopeInput, "deviceSignature"> = {
      version: GROUP_PROTOCOL_VERSION,
      type: "group.hello",
      messageId: "11111111-1111-4111-1111-111111111111",
      sentAt: 1000,
      senderDeviceId: SENDER_ID,
      groupId: GROUP_ID,
      logicalStamp: { wallTimeMs: 1000, counter: 0, nodeId: SENDER_ID },
      payload: { displayName: "Alice" },
    } as Omit<GroupControlEnvelopeInput, "deviceSignature">;
    const partial: GroupControlEnvelopeInput = { ...input, deviceSignature: "abc" };
    const sig1 = await signEnvelope(partial, GROUP_SECRET);
    const sig2 = await signEnvelope(partial, GROUP_SECRET);
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
    const result = await validateEnvelope(envelope, wrongGroupId, GROUP_SECRET, dedup, lookup);
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
      lookup,
    );
    expect(result.ok).toBe(false);
  });

  it("DedupSet prevents duplicate message IDs", async () => {
    const envelope = await makeSigned();
    const dedup = new DedupSet(60000);
    const r1 = await validateEnvelope(envelope, GROUP_ID, GROUP_SECRET, dedup, lookup);
    expect(r1.ok).toBe(true);
    const r2 = await validateEnvelope(envelope, GROUP_ID, GROUP_SECRET, dedup, lookup);
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
    const result = await validateEnvelope(envelope, GROUP_ID, GROUP_SECRET, dedup, lookup);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/version|Unsupported/);
    }
  });
});
