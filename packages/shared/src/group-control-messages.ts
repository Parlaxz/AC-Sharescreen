import { z } from "zod";
import type { HybridTimestamp } from "./hybrid-logical-clock.js";
import { HybridTimestampSchema } from "./hybrid-logical-clock.js";

// ─── Constants ─────────────────────────────────────────────────────────────

export const GROUP_PROTOCOL_VERSION = 2;

export const GROUP_CONTROL_MESSAGE_TYPES = [
  "group.hello",
  "group.hello.response",
  "group.state.summary",
  "group.state.request",
  "group.state.update",
  "group.member.update",
  "group.presence",
  "stream.state.request",
  "stream.state.snapshot",
  "stream.started",
  "stream.heartbeat",
  "stream.stopped",
  "stream.restart.request",
  "stream.restarted",
  "stream.restart.result",
  "stream.join.request",
  "stream.join.response",
  "stream.leave",
  "media.bind",
  "quality.viewer.request",
  "quality.viewer.clear",
  "quality.effective",
  "quality.configured",
  "quality.observed",
  "ping",
  "pong",
] as const;

export type GroupControlMessageType =
  (typeof GROUP_CONTROL_MESSAGE_TYPES)[number];

export const MAX_GROUP_CONTROL_PAYLOAD_BYTES = 64 * 1024; // 64 KB
export const DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
export const MAC_KEY_BYTES = 32;

// ─── Types ─────────────────────────────────────────────────────────────────

export interface GroupControlEnvelope {
  version: number;
  type: GroupControlMessageType;
  messageId: string;
  sentAt: number;
  senderDeviceId: string;
  groupId: string;
  logicalStamp: HybridTimestamp;
  payload: Record<string, unknown>;
  mac: string; // HMAC-SHA256, hex-encoded
}

export interface GroupControlEnvelopeInput {
  version: number;
  type: GroupControlMessageType;
  messageId: string;
  sentAt: number;
  senderDeviceId: string;
  groupId: string;
  logicalStamp: HybridTimestamp;
  payload: Record<string, unknown>;
}

// ─── Schemas ───────────────────────────────────────────────────────────────

export const GroupControlEnvelopeSchema = z.object({
  version: z.number().int().positive(),
  type: z.enum(GROUP_CONTROL_MESSAGE_TYPES),
  messageId: z.string().uuid(),
  sentAt: z.number().int().positive(),
  senderDeviceId: z.string(),
  groupId: z.string().uuid(),
  logicalStamp: HybridTimestampSchema,
  payload: z.record(z.unknown()),
  mac: z.string(),
});

// ─── HMAC helpers ──────────────────────────────────────────────────────────

/**
 * Derive an HMAC key from the group secret.
 * key = SHA-256(groupSecret) → 32 bytes.
 */
export async function deriveMacKey(groupSecret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(groupSecret).buffer as ArrayBuffer);
  const key = await crypto.subtle.importKey(
    "raw",
    hashBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return key;
}

/**
 * Compute an HMAC-SHA256 signature for the envelope body (everything except the mac field).
 * Returns the hex-encoded signature.
 */
export async function signEnvelope(
  envelope: GroupControlEnvelopeInput,
  groupSecret: string,
): Promise<string> {
  const key = await deriveMacKey(groupSecret);
  const data = serializeForMac(envelope);
  const signature = await crypto.subtle.sign("HMAC", key, data.buffer as ArrayBuffer);
  return bytesToHex(new Uint8Array(signature));
}

/**
 * Verify the HMAC-SHA256 signature on an envelope.
 */
export async function verifyEnvelope(
  envelope: GroupControlEnvelope,
  groupSecret: string,
): Promise<boolean> {
  const key = await deriveMacKey(groupSecret);
  const input: GroupControlEnvelopeInput = {
    version: envelope.version,
    type: envelope.type,
    messageId: envelope.messageId,
    sentAt: envelope.sentAt,
    senderDeviceId: envelope.senderDeviceId,
    groupId: envelope.groupId,
    logicalStamp: envelope.logicalStamp,
    payload: envelope.payload,
  };
  const data = serializeForMac(input);
  const sigBytes = hexToBytes(envelope.mac);
  return await crypto.subtle.verify("HMAC", key, sigBytes.buffer as ArrayBuffer, data.buffer as ArrayBuffer);
}

