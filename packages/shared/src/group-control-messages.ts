import { z } from "zod";
import type { HybridTimestamp } from "./hybrid-logical-clock.js";
import { HybridTimestampSchema } from "./hybrid-logical-clock.js";
import {
  CompareVariantIdSchema,
  CompareModeSchema,
  CompareConfigSnapshotSchema,
  VariantDescriptorSchema,
} from "./compare-config.js";

// ─── Constants ─────────────────────────────────────────────────────────────

export const GROUP_PROTOCOL_VERSION = 3;

export const GROUP_CONTROL_MESSAGE_TYPES = [
  "group.hello",
  "group.hello.response",
  "group.state.summary",
  "group.state.request",
  "group.state.update",
  "group.member.update",
  "group.member.joined",
  "group.member.online",
  "group.presence",
  "stream.state.request",
  "stream.state.snapshot",
  "stream.started",
  "stream.heartbeat",
  "stream.stopped",
  "stream.restart.request",
  "stream.restarted",
  "stream.restart.result",
  "stream.sourceChanged",
  "stream.join.request",
  "stream.join.response",
  "stream.bind.ack",
  "stream.leave",
  "viewer.paused",
  "viewer.status",
  "media.bind",
  "quality.viewer.request",
  "quality.viewer.clear",
  "quality.effective",
  "quality.configured",
  "quality.observed",
  "compare.variant.updated",
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

/**
 * Authenticated control envelope. Trust model:
 *
 *   - Group membership is proven by knowledge of the group secret (HMAC).
 *   - Device IDs are stable routing and display identifiers, not
 *     cryptographic identities.
 *   - The connection layer enforces peer-UUID → device-ID mapping
 *     invariants (reject remap, reject duplicate online claim).
 */
export interface GroupControlEnvelope {
  version: number;
  type: GroupControlMessageType;
  messageId: string;
  sentAt: number;
  senderDeviceId: string;
  groupId: string;
  logicalStamp: HybridTimestamp;
  payload: Record<string, unknown>;
  mac: string; // HMAC-SHA256 over canonical bytes, hex-encoded
}

/**
 * Input form used to build an envelope. Identical to the envelope
 * except it has no MAC field yet.
 */
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
 * Compute an HMAC-SHA256 signature for an envelope input. Returns
 * the hex-encoded signature.
 */
export async function signEnvelope(
  input: GroupControlEnvelopeInput,
  groupSecret: string,
): Promise<string> {
  const key = await deriveMacKey(groupSecret);
  const data = serializeForMac(input);
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

/**
 * Serialize an envelope input for HMAC signing — canonical JSON of
 * all fields except `mac`.
 */
export function serializeForMac(input: GroupControlEnvelopeInput): Uint8Array {
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
 * Build a fully signed GroupControlEnvelope from an unsigned input.
 *
 * Trust model: anyone with the group secret is a trusted member. The
 * HMAC binds the entire envelope body to the group; no additional
 * device signature is required.
 */
export async function buildEnvelope(
  input: GroupControlEnvelopeInput,
  groupSecret: string,
): Promise<GroupControlEnvelope> {
  const mac = await signEnvelope(input, groupSecret);
  return { ...input, mac };
}

/**
 * Validate a GroupControlEnvelope.
 *
 * Validation order:
 *   1. Parse envelope schema.
 *   2. Verify protocol version.
 *   3. Verify expected group ID.
 *   4. Verify UTF-8 payload size.
 *   5. Verify HMAC using group secret.
 *   6. Verify message deduplication.
 *
 * On success, registers the message ID in the dedup set. The caller
 * (GroupControlConnection) is responsible for peer-UUID → device-ID
 * mapping enforcement on top of this cryptographic layer.
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

  // HMAC verification
  const macValid = await verifyEnvelope(data, groupSecret);
  if (!macValid) {
    return { ok: false, reason: "Invalid MAC" };
  }

  // Register in dedup set
  dedupSet.add(data.messageId);

  return { ok: true, data };
}

// ─── Per-Message Payload Schemas ──────────────────────────────────────────

export const GroupHelloPayloadSchema = z.object({
  deviceId: z.string(),
  displayName: z.string().min(1).max(100),
  protocolVersion: z.number().int().positive(),
  /** Complete durable GroupMemberRecord for immediate member merge. */
  member: z.object({
    deviceId: z.string(),
    displayName: z.string().min(1).max(100),
    firstSeenAt: z.number().int().positive(),
    profileStamp: HybridTimestampSchema,
  }).optional(),
}).strict();

export const GroupHelloResponsePayloadSchema = z.object({
  deviceId: z.string(),
  displayName: z.string().min(1).max(100),
  protocolVersion: z.number().int().positive(),
  /** Complete durable GroupMemberRecord for immediate member merge. */
  member: z.object({
    deviceId: z.string(),
    displayName: z.string().min(1).max(100),
    firstSeenAt: z.number().int().positive(),
    profileStamp: HybridTimestampSchema,
  }).optional(),
}).strict();

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
  }).strict(),
}).strict();

