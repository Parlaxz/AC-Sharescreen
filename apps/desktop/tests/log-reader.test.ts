// @vitest-environment node
/**
 * Unit tests for the pure readRecentLogs helper.
 *
 * Tests:
 * - Path safety: canonical path via realpath, symlink escape rejection via lstat
 * - UTF-8 capping: multibyte characters not split, emoji/CJK boundaries
 * - Line count: trailing newline not counted
 * - Missing/empty folder, byte capping, non-log extension filtering
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { readRecentLogs } from "../src/main/log-reader.js";

const TMPDIR = path.join(os.tmpdir(), "screenlink-log-reader-test-" + Date.now());

function writeLog(name: string, content: string) {
  const dir = path.join(TMPDIR, "logs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content, "utf-8");
}

beforeEach(() => {
  fs.rmSync(TMPDIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMPDIR, "logs"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

// ─── Missing / empty folder ──────────────────────────────────────────────────

describe("readRecentLogs — missing / empty folder", () => {
  it("returns success with empty content when logs dir is empty", () => {
    const result = readRecentLogs(path.join(TMPDIR, "logs"), { maxBytes: 65536 });
    expect(result.success).toBe(true);
    expect(result.data).toBe("");
    expect(result.byteCount).toBe(0);
    expect(result.lineCount).toBe(0);
  });

  it("returns success with empty content when logs dir does not exist", () => {
    const missingDir = path.join(TMPDIR, "nonexistent");
    const result = readRecentLogs(missingDir, { maxBytes: 65536 });
    expect(result.success).toBe(true);
    expect(result.data).toBe("");
  });
});

// ─── Content reading ─────────────────────────────────────────────────────────

describe("readRecentLogs — content reading", () => {
  it("reads a single log file", () => {
    writeLog("screenlink-0.log", "line1\nline2\nline3\n");
    const result = readRecentLogs(path.join(TMPDIR, "logs"), { maxBytes: 65536 });
    expect(result.success).toBe(true);
    expect(result.data).toContain("line1");
    expect(result.data).toContain("line3");
  });

  it("reads multiple log files in reverse sort order (newest first)", () => {
    writeLog("screenlink-0.log", "latest-line\n");
    writeLog("screenlink-1.log", "older-line\n");
    const result = readRecentLogs(path.join(TMPDIR, "logs"), { maxBytes: 65536 });
    expect(result.success).toBe(true);
    expect(result.data).toContain("latest-line");
    expect(result.data).toContain("older-line");
  });
});

// ─── Byte capping ────────────────────────────────────────────────────────────

describe("readRecentLogs — byte capping", () => {
  it("caps at maxBytes", () => {
    const bigLine = "x".repeat(2000);
    const content = Array.from({ length: 50 }, () => bigLine).join("\n");
    writeLog("screenlink-0.log", content);
    const result = readRecentLogs(path.join(TMPDIR, "logs"), { maxBytes: 5000 });
    expect(result.success).toBe(true);
    expect(result.byteCount).toBeLessThanOrEqual(5000);
    expect(result.truncated).toBe(true);
  });

  it("does not truncate when content fits within maxBytes", () => {
    writeLog("screenlink-0.log", "short\n");
    const result = readRecentLogs(path.join(TMPDIR, "logs"), { maxBytes: 65536 });
    expect(result.truncated).toBe(false);
    expect(result.data).toBe("short\n");
  });

  it("line count does not count trailing empty line from final newline", () => {
    writeLog("screenlink-0.log", "alpha\nbeta\n");
    const result = readRecentLogs(path.join(TMPDIR, "logs"), { maxBytes: 65536 });
    // "alpha\nbeta\n".split("\n") => ["alpha", "beta", ""] (3 parts)
    // The trailing empty should be excluded from lineCount
    expect(result.lineCount).toBe(2);
  });

  it("line count handles content without trailing newline", () => {
    writeLog("screenlink-0.log", "alpha\nbeta");
    const result = readRecentLogs(path.join(TMPDIR, "logs"), { maxBytes: 65536 });
    // "alpha\nbeta".split("\n") => ["alpha", "beta"]
    expect(result.lineCount).toBe(2);
  });
});

// ─── UTF-8 boundary safety ───────────────────────────────────────────────────

describe("readRecentLogs — UTF-8 multibyte safety", () => {
  it("does not split a multi-byte character at the cap boundary", () => {
    // A CJK character is 3 bytes in UTF-8. Write 2 CJK chars (6 bytes) with cap of 4.
    // Correct behavior: include only the first character (3 bytes), not split it.
    writeLog("screenlink-0.log", "\u4e00\u4e01"); // U+4E00 (3 bytes), U+4E01 (3 bytes)
    const result = readRecentLogs(path.join(TMPDIR, "logs"), { maxBytes: 4 });
    expect(result.success).toBe(true);
    expect(result.data).toBe("\u4e00"); // Only first char, not corrupted
    expect(result.truncated).toBe(true);
    // Should NOT contain replacement character or partial bytes
    expect(result.data).not.toContain("\ufffd");
  });

  it("does not split an emoji at the cap boundary", () => {
    // An emoji like 😀 (U+1F600) is 4 bytes in UTF-8. Cap to 3 bytes — should not include it.
    writeLog("screenlink-0.log", "a\u00e9\u4e00\ud83d\ude00"); // 1+2+3+4 = 10 bytes
    const result = readRecentLogs(path.join(TMPDIR, "logs"), { maxBytes: 5 });
    expect(result.success).toBe(true);
    expect(result.truncated).toBe(true);
    // Should contain "a" (1) + "é" (2) = 3 bytes, then "一" (3) would be too many
    // 5 bytes: "a" (1) + "é" (2) = 3 bytes used, next char "一" is 3 bytes (would exceed 5)
    expect(result.data).toBe("a\u00e9");
    // No replacement characters
    expect(result.data).not.toContain("\ufffd");
  });

  it("handles pure ASCII without issues", () => {
    writeLog("screenlink-0.log", "Hello World\n");
    const result = readRecentLogs(path.join(TMPDIR, "logs"), { maxBytes: 65536 });
    expect(result.success).toBe(true);
    expect(result.data).toContain("Hello World");
  });
});

// ─── Path safety: traversal and symlinks ────────────────────────────────────

describe("readRecentLogs — path safety", () => {
  it("resolves paths to canonical form and rejects traversal", () => {
    // Use raw string concatenation with the platform separator so ".." segments
    // are preserved (path.join would resolve them on some platforms).
    const malicious = TMPDIR + path.sep + "logs" + path.sep + ".." + path.sep + ".." + path.sep + "secret.txt";
    const result = readRecentLogs(malicious, { maxBytes: 65536 });
    // Should reject because the resolved path is outside TMPDIR/logs
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("rejects symlinks that escape the log directory", () => {
    // Create a file outside the logs dir
    const outsideFile = path.join(TMPDIR, "outside.txt");
    fs.writeFileSync(outsideFile, "escaped-content", "utf-8");
    // Create a symlink inside logs dir pointing outside
    const symlinkPath = path.join(TMPDIR, "logs", "escape.log");
    try {
      fs.symlinkSync(outsideFile, symlinkPath);
    } catch (err: unknown) {
      // On Windows, symlink creation may require admin or developer mode.
      // Skip the test if we lack permission, but only for explicit permission denials.
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr && (nodeErr.code === "EPERM" || nodeErr.code === "EACCES")) {
        return; // Gracefully skip on platform permission denial
      }
      throw err; // Re-throw unexpected errors
    }
    const result = readRecentLogs(path.join(TMPDIR, "logs"), { maxBytes: 65536 });
    // The symlink should be detected by lstat and its realpath checked.
    // Since it points outside the logs dir, it should be rejected or skipped.
    expect(result.success).toBe(true); // Still succeeds for other files
    // The escaped content should NOT appear in the result
    expect(result.data).not.toContain("escaped-content");
  });

  it("uses lstat (no follow) to detect symlinks and skip them", () => {
    const outsideFile = path.join(TMPDIR, "outside2.txt");
    fs.writeFileSync(outsideFile, "also-escaped", "utf-8");
    const symlinkPath = path.join(TMPDIR, "logs", "also-escape.log");
    try {
      fs.symlinkSync(outsideFile, symlinkPath);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr && (nodeErr.code === "EPERM" || nodeErr.code === "EACCES")) {
        return;
      }
      throw err;
    }
    // Also write a real log file
    writeLog("screenlink-0.log", "real-log-content\n");
    const result = readRecentLogs(path.join(TMPDIR, "logs"), { maxBytes: 65536 });
    expect(result.success).toBe(true);
    expect(result.data).toContain("real-log-content");
    expect(result.data).not.toContain("also-escaped");
  });
});

// ─── Extension filtering and edge cases ─────────────────────────────────────

describe("readRecentLogs — extension filtering and edge cases", () => {
  it("rejects non-log file extensions (only .log files are read)", () => {
    const dir = path.join(TMPDIR, "logs");
    fs.writeFileSync(path.join(dir, "malicious.exe"), "bad", "utf-8");
    const result = readRecentLogs(dir, { maxBytes: 65536 });
    expect(result.success).toBe(true);
    expect(result.data).toBe("");
  });

  it("gracefully handles non-existent paths as empty", () => {
    const outside = path.join(TMPDIR, "not-logs");
    const result = readRecentLogs(outside, { maxBytes: 65536 });
    expect(result.success).toBe(true);
    expect(result.data).toBe("");
  });

  it("returns error result when path is a file not a directory", () => {
    const filePath = path.join(TMPDIR, "not-a-dir");
    fs.writeFileSync(filePath, "content", "utf-8");
    const result = readRecentLogs(filePath, { maxBytes: 65536 });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
