import { z } from "zod";
import type { HybridTimestamp } from "./hybrid-logical-clock.js";
import { HybridTimestampSchema } from "./hybrid-logical-clock.js";

// ─── Constants ─────────────────────────────────────────────────────────────

export const GROUP_PROTOCOL_VERSION = 3;

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
  "stream.bind.ack",
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
export const DEDUP_MAX_ENTRIES = 10_000;
export const MAC_KEY_BYTES = 32;

/**
 * Compute the UTF-8 byte length of a string.
 * Uses TextEncoder which is available in modern JS runtimes.
 */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

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
  /**
   * Ed25519 signature by the sender's device private key over the
   * canonical bytes of the envelope without the mac and deviceSignature
   * fields. Hex-encoded raw signature (64 bytes → 128 hex chars).
   *
   * Present for v3+ envelopes. v2 envelopes without it must be
   * rejected by `validateEnvelope` (see signatureRequired).
   */
  deviceSignature: string;
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
  deviceSignature: string;
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
  deviceSignature: z.string().max(1024),
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
 *
 * The HMAC is computed over the canonical bytes of the input INCLUDING
 * the device signature, so the group HMAC attests that the signed
 * envelope is unchanged.
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
    deviceSignature: envelope.deviceSignature,
  };
  const data = serializeForMac(input);
  const sigBytes = hexToBytes(envelope.mac);
  return await crypto.subtle.verify("HMAC", key, sigBytes.buffer as ArrayBuffer, data.buffer as ArrayBuffer);
}

/**
 * Serialize an envelope for HMAC signing.
 *
 * The canonical bytes include the device signature so the group HMAC
 * attests that the device signature was bound to this envelope.
 * Both the mac and deviceSignature fields are excluded from the
 * canonical bytes — `mac` because it is the output, and
 * `deviceSignature` is INCLUDED so the HMAC binds it.
 */
export function serializeForMac(input: GroupControlEnvelopeInput): Uint8Array {
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
    deviceSignature: input.deviceSignature,
  };
  const json = canonicalJsonStringify(obj);
  const encoder = new TextEncoder();
  return encoder.encode(json);
}

/**
 * Serialize an envelope for device signing — EXCLUDES both the device
 * signature field and the mac field.
 */
