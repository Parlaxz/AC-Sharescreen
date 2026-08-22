/**
 * url-validator.ts
 *
 * Pure function to validate external URLs before opening via shell.openExternal.
 * No Electron dependencies — fully testable in node.
 *
 * Security:
 * - HTTPS protocol enforced
 * - Host allowlist prevents open-redirect / SSRF
 * - Credentials rejected
 * - Deceptive/homograph hosts rejected via strict hostname comparison
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface UrlValidationResult {
  valid: boolean;
  error?: string;
  url?: string;
  hostname?: string;
}

// ─── Validator ──────────────────────────────────────────────────────────────

/**
 * Validate an external URL before opening.
 *
 * @param url - The URL string to validate
 * @param allowedHosts - Array of allowed hostnames (e.g. ["github.com", "screenlink.app"])
 * @returns UrlValidationResult with valid flag and error message
 */
export function validateExternalUrl(
  url: string,
  allowedHosts: string[],
): UrlValidationResult {
  if (!url || typeof url !== "string") {
    return { valid: false, error: "URL must be a non-empty string" };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }

  // Protocol: must be HTTPS
  if (parsed.protocol !== "https:") {
    return { valid: false, error: "Only HTTPS URLs are allowed" };
  }

  // Credentials: reject embedded usernames/passwords
  if (parsed.username || parsed.password) {
    return { valid: false, error: "URL must not contain embedded credentials" };
  }

  // Host: must be in the allowlist
  if (!allowedHosts.includes(parsed.hostname)) {
    return {
      valid: false,
      error: `Host "${parsed.hostname}" is not in the allowed hosts list`,
    };
  }

  return {
    valid: true,
    url: parsed.href,
    hostname: parsed.hostname,
  };
}
