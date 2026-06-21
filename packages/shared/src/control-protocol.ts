import { z } from "zod";

// ─── Constants ─────────────────────────────────────────────────────────────

export const CONTROL_MESSAGE_TYPES = [
  "viewer.hello",
  "host.hello",
  "quality.request",
  "quality.applied",
  "quality.rejected",
  "quality.current",
  "policy.updated",
  "global-change.started",
  "global-change.completed",
  "global-change.failed",
  "host.stopping",
  "ping",
  "pong",
] as const;

export type ControlMessageType = (typeof CONTROL_MESSAGE_TYPES)[number];

export const MAX_CONTROL_PAYLOAD_SIZE = 16 * 1024; // 16 KiB
export const MAX_TIMESTAMP_AGE_MS = 60_000; // 1 minute
export const DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
export const QUALITY_REQUEST_INTERVAL_MS = 2_000; // 2 seconds
export const QUALITY_REQUEST_MAX_PER_MINUTE = 10;
export const GLOBAL_REQUEST_INTERVAL_MS = 10_000; // 10 seconds

// ─── Payload interfaces ────────────────────────────────────────────────────

export interface ViewerHelloPayload {
  viewerId: string;
  name: string;
  requestedPresetId: string;
  capabilities: {
    videoCodecs: string[];
    supportsSenderParameters: boolean;
    supportsPictureInPicture: boolean;
  };
}

export interface HostHelloPayload {
  hostName: string;
  capture: {
    width: number;
    height: number;
    fps: number;
    systemAudio: boolean;
    contentHint: "detail" | "motion";
  };
  policy: Record<string, unknown>;
}

export interface QualityRequestPayload {
  requestId: string;
  perViewer: {
    videoCeilingKbps: number;
    maxFps: number;
    targetWidth: number;
    targetHeight: number;
    receiveAudio: boolean;
    degradationPreference: string;
  };
  global: Record<string, unknown> | null;
}

export interface QualityCurrentPayload {
  requestId: string;
  perViewer: {
    videoCeilingKbps: number;
    maxFps: number;
    targetWidth: number;
    targetHeight: number;
    receiveAudio: boolean;
    degradationPreference: string;
  };
  global: Record<string, unknown> | null;
}

export interface QualityAppliedPayload {
  requestId: string;
}

export interface QualityRejectedPayload {
  requestId: string;
  reason: string;
}

export interface PolicyUpdatedPayload {
  policy: Record<string, unknown>;
}

export interface GlobalChangeStartedPayload {
  requestId: string;
  type: string;
}

export interface GlobalChangeCompletedPayload {
  requestId: string;
}

export interface GlobalChangeFailedPayload {
  requestId: string;
  reason: string;
}

export interface HostStoppingPayload {
  reason: string;
}

export interface PingPayload {
  seq: number;
}

export interface PongPayload {
  seq: number;
}

// ─── Control Envelope ─────────────────────────────────────────────────────

export interface ControlEnvelope {
  screenlink: {
    version: 1;
    type: ControlMessageType;
    messageId: string;
    sentAt: number;
    payload: Record<string, unknown>;
  };
}

// ─── Zod Schemas ───────────────────────────────────────────────────────────

export const ViewerHelloPayloadSchema = z.object({
  viewerId: z.string().uuid(),
  name: z.string().min(1).max(100),
  requestedPresetId: z.string(),
  capabilities: z.object({
    videoCodecs: z.array(z.string()),
    supportsSenderParameters: z.boolean(),
    supportsPictureInPicture: z.boolean(),
  }),
});

export const HostHelloPayloadSchema = z.object({
  hostName: z.string().min(1).max(100),
  capture: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
    systemAudio: z.boolean(),
    contentHint: z.enum(["detail", "motion"]),
  }),
  policy: z.record(z.unknown()),
});

export const QualityRequestPayloadSchema = z.object({
  requestId: z.string().uuid(),
  perViewer: z.object({
    videoCeilingKbps: z.number().int().positive(),
    maxFps: z.number().int().positive(),
    targetWidth: z.number().int().positive(),
    targetHeight: z.number().int().positive(),
    receiveAudio: z.boolean(),
    degradationPreference: z.string(),
  }),
  global: z.record(z.unknown()).nullable(),
});

