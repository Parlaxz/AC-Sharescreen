import { z } from "zod";

export const CONTROL_PROTOCOL_VERSION = 1;
export const MAX_CONTROL_PAYLOAD_BYTES = 16 * 1024; // 16 KiB
export const MAX_TIMESTAMP_AGE_MS = 60_000;
export const DEDUP_WINDOW_MS = 10 * 60 * 1000;

export type ControlMessageType =
  | "peer.hello"
  | "peer.hello.response"
  | "state.request"
  | "state.response"
  | "share.started"
  | "share.updated"
  | "share.stopped"
  | "quality.request"
  | "quality.applied"
  | "quality.rejected"
  | "ping"
  | "pong";

export interface ControlEnvelope {
  screenlink: {
    version: 1;
    type: ControlMessageType;
    messageId: string;
    sentAt: number;
    senderDeviceId: string;
    payload: Record<string, unknown>;
  };
}

export const ControlEnvelopeSchema = z.object({
  screenlink: z.object({
    version: z.literal(1),
    type: z.enum([
      "peer.hello", "peer.hello.response", "state.request", "state.response",
      "share.started", "share.updated", "share.stopped",
      "quality.request", "quality.applied", "quality.rejected",
      "ping", "pong",
    ]),
    messageId: z.string().uuid(),
    sentAt: z.number(),
    senderDeviceId: z.string().uuid(),
    payload: z.record(z.unknown()),
  }),
});

export function generateMessageId(): string {
  return crypto.randomUUID();
}

export function buildEnvelope(
  type: ControlMessageType,
  senderDeviceId: string,
  payload: Record<string, unknown> = {},
): ControlEnvelope {
  return {
    screenlink: {
      version: 1,
      type,
      messageId: generateMessageId(),
      sentAt: Date.now(),
      senderDeviceId,
      payload,
    },
  };
}

export function validateEnvelopeTimestamp(envelope: ControlEnvelope): boolean {
  const age = Date.now() - envelope.screenlink.sentAt;
  return Math.abs(age) <= MAX_TIMESTAMP_AGE_MS;
}

export function isDuplicateMessage(
  seen: Set<string>,
  envelope: ControlEnvelope,
): boolean {
  return seen.has(envelope.screenlink.messageId);
}

// ── Payload Schemas ────────────────────────────────────────────

export const PeerHelloPayloadSchema = z.object({
  deviceId: z.string().uuid(),
  displayName: z.string().min(1).max(100),
  protocolVersion: z.literal(1),
  appVersion: z.string(),
  capabilities: z.object({
    maxBitrateKbps: z.number().optional(),
    supportedCodecs: z.array(z.string()).optional(),
  }).optional(),
  isCurrentlySharing: z.boolean().default(false),
});

export const StateResponsePayloadSchema = z.object({
  isSharing: z.boolean(),
  mediaSessionId: z.string().uuid().optional(),
  streamId: z.string().optional(),
  mediaPassword: z.string().optional(),
  captureWidth: z.number().optional(),
  captureHeight: z.number().optional(),
  captureFps: z.number().optional(),
  actualWidth: z.number().optional(),
  actualHeight: z.number().optional(),
  actualFps: z.number().optional(),
  systemAudio: z.boolean().optional(),
  contentHint: z.string().optional(),
  codec: z.string().optional(),
  startedAt: z.number().optional(),
});

export const ShareStartedPayloadSchema = z.object({
  mediaSessionId: z.string().uuid(),
  streamId: z.string(),
  mediaPassword: z.string(),
  captureWidth: z.number(),
  captureHeight: z.number(),
  captureFps: z.number(),
  systemAudio: z.boolean(),
  contentHint: z.string(),
  codec: z.string().optional(),
});

export const ShareStoppedPayloadSchema = z.object({
  mediaSessionId: z.string().uuid(),
});

export const QualityRequestPayloadSchema = z.object({
  requestId: z.string().uuid(),
  videoCeilingKbps: z.number().positive().optional(),
  maxFps: z.number().positive().optional(),
  targetWidth: z.number().positive().optional(),
  targetHeight: z.number().positive().optional(),
  receiveAudio: z.boolean().optional(),
  degradationPreference: z.string().optional(),
  global: z.object({
    captureWidth: z.number().optional(),
    captureHeight: z.number().optional(),
    captureFps: z.number().optional(),
    codec: z.string().optional(),
    systemAudio: z.boolean().optional(),
    contentHint: z.string().optional(),
  }).nullable().optional(),
});
