import { z } from "zod";
import type { HybridTimestamp } from "./hybrid-logical-clock.js";
import type { GroupQualitySettings } from "./quality-settings.js";
import { randomBase64Url } from "./ids.js";
import { createDefaultGroupQualitySettings } from "./quality-settings.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface GroupBootstrapCreator {
  deviceId: string;
  displayName: string;
  firstSeenAt: number;
  profileStamp: HybridTimestamp;
}

export interface GroupInviteV1 {
  version: 1;
  groupId: string;
  controlRoomId: string;
  groupSecret: string;
  bootstrapName: string;
  bootstrapNameStamp: HybridTimestamp;
  bootstrapSettings: GroupQualitySettings;
  bootstrapSettingsStamp: HybridTimestamp;
  bootstrapCreator: GroupBootstrapCreator;
}

// ─── Schemas ───────────────────────────────────────────────────────────────

// Forward-referenced schema creators (we need HybridTimestampSchema and
// GroupQualitySettingsSchema at runtime, imported dynamically to avoid
// circular issues). We use lazy evaluation via z.lazy.
import { HybridTimestampSchema } from "./hybrid-logical-clock.js";
import { GroupQualitySettingsSchema } from "./quality-settings.js";

export const GroupBootstrapCreatorSchema: z.ZodType<GroupBootstrapCreator> = z.object({
  deviceId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(100),
  firstSeenAt: z.number().int().positive(),
  profileStamp: HybridTimestampSchema,
});

export const GroupInviteV1Schema: z.ZodType<GroupInviteV1> = z.object({
  version: z.literal(1),
  groupId: z.string().uuid(),
  controlRoomId: z.string().min(1),
  groupSecret: z.string().min(1),
  bootstrapName: z.string().min(1).max(100),
  bootstrapNameStamp: HybridTimestampSchema,
  bootstrapSettings: GroupQualitySettingsSchema,
  bootstrapSettingsStamp: HybridTimestampSchema,
  bootstrapCreator: GroupBootstrapCreatorSchema,
});

// ─── Constants ─────────────────────────────────────────────────────────────

const MAX_INVITE_PAYLOAD_BYTES = 64 * 1024; // 64 KB
const SCREENLINK_PROTOCOL_PREFIX = "screenlink://group?v=1&data=";

// ─── Helpers ───────────────────────────────────────────────────────────────

export interface CreateGroupInviteOpts {
  groupName: string;
  displayName: string;
  nodeId: string;
  groupId?: string;
  nowMs?: number;
}

/**
 * Create a GroupInviteV1 from the given options.
 * Generates random groupId (if not provided), controlRoomId, and groupSecret.
 * Throws if the serialized payload exceeds the maximum allowed size.
 */
export function createGroupInvite(opts: CreateGroupInviteOpts): GroupInviteV1 {
  const now = opts.nowMs ?? Date.now();

  const invite: GroupInviteV1 = {
    version: 1,
    groupId: opts.groupId ?? crypto.randomUUID(),
    controlRoomId: randomBase64Url(16),
    groupSecret: randomBase64Url(32),
    bootstrapName: opts.groupName.trim().slice(0, 100),
    bootstrapNameStamp: {
      wallTimeMs: now,
      counter: 0,
      nodeId: opts.nodeId,
    },
    bootstrapSettings: createDefaultGroupQualitySettings(),
    bootstrapSettingsStamp: {
      wallTimeMs: now,
      counter: 0,
      nodeId: opts.nodeId,
    },
    bootstrapCreator: {
      deviceId: opts.nodeId,
      displayName: opts.displayName.trim().slice(0, 100),
      firstSeenAt: now,
      profileStamp: {
        wallTimeMs: now,
        counter: 0,
        nodeId: opts.nodeId,
      },
    },
  };

  // Enforce bounded payload size
  const serialized = JSON.stringify(invite);
  if (serialized.length > MAX_INVITE_PAYLOAD_BYTES) {
    throw new Error(
      `Invite payload exceeds maximum size of ${MAX_INVITE_PAYLOAD_BYTES} bytes`,
    );
  }

  return invite;
}

/**
 * Format a GroupInviteV1 as a screenlink:// URL.
 * Payload is JSON → base64url (URL-encoded).
 */
export function formatGroupInviteLink(invite: GroupInviteV1): string {
  const json = JSON.stringify(invite);
  const base64 = base64urlEncode(json);
  const encoded = encodeURIComponent(base64);
  return `${SCREENLINK_PROTOCOL_PREFIX}${encoded}`;
}

/**
 * Parse a raw base64url-encoded invite code (without the URL prefix) into a
 * GroupInviteV1. Returns null if parsing or validation fails.
 */
export function parseGroupInviteCode(code: string): GroupInviteV1 | null {
  try {
    const decoded = base64urlDecode(code);
    const parsed = JSON.parse(decoded);
    const result = GroupInviteV1Schema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Parse a full screenlink:// URL into a GroupInviteV1.
 * Returns null if the URL scheme is wrong or parsing/validation fails.
 */
export function parseGroupInviteLink(link: string): GroupInviteV1 | null {
  if (!link.startsWith(SCREENLINK_PROTOCOL_PREFIX)) {
    return null;
  }
  const encoded = link.slice(SCREENLINK_PROTOCOL_PREFIX.length);
  const decoded = decodeURIComponent(encoded);
  return parseGroupInviteCode(decoded);
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function base64urlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(input: string): string {
  // Restore padding
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}