export const QualityCurrentPayloadSchema = z.object({
  requestId: z.string().uuid(),
  perViewer: z.object({
    videoCeilingKbps: z.number().int().positive(),
    maxFps: z.number().int().positive(),
    targetWidth: z.number().int().positive(),
    targetHeight: z.number().int().positive(),
    receiveAudio: z.boolean(),
    degradationPreference: z.string(),
  }),
  global: z.record(z.unknown()).nullable(),
});

export const QualityAppliedPayloadSchema = z.object({
  requestId: z.string().uuid(),
});

export const QualityRejectedPayloadSchema = z.object({
  requestId: z.string().uuid(),
  reason: z.string(),
});

export const PolicyUpdatedPayloadSchema = z.object({
  policy: z.record(z.unknown()),
});

export const GlobalChangeStartedPayloadSchema = z.object({
  requestId: z.string().uuid(),
  type: z.string(),
});

export const GlobalChangeCompletedPayloadSchema = z.object({
  requestId: z.string().uuid(),
});

export const GlobalChangeFailedPayloadSchema = z.object({
  requestId: z.string().uuid(),
  reason: z.string(),
});

export const HostStoppingPayloadSchema = z.object({
  reason: z.string(),
});

export const PingPayloadSchema = z.object({
  seq: z.number().int().nonnegative(),
});

export const PongPayloadSchema = z.object({
  seq: z.number().int().nonnegative(),
});

// ─── Envelope Schema ───────────────────────────────────────────────────────

export const ControlEnvelopeSchema: z.ZodType<ControlEnvelope> = z.object({
  screenlink: z.object({
    version: z.literal(1),
    type: z.enum(CONTROL_MESSAGE_TYPES),
    messageId: z.string().uuid(),
    sentAt: z.number().positive(),
    payload: z.record(z.unknown()),
  }),
});

// ─── Validator helper ──────────────────────────────────────────────────────

/**
 * Parse and validate a control message payload against the schema
 * corresponding to the given message type.
 */
export function validateControlPayload(
  type: ControlMessageType,
  payload: unknown,
): Record<string, unknown> | null {
  const schemas: Record<string, z.ZodSchema> = {
    "viewer.hello": ViewerHelloPayloadSchema,
    "host.hello": HostHelloPayloadSchema,
    "quality.request": QualityRequestPayloadSchema,
    "quality.applied": QualityAppliedPayloadSchema,
    "quality.rejected": QualityRejectedPayloadSchema,
    "quality.current": QualityCurrentPayloadSchema,
    "policy.updated": PolicyUpdatedPayloadSchema,
    "global-change.started": GlobalChangeStartedPayloadSchema,
    "global-change.completed": GlobalChangeCompletedPayloadSchema,
    "global-change.failed": GlobalChangeFailedPayloadSchema,
    "host.stopping": HostStoppingPayloadSchema,
    ping: PingPayloadSchema,
    pong: PongPayloadSchema,
  };

  const schema = schemas[type];
  if (!schema) return null;

  const result = schema.safeParse(payload);
  return result.success ? (result.data as Record<string, unknown>) : null;
}

// ─── Type exports ──────────────────────────────────────────────────────────

export type ViewerHelloPayloadParsed = z.infer<typeof ViewerHelloPayloadSchema>;
export type HostHelloPayloadParsed = z.infer<typeof HostHelloPayloadSchema>;
export type QualityRequestPayloadParsed = z.infer<typeof QualityRequestPayloadSchema>;
export type QualityCurrentPayloadParsed = z.infer<typeof QualityCurrentPayloadSchema>;
export type QualityAppliedPayloadParsed = z.infer<typeof QualityAppliedPayloadSchema>;
export type QualityRejectedPayloadParsed = z.infer<typeof QualityRejectedPayloadSchema>;
export type PolicyUpdatedPayloadParsed = z.infer<typeof PolicyUpdatedPayloadSchema>;
export type GlobalChangeStartedPayloadParsed = z.infer<typeof GlobalChangeStartedPayloadSchema>;
export type GlobalChangeCompletedPayloadParsed = z.infer<typeof GlobalChangeCompletedPayloadSchema>;
export type GlobalChangeFailedPayloadParsed = z.infer<typeof GlobalChangeFailedPayloadSchema>;
export type HostStoppingPayloadParsed = z.infer<typeof HostStoppingPayloadSchema>;
export type PingPayloadParsed = z.infer<typeof PingPayloadSchema>;
export type PongPayloadParsed = z.infer<typeof PongPayloadSchema>;
export type ControlEnvelopeParsed = z.infer<typeof ControlEnvelopeSchema>;
