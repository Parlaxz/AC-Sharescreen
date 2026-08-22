// @vitest-environment node
/**
 * Unit tests for the validateExternalUrl pure function.
 *
 * Tests:
 * - HTTPS protocol enforcement
 * - Host allowlist derived from About links
 * - Rejection of embedded credentials
 * - Rejection of deceptive / homograph hosts
 * - Valid URL parsing
 */
import { describe, it, expect } from "vitest";
import { validateExternalUrl } from "../src/main/url-validator.js";

// The allowlist is derived from the About.tsx hardcoded external links.
// Currently: github.com, screenlink.app
const ALLOWED_HOSTS = ["github.com", "screenlink.app"];

describe("validateExternalUrl — HTTPS enforcement", () => {
  it("accepts valid HTTPS URLs on allowed hosts", () => {
    const result = validateExternalUrl("https://github.com/Parlaxz/AC-Sharescreen", ALLOWED_HOSTS);
    expect(result.valid).toBe(true);
  });

  it("rejects HTTP URLs", () => {
    const result = validateExternalUrl("http://github.com/Parlaxz/AC-Sharescreen", ALLOWED_HOSTS);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/https/i);
  });

  it("rejects non-HTTP protocols like ftp://", () => {
    const result = validateExternalUrl("ftp://github.com/file", ALLOWED_HOSTS);
    expect(result.valid).toBe(false);
  });

  it("rejects javascript: URLs", () => {
    const result = validateExternalUrl("javascript:alert(1)", ALLOWED_HOSTS);
    expect(result.valid).toBe(false);
  });

  it("rejects file: URLs", () => {
    const result = validateExternalUrl("file:///etc/passwd", ALLOWED_HOSTS);
    expect(result.valid).toBe(false);
  });

  it("rejects empty strings", () => {
    const result = validateExternalUrl("", ALLOWED_HOSTS);
    expect(result.valid).toBe(false);
  });

  it("rejects invalid URL strings", () => {
    const result = validateExternalUrl("not a url", ALLOWED_HOSTS);
    expect(result.valid).toBe(false);
  });
});

describe("validateExternalUrl — host allowlist", () => {
  it("accepts github.com", () => {
    expect(validateExternalUrl("https://github.com/Parlaxz/AC-Sharescreen", ALLOWED_HOSTS).valid).toBe(true);
  });

  it("accepts screenlink.app", () => {
    expect(validateExternalUrl("https://screenlink.app/about", ALLOWED_HOSTS).valid).toBe(true);
  });

  it("rejects arbitrary hosts", () => {
    expect(validateExternalUrl("https://evil.com/malware", ALLOWED_HOSTS).valid).toBe(false);
  });

  it("rejects subdomains of allowed hosts when not in allowlist", () => {
    // Subdomains like sub.github.com are NOT the same as github.com
    const result = validateExternalUrl("https://sub.github.com/evil", ALLOWED_HOSTS);
    expect(result.valid).toBe(false);
  });

  it("rejects IP addresses", () => {
    expect(validateExternalUrl("https://192.168.1.1/", ALLOWED_HOSTS).valid).toBe(false);
  });
});

describe("validateExternalUrl — credential rejection", () => {
  it("rejects URLs with embedded credentials", () => {
    const result = validateExternalUrl("https://user:pass@github.com/repo", ALLOWED_HOSTS);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/credentials/i);
  });

  it("rejects URLs with username only", () => {
    const result = validateExternalUrl("https://user@github.com/repo", ALLOWED_HOSTS);
    expect(result.valid).toBe(false);
  });
});

describe("validateExternalUrl — deceptive hosts", () => {
  it("rejects homograph-like domain githu b.com", () => {
    // Using a Cyrillic 'а' instead of ASCII 'a'
    const homograph = "https://githu\u0431.com/";
    const result = validateExternalUrl(homograph, ALLOWED_HOSTS);
    expect(result.valid).toBe(false);
  });

  it("rejects IDN homograph attack on screenlink.app", () => {
    // Using Cyrillic 'е' instead of ASCII 'e'
    const homograph = "https://scrеenlink.app/";
    const result = validateExternalUrl(homograph, ALLOWED_HOSTS);
    expect(result.valid).toBe(false);
  });
});

describe("validateExternalUrl — edge cases", () => {
  it("rejects null/undefined input", () => {
    expect(validateExternalUrl(null as unknown as string, ALLOWED_HOSTS).valid).toBe(false);
    expect(validateExternalUrl(undefined as unknown as string, ALLOWED_HOSTS).valid).toBe(false);
  });

  it("rejects relative paths", () => {
    expect(validateExternalUrl("/relative/path", ALLOWED_HOSTS).valid).toBe(false);
  });
});