export const GroupMemberJoinedPayloadSchema = z.object({
  memberDeviceId: z.string(),
  memberDisplayName: z.string(),
  joinedAt: z.number(),
  groupId: z.string(),
}).strict();

export const GroupMemberOnlinePayloadSchema = z.object({
  memberDeviceId: z.string(),
  memberDisplayName: z.string(),
  onlineAt: z.number(),
  groupId: z.string(),
}).strict();

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
  /** Compare mode when this stream is part of an Easy Compare session. */
  compareMode: CompareModeSchema.optional(),
  /** Compare protocol version number. */
  compareVersion: z.number().int().positive().optional(),
  /** Which variant is the primary (backward-compatible) stream. */
  primaryVariant: CompareVariantIdSchema.optional(),
  /** Descriptor for variant A (may be the same as the primary stream). */
  variantADescriptor: VariantDescriptorSchema.optional(),
  /** Descriptor for variant B (the secondary compare stream). */
  variantBDescriptor: VariantDescriptorSchema.optional(),
  /** Transport-safe config snapshot applied to the compare session. */
  appliedConfigSnapshot: CompareConfigSnapshotSchema.optional(),
  /** Revision number of the applied compare configuration. */
  appliedCompareRevision: z.number().int().nonnegative().optional(),
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

export const StreamSourceChangedPayloadSchema = z.object({
  logicalStreamId: z.string(),
  mediaSessionId: z.string(),
  sourceKind: z.string(),
  sourceName: z.string(),
});

export const StreamJoinRequestPayloadSchema = z.object({
  logicalStreamId: z.string(),
  viewerDeviceId: z.string(),
  viewerDisplayName: z.string().optional(),
  requestId: z.string().optional(),
  /**
   * Per-attempt session ID generated by the viewer for every Watch attempt.
   * Optional for backward compatibility with older viewers; when present the
   * host uses it to disambiguate join requests and ignore stale leaves.
   */
  viewerSessionId: z.string().optional(),
  /**
   * Compare variant ID the viewer wants to join ("A" or "B").
   * When present the host routes the viewer to the correct media session.
   */
  compareVariantId: CompareVariantIdSchema.optional(),
  /**
   * Exact media session ID the viewer intends to join.
   * Used together with compareVariantId for disambiguation in compare mode.
   */
  mediaSessionId: z.string().optional(),
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
  /**
   * Echo of the viewer's per-attempt session ID so the viewer can correlate
   * the response with its own state. Optional for backward compatibility.
   */
  viewerSessionId: z.string().optional(),
  /**
   * Compare variant ID this join response is for ("A" or "B").
   * Present when the viewer requested a specific compare variant.
   */
  compareVariantId: CompareVariantIdSchema.optional(),
});