export function serializeForDeviceSignature(input: GroupControlEnvelopeInput): Uint8Array {
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
 * Build a fully signed GroupControlEnvelope from a partial input
 * (without the device signature yet). The caller must supply a
 * pre-imported private CryptoKey.
 *
 * The signing sequence is:
 *   1. Build envelope without deviceSignature.
 *   2. Compute canonical bytes excluding both signatures.
 *   3. Sign those bytes with the sender's device private key.
 *   4. Compute the group HMAC over the canonical bytes that include
 *      the device signature.
 *   5. Attach the device signature and HMAC.
 */
export async function buildEnvelope(
  input: Omit<GroupControlEnvelopeInput, "deviceSignature">,
  groupSecret: string,
  devicePrivateKey: CryptoKey,
): Promise<GroupControlEnvelope> {
  // Step 1: build with empty signature so the canonicalization is consistent.
  const partialInput: GroupControlEnvelopeInput = {
    ...input,
    deviceSignature: "",
  };

  // Step 2: canonical bytes for device signing (no device sig, no mac)
  const deviceSignBytes = serializeForDeviceSignature(partialInput);
  const deviceSigBytes = await crypto.subtle.sign(
    { name: "Ed25519" } as EcdsaParams,
    devicePrivateKey,
    deviceSignBytes.buffer as ArrayBuffer,
  );
  const deviceSignature = bytesToHex(new Uint8Array(deviceSigBytes));

  // Step 3: build the full input with the device signature, then HMAC.
  const fullInput: GroupControlEnvelopeInput = {
    ...partialInput,
    deviceSignature,
  };
  const mac = await signEnvelope(fullInput, groupSecret);

  return {
    ...fullInput,
    mac,
  };
}

/**
 * Build a v3+ envelope when the caller has already computed the device
 * signature bytes directly. Used in tests and by callers that have
 * access to a pre-signed message they want to wrap.
 */
export async function buildEnvelopeWithDeviceSignature(
  input: Omit<GroupControlEnvelopeInput, "mac">,
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
 * Rejects on: wrong group, invalid MAC, invalid device signature,
 * oversized payload, invalid schema, duplicate ID, unsupported version.
 *
 * The caller must supply a devicePublicKey lookup function that
 * returns the verified base64url public key for a sender deviceId,
 * or null if the device is not yet known (which is permitted only
 * for the very first hello from that peer — and the caller is
 * responsible for gating on that flow).
 */
export async function validateEnvelope(
  envelope: unknown,
  expectedGroupId: string,
  groupSecret: string,
  dedupSet: DedupSet,
  devicePublicKeyLookup?: (
    senderDeviceId: string,
  ) => DevicePublicKeyLookup | null | Promise<DevicePublicKeyLookup | null>,
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

  // Payload size check (UTF-8 byte length, not string length)
  const payloadJson = JSON.stringify(data.payload);
  if (utf8ByteLength(payloadJson) > MAX_GROUP_CONTROL_PAYLOAD_BYTES) {
    return {
      ok: false,
      reason: `Payload exceeds maximum size of ${MAX_GROUP_CONTROL_PAYLOAD_BYTES} bytes`,
    };
  }

  // Duplicate ID check
  if (dedupSet.has(data.messageId)) {
    return { ok: false, reason: "Duplicate message ID" };
  }

  // Device signature verification (Gate 1.3 / 1.4)
  if (data.deviceSignature.length === 0) {
    return { ok: false, reason: "Missing device signature" };
  }
  if (devicePublicKeyLookup) {
    const pub = await devicePublicKeyLookup(data.senderDeviceId);
    if (pub) {
      const ok = await verifyEnvelopeDeviceSignature(
        data,
        pub.publicKey,
      );
      if (!ok) {
        return { ok: false, reason: "Invalid device signature" };
      }
    } else {
      // No public key yet — allow hello only, the connection
      // layer must reject the rest until pinned.
      if (data.type !== "group.hello") {
        return {
          ok: false,
          reason: "No pinned device public key for sender",
        };
      }
    }
  } else {
    return { ok: false, reason: "No device public key lookup supplied" };
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

// ─── Device signature helpers ──────────────────────────────────────────────

import {
  importDevicePublicKey,
  verifyBytes,
  type DevicePublicKey,
} from "./device-signing-key.js";

export interface DevicePublicKeyLookup {
  publicKey: DevicePublicKey;
}

/**
 * Verify the Ed25519 device signature on an envelope.
 * Reconstructs the canonical bytes exactly as `buildEnvelope` did.
 */
export async function verifyEnvelopeDeviceSignature(
  envelope: GroupControlEnvelope,
  publicKey: DevicePublicKey,
): Promise<boolean> {
  if (envelope.deviceSignature.length === 0) return false;
  const input: GroupControlEnvelopeInput = {
    version: envelope.version,
    type: envelope.type,
    messageId: envelope.messageId,
    sentAt: envelope.sentAt,
    senderDeviceId: envelope.senderDeviceId,
    groupId: envelope.groupId,
    logicalStamp: envelope.logicalStamp,
    payload: envelope.payload,
    deviceSignature: envelope.deviceSignature,
  };
  const data = serializeForDeviceSignature(input);
  const sigBytes = hexToBytes(envelope.deviceSignature);
  if (sigBytes.length === 0) return false;
  let key: CryptoKey;
  try {
    key = await importDevicePublicKey(publicKey);
  } catch {
    return false;
  }
  return await verifyBytes(key, sigBytes, data);
}

// ─── Per-Message Payload Schemas ──────────────────────────────────────────

export const GroupHelloPayloadSchema = z.object({
  deviceId: z.string(),
  displayName: z.string().min(1).max(100),
  protocolVersion: z.number().int().positive(),
  /** base64url-encoded 32-byte Ed25519 public key (optional during bootstrap, required after bootstrap). */
  publicKey: z.string().min(1).max(512).optional(),
});

export const GroupHelloResponsePayloadSchema = z.object({
  deviceId: z.string(),
  displayName: z.string().min(1).max(100),
  publicKey: z.string().min(1).max(512).optional(),
});

export const GroupStateUpdatePayloadSchema = z.object({
  state: z.record(z.unknown()),
  stamp: HybridTimestampSchema.optional(),
});

export const MemberVersionSchema = z.object({
  profileStamp: HybridTimestampSchema,
  displayName: z.string(),
});

export const GroupStateSummarySchema = z.object({
  nameStamp: HybridTimestampSchema.nullable().optional(),
  nameHash: z.string().nullable().optional(),
  qualityStamp: HybridTimestampSchema.nullable().optional(),
  qualityHash: z.string().nullable().optional(),
  memberVersions: z.record(z.string(), MemberVersionSchema).optional(),
  stateHash: z.string().optional(),
  groupId: z.string().optional(),
});

export const GroupStateSummaryPayloadSchema = z.object({
  summary: GroupStateSummarySchema,
});

export const GroupStateRequestPayloadSchema = z.object({
  type: z.literal("group.state.request").optional(),
});

export const GroupMemberUpdatePayloadSchema = z.object({
  member: z.object({
    deviceId: z.string(),
    displayName: z.string().min(1).max(100),
    firstSeenAt: z.number().int().positive(),
    profileStamp: HybridTimestampSchema,
    publicKey: z.string().min(1).max(512).optional(),
  }),
});

export const GroupPresencePayloadSchema = z.object({
  deviceId: z.string(),
  displayName: z.string().optional(),
  status: z.enum(["online", "away", "busy", "offline"]),
});

// ─── Stream payload schemas ────────────────────────────────────────────────

export const StreamStateRequestPayloadSchema = z.object({
  type: z.literal("stream.state.request").optional(),
});

export const StreamStateSnapshotPayloadSchema = z.object({
  streams: z.array(z.record(z.unknown())),
});

export const StreamStartedPayloadSchema = z.object({
  logicalStreamId: z.string(),
  mediaSessionId: z.string(),
  groupId: z.string(),
  hostDeviceId: z.string(),
  hostDisplayName: z.string(),
  sourceKind: z.string(),
  sourceName: z.string(),
  startedAt: z.number(),
  appliedSettingsRevision: z.number(),
  heartbeatSequence: z.number(),
  streamRevision: z.number(),
  mediaJoinMetadata: z.string(),
  replacesSessionId: z.string().nullable(),
  /** HLC stamp of the synchronized group settings applied at publication. */
  sharedSettingsRevision: z.string().optional(),
  /** HLC stamp of the live-applied group settings. */
  appliedLiveSettingsRevision: z.string().optional(),
  /** HLC stamp of the last restart-applied settings. */
  appliedRestartSettingsRevision: z.string().optional(),
  /** Wall-time the host asserts the lease is still valid through. */
  leaseValidUntil: z.number().optional(),
  isAudioDegraded: z.boolean().optional(),
});

export const StreamHeartbeatPayloadSchema = z.object({
  groupId: z.string(),
  hostDeviceId: z.string(),
  logicalStreamId: z.string(),
  mediaSessionId: z.string(),
  heartbeatSequence: z.number(),
  appliedSettingsRevision: z.number().optional(),
  /** Wall-time the host asserts the lease is still valid through. */
  leaseValidUntil: z.number().optional(),
  /** When the last heartbeat was actually sent. */
  lastHeartbeatAt: z.number().optional(),
});

export const StreamStoppedPayloadSchema = z.object({
  groupId: z.string(),
  hostDeviceId: z.string(),
  logicalStreamId: z.string(),
});

export const StreamRestartRequestPayloadSchema = z.object({
  commandId: z.string(),
  groupId: z.string(),
  /** HLC stamp the requesting device expects to apply. */
  targetSettingsStamp: z.string().optional(),
  /** Hash of the synchronized settings the requesting device expects to apply. */
  targetSettingsHash: z.string().optional(),
  requestedByDeviceId: z.string(),
  reason: z.string().optional(),
});

export const StreamRestartedPayloadSchema = z.object({
  logicalStreamId: z.string(),
  mediaSessionId: z.string(),
  groupId: z.string(),
  hostDeviceId: z.string(),
  hostDisplayName: z.string(),
  sourceKind: z.string(),
  sourceName: z.string(),
  startedAt: z.number(),
  appliedSettingsRevision: z.number(),
  heartbeatSequence: z.number(),
  streamRevision: z.number(),
  mediaJoinMetadata: z.string(),
  /** Links to the previous media session this restarted stream replaces. */
  previousMediaSessionId: z.string().optional(),
  /** Used by ActiveStreamRegistry.handleStarted to identify replacement entries.
   * Required non-empty string to trigger replacement logic; null means no prior session
   * (should not happen for restart, but schema allows it for forward compat). */
  replacesSessionId: z.string().nullable(),
  /** HLC stamp of the synchronized group settings applied at publication. */
  sharedSettingsRevision: z.string().optional(),
  /** HLC stamp of the live-applied group settings. */
  appliedLiveSettingsRevision: z.string().optional(),
  /** HLC stamp of the restart-applied settings. */
  appliedRestartSettingsRevision: z.string().optional(),
  /** HLC stamp the restart applied to. */
  appliedSettingsStamp: z.string().optional(),
  isAudioDegraded: z.boolean().optional(),
});

export const StreamRestartResultPayloadSchema = z.object({
  commandId: z.string(),
  groupId: z.string(),
  hostDeviceId: z.string(),
  logicalStreamId: z.string(),
  accepted: z.boolean(),
  success: z.boolean(),
  oldMediaSessionId: z.string().optional(),
  newMediaSessionId: z.string().optional(),
  appliedSettingsStamp: z.string().optional(),
  failureReason: z.string().optional(),
});

export const StreamJoinRequestPayloadSchema = z.object({
  logicalStreamId: z.string(),
  viewerDeviceId: z.string(),
  viewerDisplayName: z.string().optional(),
  requestId: z.string().optional(),
});

export const StreamJoinResponsePayloadSchema = z.object({
  logicalStreamId: z.string(),
  accepted: z.boolean(),
  mediaJoinMetadata: z.string().optional(),
  reason: z.string().optional(),
  viewerDeviceId: z.string(),
  requestId: z.string().optional(),
  mediaSessionId: z.string().optional(),
  /** VDO stream ID the viewer uses to call ViewerClient.view() */
  streamId: z.string().optional(),
  /** VDO password the viewer uses to call ViewerClient.createAndConnect() */
  password: z.string().optional(),
  /** Binding token for media.bind channel (same as mediaJoinMetadata, explicit) */
  bindingToken: z.string().optional(),
});

export const StreamBindAckPayloadSchema = z.object({
  logicalStreamId: z.string(),
  mediaSessionId: z.string(),
  viewerDeviceId: z.string(),
  accepted: z.boolean(),
  reason: z.string().optional(),
  /** Sanitized binding identifier (e.g. mediaPeerUuid). */
  boundMediaPeer: z.string().optional(),
});

export const StreamLeavePayloadSchema = z.object({
  logicalStreamId: z.string(),
  viewerDeviceId: z.string(),
});

// ─── Media bind payload schema ─────────────────────────────────────────────

export const MediaBindPayloadSchema = z.object({
  token: z.string(),
  viewerDeviceId: z.string().optional(),
  groupId: z.string().optional(),
  logicalStreamId: z.string().optional(),
  mediaSessionId: z.string().optional(),
});

// ─── Quality payload schemas ───────────────────────────────────────────────

export const QualityViewerRequestPayloadSchema = z.object({
  streamSessionId: z.string(),
  requestId: z.string(),
  revision: z.number().int().nonnegative(),
  videoBitrateKbps: z.number().int().nonnegative(),
  maxWidth: z.number().int().nonnegative(),
  maxHeight: z.number().int().nonnegative(),
  maxFps: z.number().int().nonnegative(),
  degradationPreference: z.string(),
});

export const QualityViewerClearPayloadSchema = z.object({
  streamSessionId: z.string(),
});

export const QualityEffectivePayloadSchema = z.object({
  streamSessionId: z.string(),
  videoBitrateKbps: z.number().optional(),
});

export const QualityConfiguredPayloadSchema = z.object({
  streamSessionId: z.string(),
  videoBitrateKbps: z.number().optional(),
});

export const QualityObservedPayloadSchema = z.object({
  streamSessionId: z.string(),
  videoBitrateKbps: z.number().optional(),
});

// ─── Ping / Pong ───────────────────────────────────────────────────────────

export const PingPayloadSchema = z.object({
  seq: z.number(),
});

export const PongPayloadSchema = z.object({
  seq: z.number(),
});

// ─── Payload Schema Map ────────────────────────────────────────────────────

/**
 * Type-level mapping from GroupControlMessageType to the inferred Zod output
 * type of its payload schema. Callers can use parseGroupMessagePayload with a
 * concrete literal type and get correctly typed data without casts.
 */
export type GroupControlPayloadMap = {
  "group.hello": z.infer<typeof GroupHelloPayloadSchema>;
  "group.hello.response": z.infer<typeof GroupHelloResponsePayloadSchema>;
  "group.state.summary": z.infer<typeof GroupStateSummaryPayloadSchema>;
  "group.state.request": z.infer<typeof GroupStateRequestPayloadSchema>;
  "group.state.update": z.infer<typeof GroupStateUpdatePayloadSchema>;
  "group.member.update": z.infer<typeof GroupMemberUpdatePayloadSchema>;
  "group.presence": z.infer<typeof GroupPresencePayloadSchema>;
  "stream.state.request": z.infer<typeof StreamStateRequestPayloadSchema>;
  "stream.state.snapshot": z.infer<typeof StreamStateSnapshotPayloadSchema>;
  "stream.started": z.infer<typeof StreamStartedPayloadSchema>;
  "stream.heartbeat": z.infer<typeof StreamHeartbeatPayloadSchema>;
  "stream.stopped": z.infer<typeof StreamStoppedPayloadSchema>;
  "stream.restart.request": z.infer<typeof StreamRestartRequestPayloadSchema>;
  "stream.restarted": z.infer<typeof StreamRestartedPayloadSchema>;
  "stream.restart.result": z.infer<typeof StreamRestartResultPayloadSchema>;
  "stream.join.request": z.infer<typeof StreamJoinRequestPayloadSchema>;
  "stream.join.response": z.infer<typeof StreamJoinResponsePayloadSchema>;
  "stream.bind.ack": z.infer<typeof StreamBindAckPayloadSchema>;
  "stream.leave": z.infer<typeof StreamLeavePayloadSchema>;
  "media.bind": z.infer<typeof MediaBindPayloadSchema>;
  "quality.viewer.request": z.infer<typeof QualityViewerRequestPayloadSchema>;
  "quality.viewer.clear": z.infer<typeof QualityViewerClearPayloadSchema>;
  "quality.effective": z.infer<typeof QualityEffectivePayloadSchema>;
  "quality.configured": z.infer<typeof QualityConfiguredPayloadSchema>;
  "quality.observed": z.infer<typeof QualityObservedPayloadSchema>;
  "ping": z.infer<typeof PingPayloadSchema>;
  "pong": z.infer<typeof PongPayloadSchema>;
};

const payloadSchemaMap: Record<string, z.ZodTypeAny> = {
  "group.hello": GroupHelloPayloadSchema,
  "group.hello.response": GroupHelloResponsePayloadSchema,
  "group.state.summary": GroupStateSummaryPayloadSchema,
  "group.state.request": GroupStateRequestPayloadSchema,
  "group.state.update": GroupStateUpdatePayloadSchema,
  "group.member.update": GroupMemberUpdatePayloadSchema,
  "group.presence": GroupPresencePayloadSchema,
  "stream.state.request": StreamStateRequestPayloadSchema,
  "stream.state.snapshot": StreamStateSnapshotPayloadSchema,
  "stream.started": StreamStartedPayloadSchema,
  "stream.heartbeat": StreamHeartbeatPayloadSchema,
  "stream.stopped": StreamStoppedPayloadSchema,
  "stream.restart.request": StreamRestartRequestPayloadSchema,
  "stream.restarted": StreamRestartedPayloadSchema,
  "stream.restart.result": StreamRestartResultPayloadSchema,
  "stream.join.request": StreamJoinRequestPayloadSchema,
  "stream.join.response": StreamJoinResponsePayloadSchema,
  "stream.bind.ack": StreamBindAckPayloadSchema,
  "stream.leave": StreamLeavePayloadSchema,
  "media.bind": MediaBindPayloadSchema,
  "quality.viewer.request": QualityViewerRequestPayloadSchema,
  "quality.viewer.clear": QualityViewerClearPayloadSchema,
  "quality.effective": QualityEffectivePayloadSchema,
  "quality.configured": QualityConfiguredPayloadSchema,
  "quality.observed": QualityObservedPayloadSchema,
  "ping": PingPayloadSchema,
  "pong": PongPayloadSchema,
};

/**
 * Parse a group control message payload against the schema for the given type.
 * The return type is correctly inferred via GroupControlPayloadMap, so callers
 * get typed data without needing `as` casts.
 *
 * @example
 *   const parsed = parseGroupMessagePayload("group.member.update", raw);
 *   if (parsed.ok) {
 *     parsed.data.member // typed as GroupMemberUpdatePayloadSchema output
 *   }
 */
export function parseGroupMessagePayload<T extends GroupControlMessageType>(
  type: T,
  payload: unknown,
): { ok: true; data: GroupControlPayloadMap[T] } | { ok: false; reason: string } {
  const schema = payloadSchemaMap[type];
  if (!schema) {
    return { ok: false, reason: `Unknown message type: ${type}` };
  }
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "Payload must be a non-null object" };
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    return { ok: false, reason: `Invalid payload: ${result.error.message}` };
  }
  return { ok: true, data: result.data as GroupControlPayloadMap[T] };
}

// ─── DedupSet ──────────────────────────────────────────────────────────────

/**
 * A bounded deduplication set that tracks message IDs within a time window.
 * Automatically evicts entries older than the window.
 */
export class DedupSet {
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly entries: Map<string, number> = new Map();
  /** Queue of entry insertion order for LRU eviction */
  private insertionOrder: string[] = [];

  constructor(
    windowMs: number = DEDUP_WINDOW_MS,
    maxEntries: number = DEDUP_MAX_ENTRIES,
  ) {
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
  }

  has(id: string): boolean {
    this.evict();
    return this.entries.has(id);
  }

  add(id: string): void {
    this.evict();
    this.entries.set(id, Date.now());
    this.insertionOrder.push(id);
    // Enforce max count bound — evict oldest when over limit
    if (this.entries.size > this.maxEntries) {
      const toEvict = this.entries.size - this.maxEntries;
      for (let i = 0; i < toEvict && this.insertionOrder.length > 0; i++) {
        const oldestId = this.insertionOrder.shift()!;
        this.entries.delete(oldestId);
      }
    }
  }

  size(): number {
    this.evict();
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.insertionOrder = [];
  }

  private evict(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [id, addedAt] of this.entries) {
      if (addedAt < cutoff) {
        this.entries.delete(id);
        // Also remove from insertion order (O(n) but eviction is a background op)
        const idx = this.insertionOrder.indexOf(id);
        if (idx !== -1) this.insertionOrder.splice(idx, 1);
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

/**
 * Public bytesToHex — used by callers that have raw bytes (e.g. a
 * freshly-computed device signature) and need to encode them into the
 * envelope's hex field.
 */
export { bytesToHex };

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
