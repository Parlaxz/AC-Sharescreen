import { z } from "zod";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface DeviceIdentity {
  deviceId: string;
  displayName: string;
  createdAt: number;
}

// ─── Schemas ───────────────────────────────────────────────────────────────

export const DeviceIdentitySchema = z.object({
  deviceId: z.string().uuid(),
  displayName: z.string().trim().min(1).max(100),
  createdAt: z.number().int().positive(),
});

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Generate a new DeviceIdentity with a random UUID, trimmed displayName,
 * and current timestamp.
 * Throws if displayName is empty after trimming or exceeds 100 characters.
 */
export function generateDeviceIdentity(displayName: string): DeviceIdentity {
  const trimmed = displayName.trim();
  if (trimmed.length === 0) {
    throw new Error("displayName must not be empty after trimming");
  }
  if (trimmed.length > 100) {
    throw new Error("displayName must be at most 100 characters");
  }
  return {
    deviceId: crypto.randomUUID(),
    displayName: trimmed,
    createdAt: Date.now(),
  };
}

/**
 * Return a new DeviceIdentity with the updated displayName.
 * All other fields are preserved from the original identity.
 * Throws if displayName is empty after trimming or exceeds 100 characters.
 */
export function updateDeviceDisplayName(
  identity: DeviceIdentity,
  displayName: string,
): DeviceIdentity {
  const trimmed = displayName.trim();
  if (trimmed.length === 0) {
    throw new Error("displayName must not be empty after trimming");
  }
  if (trimmed.length > 100) {
    throw new Error("displayName must be at most 100 characters");
  }
  return {
    ...identity,
    displayName: trimmed,
  };
}

// ─── Default display names for development profiles ────────────────────────

const DEV_DISPLAY_NAMES: Record<string, string> = {
  alice: "Alice",
  bob: "Bob",
  charlie: "Charlie",
};

/**
 * Return a default display name for a known dev profile, or null if unknown.
 */
export function getDefaultDevDisplayName(profile: string): string | null {
  return DEV_DISPLAY_NAMES[profile.toLowerCase()] ?? null;
}
