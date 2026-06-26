/**
 * version-compare.ts
 *
 * Defensive semantic-version comparison helpers for update metadata.
 *
 * The updater is given an `availableVersion` from the GitHub feed and a
 * `currentVersion` from `app.getVersion()`. We must only ever advertise an
 * update when the available release is strictly greater than what the user
 * already has installed.
 *
 * Rules:
 *  - Accept an optional leading "v" on either side and normalize it.
 *  - Use a well-tested semver implementation. Do NOT compare strings
 *    lexicographically — "0.10.0" must rank above "0.9.0".
 *  - Reject malformed input: do not display a "version" that the user
 *    cannot interpret. Treat malformed metadata as a safe error.
 *  - `allowDowngrade` is always false. Equal or lower available versions
 *    are never advertised.
 */

import semver from "semver";

const LEADING_V = /^v(?=\d)/i;

export interface VersionComparison {
  /**
   * True when the available release is strictly greater than the installed
   * release. False for equal, lower, malformed, or missing inputs.
   */
  isNewer: boolean;

  /**
   * The normalized installed version, or `null` if the input was missing
   * or malformed. The "v" prefix, if present, has been stripped.
   */
  normalizedCurrent: string | null;

  /**
   * The normalized available version, or `null` if the input was missing
   * or malformed. The "v" prefix, if present, has been stripped.
   */
  normalizedAvailable: string | null;

  /**
   * Human-readable reason describing why the update was accepted or
   * rejected. Safe to log.
   */
  reason: string;
}

function stripLeadingV(value: string): string {
  return value.replace(LEADING_V, "");
}

function coerceOrNull(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const stripped = stripLeadingV(trimmed);
  if (semver.valid(stripped) === null) return null;
  return stripped;
}

/**
 * Compare an available release version against the installed version.
 *
 * Equal, lower, malformed, or missing inputs all return `isNewer: false`.
 * The returned `reason` is a short diagnostic safe for logging.
 */
export function compareVersions(
  currentVersion: string | null | undefined,
  availableVersion: string | null | undefined,
): VersionComparison {
  const normalizedCurrent = coerceOrNull(currentVersion);
  const normalizedAvailable = coerceOrNull(availableVersion);

  if (normalizedCurrent === null && normalizedAvailable === null) {
    return {
      isNewer: false,
      normalizedCurrent: null,
      normalizedAvailable: null,
      reason: "both versions missing or malformed",
    };
  }
  if (normalizedCurrent === null) {
    return {
      isNewer: false,
      normalizedCurrent: null,
      normalizedAvailable,
      reason: "current version missing or malformed",
    };
  }
  if (normalizedAvailable === null) {
    return {
      isNewer: false,
      normalizedCurrent,
      normalizedAvailable: null,
      reason: "available version missing or malformed",
    };
  }

  if (semver.eq(normalizedAvailable, normalizedCurrent)) {
    return {
      isNewer: false,
      normalizedCurrent,
      normalizedAvailable,
      reason: "available equals current",
    };
  }
  if (semver.lt(normalizedAvailable, normalizedCurrent)) {
    return {
      isNewer: false,
      normalizedCurrent,
      normalizedAvailable,
      reason: "available lower than current; downgrade suppressed",
    };
  }

  return {
    isNewer: true,
    normalizedCurrent,
    normalizedAvailable,
    reason: "available is strictly greater than current",
  };
}
