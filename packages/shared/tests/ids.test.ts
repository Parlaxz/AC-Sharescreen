import { describe, it, expect } from "vitest";
import {
  generateShareId,
  generateHostToken,
  generateViewerToken,
  generateSessionId,
  generateVdoStreamId,
  generateVdoPassword,
} from "@screenlink/shared";

describe("ID generation", () => {
  it("generateShareId returns a 16-byte base64url string with no padding", () => {
    const id = generateShareId();
    // 16 bytes → base64 → 24 chars → after stripping padding, expect 22
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(id).not.toContain("+");
    expect(id).not.toContain("/");
    expect(id).not.toContain("=");
    expect(id.length).toBe(22);
  });

  it("generateHostToken returns a 32-byte base64url string with no padding", () => {
    const token = generateHostToken();
    // 32 bytes → base64 → 44 chars → after stripping padding, expect 43
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
    expect(token).not.toContain("=");
    expect(token.length).toBe(43);
  });

  it("generateViewerToken returns a 32-byte base64url string with no padding", () => {
    const token = generateViewerToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
    expect(token).not.toContain("=");
    expect(token.length).toBe(43);
  });

  it("generateSessionId returns a valid UUID v4", () => {
    const id = generateSessionId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("generateVdoStreamId returns max 64 chars, only [a-zA-Z0-9_]", () => {
    const id = generateVdoStreamId();
    expect(id.length).toBeLessThanOrEqual(64);
    expect(id).toMatch(/^[a-zA-Z0-9_]+$/);
  });

  it("generateVdoPassword returns a 32-byte base64url string", () => {
    const pw = generateVdoPassword();
    expect(pw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pw).not.toContain("+");
    expect(pw).not.toContain("/");
    expect(pw).not.toContain("=");
    expect(pw.length).toBe(43);
  });

  it("all IDs are unique across 100 iterations", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateShareId());
      ids.add(generateHostToken());
      ids.add(generateViewerToken());
      ids.add(generateSessionId());
      ids.add(generateVdoStreamId());
      ids.add(generateVdoPassword());
    }
    // All 600 values should be unique
    expect(ids.size).toBe(600);
  });

  it("all generated strings use base64url encoding (no +, /, or = padding)", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateShareId()).not.toMatch(/[+/=]/);
      expect(generateHostToken()).not.toMatch(/[+/=]/);
      expect(generateViewerToken()).not.toMatch(/[+/=]/);
      expect(generateVdoPassword()).not.toMatch(/[+/=]/);
    }
  });
});