function serializeForMac(input: GroupControlEnvelopeInput): Uint8Array {
  // Canonical JSON (sorted keys) of the envelope without the mac field
  const obj: Record<string, unknown> = {
    version: input.version,
    type: input.type,
    messageId: input.messageId,
    sentAt: input.sentAt,
    senderDeviceId: input.senderDeviceId,
    groupId: input.groupId,
    logicalStamp: {
      wallTimeMs: input.logicalStamp.wallTimeMs,
      counter: input.logicalStamp.counter,
      nodeId: input.logicalStamp.nodeId,
    },
    payload: input.payload,
  };
  const json = canonicalJsonStringify(obj);
  const encoder = new TextEncoder();
  return encoder.encode(json);
}

// ─── Envelope building ─────────────────────────────────────────────────────

/**
 * Build a fully signed GroupControlEnvelope.
 */
export async function buildEnvelope(
  input: GroupControlEnvelopeInput,
  groupSecret: string,
): Promise<GroupControlEnvelope> {
  const mac = await signEnvelope(input, groupSecret);
  return {
    ...input,
    mac,
  };
}

/**
 * Validate a GroupControlEnvelope.
 * Rejects on: wrong group, invalid MAC, oversized payload, invalid schema,
 * duplicate ID, unsupported version.
 */
export async function validateEnvelope(
  envelope: unknown,
  expectedGroupId: string,
  groupSecret: string,
  dedupSet: DedupSet,
): Promise<{ ok: true; data: GroupControlEnvelope } | { ok: false; reason: string }> {
  // Schema validation
  const parseResult = GroupControlEnvelopeSchema.safeParse(envelope);
  if (!parseResult.success) {
    return { ok: false, reason: `Invalid schema: ${parseResult.error.message}` };
  }

  const data = parseResult.data;

  // Version check
  if (data.version !== GROUP_PROTOCOL_VERSION) {
    return { ok: false, reason: `Unsupported version: ${data.version}` };
  }

  // Group ID check
  if (data.groupId !== expectedGroupId) {
    return { ok: false, reason: "Wrong group ID" };
  }

  // Payload size check
  const payloadJson = JSON.stringify(data.payload);
  if (payloadJson.length > MAX_GROUP_CONTROL_PAYLOAD_BYTES) {
    return {
      ok: false,
      reason: `Payload exceeds maximum size of ${MAX_GROUP_CONTROL_PAYLOAD_BYTES} bytes`,
    };
  }

  // Duplicate ID check
  if (dedupSet.has(data.messageId)) {
    return { ok: false, reason: "Duplicate message ID" };
  }

  // MAC verification
  const macValid = await verifyEnvelope(data, groupSecret);
  if (!macValid) {
    return { ok: false, reason: "Invalid MAC" };
  }

  // Register in dedup set
  dedupSet.add(data.messageId);

  return { ok: true, data };
}

// ─── DedupSet ──────────────────────────────────────────────────────────────

/**
 * A bounded deduplication set that tracks message IDs within a time window.
 * Automatically evicts entries older than the window.
 */
export class DedupSet {
  private readonly windowMs: number;
  private readonly entries: Map<string, number> = new Map();

  constructor(windowMs: number = DEDUP_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  has(id: string): boolean {
    this.evict();
    return this.entries.has(id);
  }

  add(id: string): void {
    this.evict();
    this.entries.set(id, Date.now());
  }

  size(): number {
    this.evict();
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private evict(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [id, addedAt] of this.entries) {
      if (addedAt < cutoff) {
        this.entries.delete(id);
      }
    }
  }
}

// ─── Internal helpers ──────────────────────────────────────────────────────

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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
