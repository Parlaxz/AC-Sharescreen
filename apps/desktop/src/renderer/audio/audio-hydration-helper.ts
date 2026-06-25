/**
 * Pure renderer helpers for deterministic audio-mode hydration and share preflight.
 *
 * These functions have zero side effects — they transform inputs to outputs
 * so the renderer can make authoritative decisions without consulting the main
 * process during initialisation.
 */

import { normalizeAudioMode, type AudioMode } from "@screenlink/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudioAvailabilityMap {
  [mode: string]: boolean;
}

export interface ResolvedAudioMode {
  resolved: AudioMode;
  wasDowngraded: boolean;
}

export interface HydrationConflictResult {
  final: AudioMode;
  conflictResolved: boolean;
}

export interface PreflightAudioOptions {
  mode: AudioMode;
  available?: AudioAvailabilityMap;
}

export interface PreflightResult {
  allowed: boolean;
  metadata: {
    mode: AudioMode;
    available: AudioAvailabilityMap;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a simple availability map from a capabilities-based info array.
 * Each entry maps a mode key to its supported boolean.
 */
export function buildAvailabilityMap(
  modeInfos: ReadonlyArray<{ mode: string; supported: boolean }>,
): AudioAvailabilityMap {
  const map: AudioAvailabilityMap = {};
  for (const info of modeInfos) {
    map[info.mode] = info.supported;
  }
  return map;
}

/**
 * Resolve the initial audio mode from a persisted value against the
 * availability map.  If the persisted mode is unavailable, fall back to
 * `'none'` and signal the downgrade.
 */
export function resolveInitialAudioMode(
  persisted: string | null | undefined,
  availability: AudioAvailabilityMap,
): ResolvedAudioMode {
  const candidate = normalizeAudioMode(persisted);
  if (candidate !== 'none' && availability[candidate] === false) {
    return { resolved: 'none', wasDowngraded: true };
  }
  return { resolved: candidate, wasDowngraded: false };
}

/**
 * When capabilities arrive after the user has already made an explicit
 * selection, this function resolves any conflict.  An explicit
 * `userSelectedMode` always wins over a stale persisted mode — even if
 * the persisted mode would have been valid.
 *
 * Returns the final mode and whether a conflict was detected.
 */
export function resolveHydrationConflict(options: {
  persistedMode: string | null | undefined;
  userSelectedMode: string | null | undefined;
  capabilities: AudioAvailabilityMap;
}): HydrationConflictResult {
  const { userSelectedMode, capabilities } = options;

  // If the user explicitly selected a mode, honour it regardless of
  // what was persisted — even if the persisted mode was different.
  if (userSelectedMode != null) {
    const normalized = normalizeAudioMode(userSelectedMode);
    // If the user's selection is unavailable, still honour it at the
    // UI level (preflight will catch it later).  The conflict here
    // is about persisted vs explicit, not availability.
    return { final: normalized, conflictResolved: normalized !== normalizeAudioMode(options.persistedMode) };
  }

  // No explicit user selection — use persisted mode.
  const resolved = normalizeAudioMode(options.persistedMode);
  if (resolved !== 'none' && capabilities[resolved] === false) {
    return { final: 'none', conflictResolved: true };
  }
  return { final: resolved, conflictResolved: false };
}

/**
 * Validate share preflight.
 *
 * Throws on the first violation:
 * - `'audio-options-not-ready'` when `audioOptions` is null
 * - `'requested-audio-mode-was-discarded:system'` when an explicit
 *   `system` selection is no longer allowed
 * - `'<mode>-not-supported'` for unsupported application/monitor
 *
 * Returns a PreflightResult when all checks pass.
 */
export function validateSharePreflight(
  audioOptions: PreflightAudioOptions | null,
  _explicitMode: string | null | undefined,
  liveCapabilities: AudioAvailabilityMap,
): PreflightResult {
  // Guard: initialization incomplete
  if (audioOptions == null) {
    throw new Error('audio-options-not-ready');
  }

  const mode = audioOptions.mode;
  const availability = audioOptions.available ?? liveCapabilities;

  // Guard: explicit system selection that was discarded (e.g. loopback
  // was available at init but revoked before share)
  if (mode === 'system' && liveCapabilities.system === false) {
    throw new Error('requested-audio-mode-was-discarded:system');
  }

  // Guard: unsupported application
  if (mode === 'application' && availability.application === false) {
    throw new Error(`application audio is not supported: mode=${mode}`);
  }

  // Guard: unsupported monitor
  if (mode === 'monitor' && availability.monitor === false) {
    throw new Error(`monitor audio is not supported: mode=${mode}`);
  }

  return {
    allowed: true,
    metadata: {
      mode,
      available: { ...availability },
    },
  };
}
