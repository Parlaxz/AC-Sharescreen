/**
 * ID and token generation functions using crypto.getRandomValues.
 */

/**
 * Generate a base64url-encoded string from random bytes.
 * Uses crypto.getRandomValues for cryptographically secure randomness.
 * No padding characters are included.
 */
export function randomBase64Url(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);

  // Convert to binary string then base64url
  let binary = "";
  for (let i = 0; i < buffer.length; i++) {
    binary += String.fromCharCode(buffer[i]!);
  }

  const base64 = btoa(binary);
  // Make base64url: replace + with -, / with _, strip padding
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generate a share ID: 16 random bytes, base64url, no padding.
 * Produces ~22 characters.
 */
export function generateShareId(): string {
  return randomBase64Url(16);
}

/**
 * Generate a host token: 32 random bytes, base64url, no padding.
 * Produces ~43 characters.
 */
export function generateHostToken(): string {
  return randomBase64Url(32);
}

/**
 * Generate a viewer token: 32 random bytes, base64url, no padding.
 * Produces ~43 characters.
 */
export function generateViewerToken(): string {
  return randomBase64Url(32);
}

/**
 * Generate a UUID v4 using crypto.randomUUID().
 */
export function generateSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Generate a vdo stream ID: 32 random bytes, base64url restricted to [a-zA-Z0-9_],
 * max 64 characters total. Strips non-alphanumeric/underscore chars.
 */
export function generateVdoStreamId(): string {
  const raw = randomBase64Url(32);
  // Filter to [a-zA-Z0-9_] only, then pad/truncate to a reasonable length
  const filtered = raw.replace(/[^a-zA-Z0-9_]/g, "");
  // Ensure we have at least some characters (fallback: use a hash approach)
  if (filtered.length < 16) {
    // Append a hex fallback if too many chars were stripped
    const buffer = new Uint8Array(8);
    crypto.getRandomValues(buffer);
    let hex = "";
    for (let i = 0; i < buffer.length; i++) {
      hex += buffer[i]!.toString(16).padStart(2, "0");
    }
    return (filtered + hex).slice(0, 64);
  }
  return filtered.slice(0, 64);
}

/**
 * Generate a vdo password: 32 random bytes, base64url, no padding.
 */
export function generateVdoPassword(): string {
  return randomBase64Url(32);
}