export const StreamBindAckPayloadSchema = z.object({
  logicalStreamId: z.string(),
  mediaSessionId: z.string(),
  viewerDeviceId: z.string(),
  hostDeviceId: z.string().optional(),
  accepted: z.boolean(),
  reason: z.string().optional(),
  /** Sanitized binding identifier (e.g. mediaPeerUuid). */
  boundMediaPeer: z.string().optional(),
  /** Echo of viewer's per-attempt session ID for ack correlation. */
  viewerSessionId: z.string().optional(),
  /** Compare variant ID this bind ack is for ("A" or "B"). */
  compareVariantId: CompareVariantIdSchema.optional(),
});

export const StreamLeavePayloadSchema = z.object({
  logicalStreamId: z.string(),
  viewerDeviceId: z.string(),
  /**
   * Per-attempt session ID. When present, the host only removes the mapping
   * if this matches the active viewerSessionId for the device, preventing a
   * delayed leave from a prior Watch attempt from clobbering a newer join.
   * Optional for backward compatibility.
   */
  viewerSessionId: z.string().optional(),
  /**
   * Exact media session ID the viewer is leaving.
   * Present in compare mode to disambiguate which session the leave targets.
   */
  mediaSessionId: z.string().optional(),
  /**
   * Compare variant ID the viewer is leaving ("A" or "B").
   * Present when the viewer joined a specific compare variant.
   */
  compareVariantId: CompareVariantIdSchema.optional(),
});

// ─── Viewer paused payload schema ───────────────────────────────────────────

export const ViewerPausedPayloadSchema = z.object({
  logicalStreamId: z.string(),
  viewerDeviceId: z.string(),
  /** Per-attempt session ID so the host can correlate with the join mapping. */
  viewerSessionId: z.string().optional(),
  /** True when paused, false when resumed. */
  paused: z.boolean(),
  /** Exact media session ID for correlation in compare mode. */
  mediaSessionId: z.string().optional(),
  /** Compare variant ID ("A" or "B") this pause event relates to. */
  compareVariantId: CompareVariantIdSchema.optional(),
}).strict();

// ─── Viewer status payload schema ────────────────────────────────────────────

export const ViewerStatusPayloadSchema = z.object({
  viewerDeviceId: z.string(),
  streamId: z.string(),
  state: z.enum(["playing", "paused", "reconnecting"]),
  viewerDisplayName: z.string().optional(),
  receivedBitrateKbps: z.number().nullable(),
  receivedWidth: z.number().nullable(),
  receivedHeight: z.number().nullable(),
  displayedFps: z.number().nullable(),
  sampledAt: z.number(),
  /** Exact media session ID for correlation in compare mode. */
  mediaSessionId: z.string().optional(),
  /** Compare variant ID ("A" or "B") this status update relates to. */
  compareVariantId: CompareVariantIdSchema.optional(),
});

// ─── Compare variant updated payload schema ─────────────────────────────────

export const CompareVariantUpdatedPayloadSchema = z.object({
  /** Logical stream ID this variant belongs to. */
  logicalStreamId: z.string(),
  /** The media session ID for this variant's stream. */
  mediaSessionId: z.string(),
  /** Variant ID ("A" or "B") that was updated. */
  variantId: CompareVariantIdSchema,
  /** Monotonically increasing revision number of the variant config. */
  revision: z.number().int().nonnegative(),
  /** Transport-safe configuration snapshot applied to this variant. */
  configSnapshot: CompareConfigSnapshotSchema,
  /** Wall-clock timestamp when the config was applied. */
  appliedAt: z.number().int().positive(),
  /** Optional status indicator (e.g. "active", "inactive", "degraded"). */
  status: z.string().optional(),
}).strict();

// ─── Media bind payload schema ─────────────────────────────────────────────

