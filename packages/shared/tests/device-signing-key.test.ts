import { describe, it, expect, beforeAll } from "vitest";
import {
  buildEnvelope,
  validateEnvelope,
  GROUP_PROTOCOL_VERSION,
  signEnvelope,
  verifyEnvelopeDeviceSignature,
  serializeForDeviceSignature,
  type GroupControlEnvelope,
  type GroupControlEnvelopeInput,
} from "../src/group-control-messages.js";
import {
  generateDeviceKeyPair,
  importDevicePrivateKeyForSigning,
  importDevicePublicKey,
  signBytes,
  verifyBytes,
  bytesToBase64Url,
  base64UrlToBytes,
  type DeviceKeyPair,
  type DevicePublicKey,
} from "../src/device-signing-key.js";

const GROUP_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const GROUP_SECRET = "test-secret-device-123";
const SENDER_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

let alice: DeviceKeyPair;
let bob: DeviceKeyPair;
let alicePrivKey: CryptoKey;
let bobPrivKey: CryptoKey;
let alicePubKey: CryptoKey;
let bobPubKey: CryptoKey;
const lookup = (sender: string): { publicKey: DevicePublicKey } | null => {
  if (sender === "alice") return { publicKey: alice.publicKey };
  if (sender === "bob") return { publicKey: bob.publicKey };
  return null;
};

beforeAll(async () => {
  alice = await generateDeviceKeyPair();
  bob = await generateDeviceKeyPair();
  alicePrivKey = await importDevicePrivateKeyForSigning(alice.privateKeySeed);
  bobPrivKey = await importDevicePrivateKeyForSigning(bob.privateKeySeed);
  alicePubKey = await importDevicePublicKey(alice.publicKey);
  bobPubKey = await importDevicePublicKey(bob.publicKey);
});

async function buildSigned(
  sender: "alice" | "bob",
  overrides?: Partial<Omit<GroupControlEnvelopeInput, "deviceSignature">>,
): Promise<GroupControlEnvelope> {
  const priv = sender === "alice" ? alicePrivKey : bobPrivKey;
  const deviceId = sender === "alice" ? "alice" : "bob";
  const input: Omit<GroupControlEnvelopeInput, "deviceSignature"> = {
    version: GROUP_PROTOCOL_VERSION,
    type: "group.hello",
    messageId: crypto.randomUUID(),
    sentAt: Date.now(),
    senderDeviceId: deviceId,
    groupId: GROUP_ID,
    logicalStamp: { wallTimeMs: Date.now(), counter: 0, nodeId: deviceId },
    payload: {
      deviceId,
      displayName: sender,
      protocolVersion: GROUP_PROTOCOL_VERSION,
      publicKey: sender === "alice" ? alice.publicKey.key : bob.publicKey.key,
    },
    ...overrides,
  } as Omit<GroupControlEnvelopeInput, "deviceSignature">;
  return await buildEnvelope(input, GROUP_SECRET, priv);
}

describe("device signing key (Gate 1)", () => {
  it("generates a 32-byte Ed25519 public key in portable form", () => {
    expect(alice.publicKey.version).toBe(1);
    const bytes = base64UrlToBytes(alice.publicKey.key);
    expect(bytes.length).toBe(32);
  });

  it("public key is reproducible across import/export", async () => {
    const imported = await importDevicePublicKey(alice.publicKey);
    expect(imported.algorithm.name).toBe("Ed25519");
  });

  it("signs and verifies bytes round-trip with the same key", async () => {
    const data = new TextEncoder().encode("hello screenlink");
    const sig = await signBytes(alicePrivKey, data);
    expect(sig.length).toBe(64);
    const ok = await verifyBytes(alicePubKey, sig, data);
    expect(ok).toBe(true);
  });

  it("rejects a signature made with a different key", async () => {
    const data = new TextEncoder().encode("forged payload");
    const sig = await signBytes(bobPrivKey, data);
    const ok = await verifyBytes(alicePubKey, sig, data);
    expect(ok).toBe(false);
  });

  it("bytesToBase64Url and base64UrlToBytes round-trip", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 255, 127, 128]);
    const s = bytesToBase64Url(bytes);
    const back = base64UrlToBytes(s);
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });
});

describe("envelope device signature (Gate 1.3 / 1.4)", () => {
  it("validateEnvelope accepts a correctly signed envelope", async () => {
    const env = await buildSigned("alice");
    const r = await validateEnvelope(env, GROUP_ID, GROUP_SECRET, new (await import("../src/group-control-messages.js")).DedupSet(), lookup);
    expect(r.ok).toBe(true);
  });

  it("validateEnvelope rejects a wrong-signature envelope", async () => {
    const env = await buildSigned("bob");
    // Tamper with the device signature (flip a byte in the hex string).
    const tampered = {
      ...env,
      deviceSignature: env.deviceSignature.replace(/[0-9a-f]/, (c) => c === "0" ? "1" : "0"),
    } as GroupControlEnvelope;
    const r = await validateEnvelope(
      tampered,
      GROUP_ID,
      GROUP_SECRET,
      new (await import("../src/group-control-messages.js")).DedupSet(),
      lookup,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/Invalid device signature|Invalid MAC/);
    }
  });

  it("validateEnvelope rejects an envelope whose sender is not in the lookup", async () => {
    const env = await buildSigned("alice", {
      type: "group.presence",
      payload: { deviceId: "alice", status: "online" },
    });
    const r = await validateEnvelope(
      env,
      GROUP_ID,
      GROUP_SECRET,
      new (await import("../src/group-control-messages.js")).DedupSet(),
      () => null,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/pinned|No pinned device/);
    }
  });

  it("validateEnvelope rejects an envelope whose HMAC was computed against the wrong secret", async () => {
    const env = await buildSigned("alice");
    const r = await validateEnvelope(
      env,
      GROUP_ID,
      "wrong-secret",
      new (await import("../src/group-control-messages.js")).DedupSet(),
      lookup,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/Invalid MAC/);
    }
  });

  it("verifyEnvelopeDeviceSignature returns true for a correctly signed envelope", async () => {
    const env = await buildSigned("alice");
    const ok = await verifyEnvelopeDeviceSignature(env, alice.publicKey);
    expect(ok).toBe(true);
  });

  it("verifyEnvelopeDeviceSignature returns false when tampered", async () => {
    const env = await buildSigned("alice");
    const tampered = { ...env, sentAt: env.sentAt + 1 } as GroupControlEnvelope;
    const ok = await verifyEnvelopeDeviceSignature(tampered, alice.publicKey);
    expect(ok).toBe(false);
  });

  it("serializeForDeviceSignature is deterministic for equal input", async () => {
    const a: Omit<GroupControlEnvelopeInput, "deviceSignature"> = {
      version: GROUP_PROTOCOL_VERSION,
      type: "group.hello",
      messageId: "11111111-1111-4111-1111-111111111111",
      sentAt: 1000,
      senderDeviceId: "alice",
      groupId: GROUP_ID,
      logicalStamp: { wallTimeMs: 1000, counter: 0, nodeId: "alice" },
      payload: { b: 2, a: 1 },
    } as Omit<GroupControlEnvelopeInput, "deviceSignature">;
    const aBytes = serializeForDeviceSignature(a);
    const aBytes2 = serializeForDeviceSignature(a);
    expect(Array.from(aBytes)).toEqual(Array.from(aBytes2));
  });
});
