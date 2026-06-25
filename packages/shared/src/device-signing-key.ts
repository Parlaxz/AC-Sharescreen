import { z } from "zod";

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Public device signing key.
 *
 * 32-byte Ed25519 public key encoded as base64url.
 * Persisted alongside the local device identity and exchanged in
 * group member records and the local portion of group invites.
 */
export interface DevicePublicKey {
  /** base64url-encoded 32-byte Ed25519 public key */
  key: string;
  /** Schema version of the persisted key record (currently 1). */
  version: 1;
  /** Wall-clock ms when the key was generated. */
  createdAt: number;
}

export const DevicePublicKeySchema = z.object({
  key: z.string().min(1).max(512),
  version: z.literal(1),
  createdAt: z.number().int().positive(),
});

/**
 * Full per-device key pair material. The private key is ALWAYS
 * base64url-encoded Ed25519 raw (32 bytes) or 64-byte seed — but
 * when produced by generateDeviceKeyPair, it is 32 raw bytes (the
 * Ed25519 seed) suitable for use with `crypto.subtle`.
 *
 * Private keys must never travel through the renderer. This
 * interface exists so main-process code can hold a typed handle.
 */
export interface DeviceKeyPair {
  publicKey: DevicePublicKey;
  /** base64url-encoded 32-byte Ed25519 seed (private). */
  privateKeySeed: string;
}

export const DEVICE_KEY_SCHEMES = ["ed25519"] as const;
export type DeviceKeyScheme = (typeof DEVICE_KEY_SCHEMES)[number];

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Encode a byte array as base64url (no padding).
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Decode a base64url string to a byte array.
 */
export function base64UrlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const b64 = padded + padding;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ─── Key generation ────────────────────────────────────────────────────────

/**
 * Generate a new Ed25519 device key pair.
 *
 * Uses WebCrypto's native Ed25519 implementation when available
 * (Node 18+ supports it; modern Chromium does as well). The
 * returned key pair contains the public key in portable
 * base64url form and the private key as a base64url 32-byte seed.
 */
export async function generateDeviceKeyPair(now: number = Date.now()): Promise<DeviceKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" } as EcKeyGenParams,
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;

  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const privateKeyPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));

  // Ed25519 raw private key is the last 32 bytes of the PKCS8 document.
  // We store only the seed so the renderer can never accidentally use
  // it; main loads it back into a non-extractable CryptoKey for use.
  if (privateKeyPkcs8.length < 32) {
    throw new Error("Generated Ed25519 private key is too short to extract seed");
  }
  const seed = privateKeyPkcs8.slice(privateKeyPkcs8.length - 32);

  return {
    publicKey: {
      key: bytesToBase64Url(publicKeyRaw),
      version: 1,
      createdAt: now,
    },
    privateKeySeed: bytesToBase64Url(seed),
  };
}

// ─── Sign / verify ─────────────────────────────────────────────────────────

/**
 * Import a public key from its base64url portable form for verification.
 */
export async function importDevicePublicKey(publicKey: DevicePublicKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    base64UrlToBytes(publicKey.key).buffer as ArrayBuffer,
    { name: "Ed25519" } as EcKeyImportParams,
    false,
    ["verify"],
  );
}

/**
 * Import a private key seed for signing.
 *
 * This is a *main-process only* helper. The renderer MUST NOT call
 * this function. It returns a non-extractable CryptoKey so the
 * private material cannot be re-exported through any code path.
 */
export async function importDevicePrivateKeyForSigning(privateKeySeed: string): Promise<CryptoKey> {
  const seedBytes = base64UrlToBytes(privateKeySeed);
  // Ed25519 seeds are 32 bytes; build a minimal PKCS8 v1 document
  // around them so crypto.subtle can import.
  const pkcs8 = wrapEd25519SeedAsPkcs8(seedBytes);
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8.buffer as ArrayBuffer,
    { name: "Ed25519" } as EcKeyImportParams,
    false,
    ["sign"],
  );
}

/**
 * Sign a canonical byte payload with an imported private CryptoKey.
 */
export async function signBytes(privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign({ name: "Ed25519" } as EcdsaParams, privateKey, data.buffer as ArrayBuffer);
  return new Uint8Array(sig);
}

/**
 * Verify a signature against a public key and canonical bytes.
 */
export async function verifyBytes(
  publicKey: CryptoKey,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  return crypto.subtle.verify(
    { name: "Ed25519" } as EcdsaParams,
    publicKey,
    signature.buffer as ArrayBuffer,
    data.buffer as ArrayBuffer,
  );
}

// ─── Canonical bytes helper ────────────────────────────────────────────────

/**
 * Compute a deterministic canonical JSON byte payload.
 *
 * Used both for envelope signing (device signature) and for the
 * group HMAC so the same canonicalization rules apply consistently.
 */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJsonStringify(value));
}

function canonicalJsonStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys.map(
      (k) =>
        `${JSON.stringify(k)}:${canonicalJsonStringify((value as Record<string, unknown>)[k])}`,
    );
    return `{${pairs.join(",")}}`;
  }
  return JSON.stringify(value);
}

// ─── Internal: PKCS8 wrapping for Ed25519 seed ─────────────────────────────

// Minimal PKCS8 v1 DER for "ED25519" algorithm OID, wrapping a raw
// 32-byte private key. Source: RFC 8410 §3 + RFC 8419 algorithm OID
// registry entry for 1.3.101.112 (id-Ed25519).
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);

function wrapEd25519SeedAsPkcs8(seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) {
    throw new Error(`Ed25519 seed must be 32 bytes, got ${seed.length}`);
  }
  const out = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  out.set(PKCS8_ED25519_PREFIX, 0);
  out.set(seed, PKCS8_ED25519_PREFIX.length);
  return out;
}
