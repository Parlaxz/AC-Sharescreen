import { z } from "zod";

// ── ID Generation ──────────────────────────────────────────────

export function generatePairId(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generatePairSecret(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateDeviceId(): string {
  return crypto.randomUUID();
}

// ── Pairing Lifecycle ─────────────────────────────────────────

/**
 * Pairing lifecycle states.
 *
 * UNPAIRED                      — No pairing config exists, or pairing has been reset.
 * PAIR_CREATED_WAITING_FOR_IMPORT — Creator has created a pairing and is waiting for
 *                                  the remote side to import the link.
 * PAIR_IMPORTED_CONNECTING        — Importer has imported the link and is connecting.
 * PAIR_CONNECTED_UNCONFIRMED      — Signal connection established but handshake not
 *                                  yet complete/identity not yet confirmed.
 * PAIRED_OFFLINE                  — Full pairing established (trusted identity known)
 *                                  but currently disconnected.
 * PAIRED_ONLINE                   — Full pairing established and connected.
 */
export const PAIRING_LIFECYCLE = {
  UNPAIRED: "UNPAIRED",
  PAIR_CREATED_WAITING_FOR_IMPORT: "PAIR_CREATED_WAITING_FOR_IMPORT",
  PAIR_IMPORTED_CONNECTING: "PAIR_IMPORTED_CONNECTING",
  PAIR_CONNECTED_UNCONFIRMED: "PAIR_CONNECTED_UNCONFIRMED",
  PAIRED_OFFLINE: "PAIRED_OFFLINE",
  PAIRED_ONLINE: "PAIRED_ONLINE",
} as const;

export type PairingLifecycle =
  (typeof PAIRING_LIFECYCLE)[keyof typeof PAIRING_LIFECYCLE];

/** All pairing lifecycle values as an array. */
export const PAIRING_LIFECYCLE_VALUES = Object.values(PAIRING_LIFECYCLE);

/**
 * Returns true for lifecycle states that represent a fully-established
 * pairing with trusted remote identity.
 */
export function isPairedLifecycle(lifecycle: PairingLifecycle): boolean {
  return lifecycle === "PAIRED_ONLINE" || lifecycle === "PAIRED_OFFLINE";
}

/**
 * Returns true if the lifecycle is in a "waiting" state where the creator
 * still needs to share the link (the link should remain visible).
 */
export function isPreHandshakeLifecycle(lifecycle: PairingLifecycle): boolean {
  return (
    lifecycle === "PAIR_CREATED_WAITING_FOR_IMPORT" ||
    lifecycle === "PAIR_IMPORTED_CONNECTING" ||
    lifecycle === "PAIR_CONNECTED_UNCONFIRMED"
  );
}

// ── Types ──────────────────────────────────────────────────────

export interface PairingConfig {
  version: 1;
  pairId: string;
  pairSecret: string;
  localDeviceId: string;
  localDisplayName: string;
  pairingLifecycle: PairingLifecycle;
  remoteDeviceId?: string;
  remoteDisplayName?: string;
  trustedAt?: number;
  /** The full screenlink://pair URL, stored on the creator side while waiting */
  pendingPairingLink?: string;
}

export interface PairingExport {
  version: 1;
  pairId: string;
  pairSecret: string;
  creatorDeviceId: string;
  creatorDisplayName: string;
}

// ── Zod Schemas ────────────────────────────────────────────────

export const PairingLifecycleSchema = z.enum([
  "UNPAIRED",
  "PAIR_CREATED_WAITING_FOR_IMPORT",
  "PAIR_IMPORTED_CONNECTING",
  "PAIR_CONNECTED_UNCONFIRMED",
  "PAIRED_OFFLINE",
  "PAIRED_ONLINE",
]) satisfies z.ZodType<PairingLifecycle>;

export const PairingConfigSchema = z.object({
  version: z.literal(1),
  pairId: z.string().min(10),
  pairSecret: z.string().min(20),
  localDeviceId: z.string().uuid(),
  localDisplayName: z.string().min(1).max(100),
  pairingLifecycle: PairingLifecycleSchema,
  remoteDeviceId: z.string().uuid().optional(),
  remoteDisplayName: z.string().min(1).max(100).optional(),
  trustedAt: z.number().positive().optional(),
  pendingPairingLink: z.string().optional(),
}) satisfies z.ZodType<PairingConfig>;

export const PairingExportSchema = z.object({
  version: z.literal(1),
  pairId: z.string().min(10),
  pairSecret: z.string().min(20),
  creatorDeviceId: z.string().uuid(),
  creatorDisplayName: z.string().min(1).max(100),
}) satisfies z.ZodType<PairingExport>;

// ── Link Formatting ────────────────────────────────────────────

export function formatPairingCode(exportData: PairingExport): string {
  const json = JSON.stringify(exportData);
  return btoa(json);
}

export function parsePairingCode(code: string): PairingExport | null {
  try {
    const json = atob(code);
    const parsed = JSON.parse(json);
    const result = PairingExportSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// ── Pure Helpers ───────────────────────────────────────────────

export interface CreateCreatorConfigOpts {
  pairId: string;
  pairSecret: string;
  localDeviceId: string;
  localDisplayName: string;
}

export interface CreateCreatorConfigResult {
  config: PairingConfig;
  exportData: PairingExport;
  pairingLink: string;
}

/**
 * Create a pairing config for the creator side.
 * The lifecycle is set to PAIR_CREATED_WAITING_FOR_IMPORT.
 * The returned pairingLink is the full screenlink://pair URL to share.
 */
export function createCreatorConfig(
  opts: CreateCreatorConfigOpts,
): CreateCreatorConfigResult {
  const exportData: PairingExport = {
    version: 1,
    pairId: opts.pairId,
    pairSecret: opts.pairSecret,
    creatorDeviceId: opts.localDeviceId,
    creatorDisplayName: opts.localDisplayName,
  };

  const code = formatPairingCode(exportData);
  const pairingLink = `screenlink://pair?v=1&data=${encodeURIComponent(code)}`;

  const config: PairingConfig = {
    version: 1,
    pairId: opts.pairId,
    pairSecret: opts.pairSecret,
    localDeviceId: opts.localDeviceId,
    localDisplayName: opts.localDisplayName,
    pairingLifecycle: "PAIR_CREATED_WAITING_FOR_IMPORT",
    pendingPairingLink: pairingLink,
  };

  return { config, exportData, pairingLink };
}

export interface CreateImporterConfigOpts {
  exportData: PairingExport;
  localDeviceId: string;
  localDisplayName: string;
}

/**
 * Create a pairing config for the importer side.
 * The lifecycle is set to PAIR_IMPORTED_CONNECTING.
 * The remote identity is set to the creator's exported identity.
 *
 * Throws if localDeviceId matches the creator's deviceId (collision guard).
 */
export function createImporterConfig(
  opts: CreateImporterConfigOpts,
): PairingConfig {
  if (opts.localDeviceId === opts.exportData.creatorDeviceId) {
    throw new Error(
      "Importer localDeviceId must differ from creatorDeviceId",
    );
  }

  return {
    version: 1,
    pairId: opts.exportData.pairId,
    pairSecret: opts.exportData.pairSecret,
    localDeviceId: opts.localDeviceId,
    localDisplayName: opts.localDisplayName,
    pairingLifecycle: "PAIR_IMPORTED_CONNECTING",
    remoteDeviceId: opts.exportData.creatorDeviceId,
    remoteDisplayName: opts.exportData.creatorDisplayName,
  };
}

/**
 * Parse a screenlink://pair link and return the export data,
 * or null if the link is invalid.
 */
export function parsePairingLink(link: string): PairingExport | null {
  if (!link.startsWith("screenlink://pair?")) return null;
  try {
    const url = new URL(link);
    const data = url.searchParams.get("data");
    if (!data) return null;
    return parsePairingCode(decodeURIComponent(data));
  } catch {
    return null;
  }
}

/**
 * Result of getPairingDisplayInfo — pure UI-state derivation.
 */
export interface PairingDisplayInfo {
  /** The friend's display name to show, or "" if not known. Never "Unknown". */
  pairedName: string;
  /** A short status text describing the current lifecycle. */
  statusText: string;
  /** Whether to show the pairing link field (creator waiting for import). */
  showLink: boolean;
  /** Whether to show Replace/Forget pairing actions. */
  showReplaceForget: boolean;
}

/**
 * Derive UI display info from a pairing config.
 * Pass `null` for unpaired state.
 * This function guarantees that "Unknown" is never returned as a display name.
 *
 * The link remains visible for the creator as long as `pendingPairingLink`
 * is set in the config, even during PAIR_CONNECTED_UNCONFIRMED (the link
 * is only cleared when handshake completes and remote identity is learned).
 */
export function getPairingDisplayInfo(
  config: PairingConfig | null,
): PairingDisplayInfo {
  if (!config) {
    return {
      pairedName: "",
      statusText: "",
      showLink: false,
      showReplaceForget: false,
    };
  }

  const lifecycle = config.pairingLifecycle;

  // The creator's link remains visible until the handshake fully completes
  // (i.e. as long as pendingPairingLink is set in the stored config).
  // This covers PAIR_CREATED_WAITING_FOR_IMPORT → PAIR_CONNECTED_UNCONFIRMED.
  const hasPendingLink = !!config.pendingPairingLink;

  switch (lifecycle) {
    case "UNPAIRED":
      return {
        pairedName: "",
        statusText: "",
        showLink: false,
        showReplaceForget: false,
      };

    case "PAIR_CREATED_WAITING_FOR_IMPORT":
      return {
        pairedName: "",
        statusText:
          "Pairing link created. Share it with your friend to complete pairing.",
        showLink: true,
        showReplaceForget: false,
      };

    case "PAIR_IMPORTED_CONNECTING":
      return {
        pairedName: "",
        statusText: "Connecting to friend...",
        showLink: false,
        showReplaceForget: false,
      };

    case "PAIR_CONNECTED_UNCONFIRMED":
      return {
        pairedName: "",
        statusText: hasPendingLink
          ? "Waiting for friend to import your pairing link..."
          : "Connected — waiting for handshake...",
        showLink: hasPendingLink,
        showReplaceForget: false,
      };

    case "PAIRED_ONLINE": {
      const name = config.remoteDisplayName || "";
      return {
        pairedName: name,
        statusText: name
          ? `Paired with ${name}`
          : "Paired — friend identity not yet established",
        showLink: false,
        showReplaceForget: true,
      };
    }

    case "PAIRED_OFFLINE": {
      const name = config.remoteDisplayName || "";
      return {
        pairedName: name,
        statusText: name
          ? `Paired with ${name} (offline)`
          : "Paired — friend identity not yet established",
        showLink: false,
        showReplaceForget: true,
      };
    }

    default:
      return {
        pairedName: "",
        statusText: "",
        showLink: false,
        showReplaceForget: false,
      };
  }
}

/**
 * Result of applyPeerHello — either the updated config or a reject signal.
 */
export interface ApplyPeerHelloResult {
  /** The updated config, or null if the hello should be rejected/ignored. */
  config: PairingConfig | null;
  /** True if the identity was accepted/updated. */
  accepted: boolean;
  /** Human-readable reason if rejected. */
  reason?: string;
}

/**
 * Apply a received peer.hello to a pairing config.
 *
 * On the **creator** side: learns the importer's device ID and display name,
 * transitions lifecycle to PAIRED_ONLINE, sets trustedAt.
 * On the **importer** side: confirms that the hello matches the expected
 * remote (creator), transitions to PAIRED_ONLINE, sets trustedAt.
 *
 * ## Trust rules:
 * - If a trusted remote identity already exists and a hello arrives from a
 *   DIFFERENT device ID, the hello is rejected (config remains unchanged).
 * - If the trusted identity matches (same device ID), the lifecycle is
 *   updated to PAIRED_ONLINE but the existing display name is preserved.
 * - If no trusted identity exists yet, the hello is accepted and the
 *   remote identity is set.
 */
export function applyPeerHello(
  config: PairingConfig,
  remoteDeviceId: string,
  remoteDisplayName: string,
): ApplyPeerHelloResult {
  const now = Date.now();

  // If we already have a trusted remote identity, validate against it
  if (config.remoteDeviceId && config.trustedAt) {
    // Mismatch — reject the hello from a different device
    if (config.remoteDeviceId !== remoteDeviceId) {
      return {
        config: null,
        accepted: false,
        reason: `Hello from device "${remoteDeviceId.slice(0, 8)}..." does not match trusted identity "${config.remoteDeviceId.slice(0, 8)}..."`,
      };
    }

    // Match — preserve existing display name, just update lifecycle
    return {
      config: {
        ...config,
        pairingLifecycle: "PAIRED_ONLINE",
      },
      accepted: true,
    };
  }

  // First time learning remote — set it, clear pending link
  return {
    config: {
      ...config,
      pairingLifecycle: "PAIRED_ONLINE",
      remoteDeviceId,
      remoteDisplayName,
      trustedAt: now,
      pendingPairingLink: undefined,
    },
    accepted: true,
  };
}

/**
 * Reset pairing to unpaired state — returns null (representing "no config").
 */
export function resetToUnpaired(): null {
  return null;
}

/**
 * Get a default display name for a dev profile name.
 * Returns null if the profile does not have a known default.
 */
export function getDefaultDevDisplayName(
  profile: string,
): string | null {
  const map: Record<string, string> = {
    alice: "Alice",
    bob: "Bob",
  };
  return map[profile.toLowerCase()] ?? null;
}

/**
 * Get the display name to use for the importer side.
 * Uses the current saved host display name if set, otherwise falls back to
 * the dev profile default, otherwise falls back to "ScreenLink User".
 */
export function getImporterDisplayName(
  currentSavedName: string | undefined,
  devProfile: string | undefined,
): string {
  if (currentSavedName && currentSavedName !== "Host") {
    return currentSavedName;
  }
  if (devProfile) {
    const defaultName = getDefaultDevDisplayName(devProfile);
    if (defaultName) return defaultName;
  }
  return "ScreenLink User";
}
