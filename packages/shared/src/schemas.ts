import { z } from "zod";

// ─── Basic types ───────────────────────────────────────────────────────────

export const ShareIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/).min(10);
export const TokenSchema = z.string().regex(/^[A-Za-z0-9_-]+$/).min(20);
export const SessionIdSchema = z.string().uuid();
export const DisplayNameSchema = z.string().min(1).max(100);

// ─── Capture info ──────────────────────────────────────────────────────────

export const CaptureInfoSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().int().positive(),
  systemAudio: z.boolean(),
  contentHint: z.enum(["detail", "motion"]),
});

// ─── Policy ────────────────────────────────────────────────────────────────

export const PolicySchema = z.object({
  allowViewerGlobalChanges: z.boolean(),
  allowViewerSystemAudioChanges: z.boolean(),
  maxVideoCeilingPerViewerKbps: z.number().int().positive(),
  maxConfiguredMediaBudgetKbps: z.number().int().positive(),
  maxCaptureWidth: z.number().int().positive(),
  maxCaptureHeight: z.number().int().positive(),
  maxCaptureFps: z.number().int().positive(),
  allowedCodecs: z.array(z.enum(["h264", "vp8", "vp9", "av1", "h265"])),
});

// ─── Provisioning ──────────────────────────────────────────────────────────

export const ProvisionShareRequestSchema = z.object({
  shareId: ShareIdSchema,
  hostToken: TokenSchema,
  viewerToken: TokenSchema,
  displayName: DisplayNameSchema,
});

// ─── Session ───────────────────────────────────────────────────────────────

export const StartSessionRequestSchema = z.object({
  sessionId: SessionIdSchema,
  streamId: z.string().min(1).max(64),
  password: z.string().min(1),
  startedAt: z.number().positive(),
  capture: CaptureInfoSchema,
  policy: PolicySchema,
});

export const SessionResponseSchema = z.object({
  version: z.literal(1),
  requestId: z.string().uuid(),
  status: z.enum(["online", "offline"]),
  serverTime: z.number().positive(),
  session: z
    .object({
      generation: z.number().int().positive(),
      sessionId: z.string().uuid(),
      streamId: z.string(),
      password: z.string(),
      startedAt: z.number().positive(),
      expiresAt: z.number().positive(),
      hostName: z.string(),
      capture: CaptureInfoSchema,
      policy: PolicySchema,
    })
    .optional(),
  retryAfterMs: z.number().positive().optional(),
});

export const HeartbeatRequestSchema = z.object({
  sessionId: z.string().uuid(),
  generation: z.number().int().positive(),
});

export const ErrorResponseSchema = z.object({
  version: z.literal(1),
  requestId: z.string().uuid(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// ─── Health ────────────────────────────────────────────────────────────────

export const HealthResponseSchema = z.object({
  version: z.literal(1),
  requestId: z.string().uuid(),
  status: z.literal("ok"),
  serverTime: z.number().positive(),
});

// ─── Viewers ───────────────────────────────────────────────────────────────

export const ViewerCapabilitiesSchema = z.object({
  videoCodecs: z.array(z.string()),
  supportsSenderParameters: z.boolean(),
  supportsPictureInPicture: z.boolean(),
});

export const FriendSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().min(1).max(100),
  note: z.string().max(500).default(""),
  preferredPresetId: z.string(),
  createdAt: z.number().positive(),
  updatedAt: z.number().positive(),
});

export const DisplayFingerprintSchema = z.object({
  displayId: z.string(),
  label: z.string(),
  bounds: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }),
  size: z.object({
    width: z.number(),
    height: z.number(),
  }),
  scaleFactor: z.number(),
  internal: z.boolean(),
});

// ─── Re-exports for convenience ────────────────────────────────────────────

export type ShareId = z.infer<typeof ShareIdSchema>;
export type Token = z.infer<typeof TokenSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type DisplayName = z.infer<typeof DisplayNameSchema>;
export type CaptureInfo = z.infer<typeof CaptureInfoSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type ProvisionShareRequest = z.infer<typeof ProvisionShareRequestSchema>;
export type StartSessionRequest = z.infer<typeof StartSessionRequestSchema>;
export type SessionResponse = z.infer<typeof SessionResponseSchema>;
export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type ViewerCapabilities = z.infer<typeof ViewerCapabilitiesSchema>;
export type Friend = z.infer<typeof FriendSchema>;
export type DisplayFingerprint = z.infer<typeof DisplayFingerprintSchema>;