export const MediaBindPayloadSchema = z.object({
  token: z.string(),
  viewerDeviceId: z.string().optional(),
  groupId: z.string().optional(),
  logicalStreamId: z.string().optional(),
  mediaSessionId: z.string().optional(),
  /**
   * Per-attempt session ID propagated through the bind handshake so the host
   * can correlate the bind with the join request.
   */
  viewerSessionId: z.string().optional(),
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
  maxWidth: z.number().optional(),
  maxHeight: z.number().optional(),
  maxFps: z.number().optional(),
  degradationPreference: z.string().optional(),
  clampReasons: z.array(z.string()).optional(),
});

export const QualityConfiguredPayloadSchema = z.object({
  streamSessionId: z.string(),
  videoBitrateKbps: z.number().optional(),
  maxFramerate: z.number().optional(),
  scaleResolutionDownBy: z.number().optional(),
  degradationPreference: z.string().optional(),
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
  "group.member.joined": z.infer<typeof GroupMemberJoinedPayloadSchema>;
  "group.member.online": z.infer<typeof GroupMemberOnlinePayloadSchema>;
  "group.presence": z.infer<typeof GroupPresencePayloadSchema>;
  "stream.state.request": z.infer<typeof StreamStateRequestPayloadSchema>;
  "stream.state.snapshot": z.infer<typeof StreamStateSnapshotPayloadSchema>;
  "stream.started": z.infer<typeof StreamStartedPayloadSchema>;
  "stream.heartbeat": z.infer<typeof StreamHeartbeatPayloadSchema>;
  "stream.stopped": z.infer<typeof StreamStoppedPayloadSchema>;
  "stream.restart.request": z.infer<typeof StreamRestartRequestPayloadSchema>;
  "stream.restarted": z.infer<typeof StreamRestartedPayloadSchema>;
  "stream.restart.result": z.infer<typeof StreamRestartResultPayloadSchema>;
  "stream.sourceChanged": z.infer<typeof StreamSourceChangedPayloadSchema>;
  "stream.join.request": z.infer<typeof StreamJoinRequestPayloadSchema>;
  "stream.join.response": z.infer<typeof StreamJoinResponsePayloadSchema>;
  "stream.bind.ack": z.infer<typeof StreamBindAckPayloadSchema>;
  "stream.leave": z.infer<typeof StreamLeavePayloadSchema>;
  "media.bind": z.infer<typeof MediaBindPayloadSchema>;
  "viewer.paused": z.infer<typeof ViewerPausedPayloadSchema>;
  "viewer.status": z.infer<typeof ViewerStatusPayloadSchema>;
  "compare.variant.updated": z.infer<typeof CompareVariantUpdatedPayloadSchema>;
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
  "group.member.joined": GroupMemberJoinedPayloadSchema,
  "group.member.online": GroupMemberOnlinePayloadSchema,
  "group.presence": GroupPresencePayloadSchema,
  "stream.state.request": StreamStateRequestPayloadSchema,
  "stream.state.snapshot": StreamStateSnapshotPayloadSchema,
  "stream.started": StreamStartedPayloadSchema,
  "stream.heartbeat": StreamHeartbeatPayloadSchema,
  "stream.stopped": StreamStoppedPayloadSchema,
  "stream.restart.request": StreamRestartRequestPayloadSchema,
  "stream.restarted": StreamRestartedPayloadSchema,
  "stream.restart.result": StreamRestartResultPayloadSchema,
  "stream.sourceChanged": StreamSourceChangedPayloadSchema,
  "stream.join.request": StreamJoinRequestPayloadSchema,
  "stream.join.response": StreamJoinResponsePayloadSchema,
  "stream.bind.ack": StreamBindAckPayloadSchema,
  "stream.leave": StreamLeavePayloadSchema,
  "media.bind": MediaBindPayloadSchema,
  "viewer.paused": ViewerPausedPayloadSchema,
  "viewer.status": ViewerStatusPayloadSchema,
  "compare.variant.updated": CompareVariantUpdatedPayloadSchema,
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
 * freshly-computed signature) and need to encode them into the
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
