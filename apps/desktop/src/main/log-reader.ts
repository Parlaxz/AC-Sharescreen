/**
 * log-reader.ts
 *
 * Pure function to read recent log files from a log directory.
 * No Electron or app dependencies — fully testable in node.
 *
 * Security:
 * - Canonical path via realpathSync.native prevents directory traversal
 * - lstat (no follow) detects symlinks; symlinks escaping logDir are skipped
 * - Never follows symlinks outside the canonical log directory
 * - Only reads .log files
 *
 * UTF-8 safety:
 * - Truncation at maxBytes uses Buffer.byteLength positions to avoid
 *   splitting multi-byte characters (no replacement chars emitted)
 *
 * Line count:
 * - Trailing newline does not increment line count
 */
import fs from "node:fs";
import path from "node:path";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ReadRecentLogsOptions {
  /** Maximum total bytes to read across all log files (default 64 KiB) */
  maxBytes?: number;
  /** Maximum number of log files to read (default 5) */
  maxFiles?: number;
}

export interface ReadRecentLogsResult {
  success: boolean;
  data: string;
  byteCount: number;
  lineCount: number;
  truncated: boolean;
  error?: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_MAX_BYTES = 65536; // 64 KiB
const DEFAULT_MAX_FILES = 5;

// ─── UTF-8 safe truncation ─────────────────────────────────────────────────

/**
 * Truncate a UTF-8 string to at most maxBytes bytes without splitting
 * multi-byte characters. Returns the safe prefix and whether truncation occurred.
 */
function utf8SafeTruncate(content: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes <= maxBytes) {
    return { text: content, truncated: false };
  }

  // Binary-search for the largest safe character boundary
  let lo = 0;
  let hi = maxBytes;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = Buffer.from(content, "utf-8").subarray(0, mid).toString("utf-8");
    if (Buffer.byteLength(candidate, "utf-8") <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  const safe = Buffer.from(content, "utf-8").subarray(0, lo).toString("utf-8");
  return { text: safe, truncated: true };
}

/**
 * Count lines, excluding the empty trailing element from a trailing newline.
 * "alpha\nbeta\n" => 2 lines (not 3).
 */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  const parts = text.split("\n");
  // If the last part is empty (text ends with \n), don't count it
  if (parts[parts.length - 1] === "") {
    return parts.length - 1;
  }
  return parts.length;
}

/**
 * Resolve a path to its canonical form using realpathSync.native,
 * then verify it's inside the base directory. Symlinks are resolved
 * before comparison so symlinks escaping the base are rejected.
 *
 * @returns The canonical real path if safe, null if unsafe
 */
function getCanonicalPath(filePath: string): string | null {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return null;
  }
}

/**
 * Check whether a resolved canonical path is contained within a canonical base.
 */
function isPathContained(canonicalTarget: string, canonicalBase: string): boolean {
  const withSep = canonicalBase.endsWith(path.sep)
    ? canonicalBase
    : canonicalBase + path.sep;
  return canonicalTarget.startsWith(withSep) || canonicalTarget === canonicalBase;
}

// ─── Main function ─────────────────────────────────────────────────────────

/**
 * Read recent log files from a log directory.
 *
 * @param logDir - Absolute path to the log directory
 * @param options - Optional capping parameters
 * @returns ReadRecentLogsResult with combined content, byte/line counts
 */
export function readRecentLogs(
  logDir: string,
  options?: ReadRecentLogsOptions,
): ReadRecentLogsResult {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;

  if (!path.isAbsolute(logDir)) {
    return {
      success: false, data: "", byteCount: 0, lineCount: 0, truncated: false,
      error: "Log directory path must be absolute",
    };
  }

  // Resolve to canonical path to prevent directory traversal
  const resolvedDir = path.resolve(logDir);

  // Detect traversal: check the RAW input string for ".." segments before
  // any path normalization. If the resolved path escapes the intended base
  // (the directory segment just before the first ".."), reject it.
  const dotdotPos = logDir.indexOf("..");
  if (dotdotPos >= 0) {
    // Extract the intended base: everything before the ".." (excluding trailing separators)
    const baseRaw = logDir.slice(0, dotdotPos).replace(/[/\\]+$/, "");
    const intendedBase = path.resolve(baseRaw || ".");
    const expectedPrefix = intendedBase + path.sep;
    if (!resolvedDir.startsWith(expectedPrefix) && resolvedDir !== intendedBase) {
      return {
        success: false, data: "", byteCount: 0, lineCount: 0, truncated: false,
        error: "Path traversal detected: resolved path escapes the log directory",
      };
    }
  }

  const canonicalDir = getCanonicalPath(resolvedDir);

  // Use lstat (no follow) to check the base dir — reject symlinks at the root
  try {
    const stat = fs.lstatSync(resolvedDir);
    if (!stat.isDirectory()) {
      return {
        success: false, data: "", byteCount: 0, lineCount: 0, truncated: false,
        error: "Log path is not a directory",
      };
    }
  } catch {
    // Directory doesn't exist — return empty success
    return {
      success: true, data: "", byteCount: 0, lineCount: 0, truncated: false,
    };
  }

  // Read directory entries
  let entries: string[];
  try {
    entries = fs.readdirSync(resolvedDir);
  } catch (err: unknown) {
    return {
      success: false, data: "", byteCount: 0, lineCount: 0, truncated: false,
      error: `Failed to read log directory: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Filter .log files, newest first
  const logFiles = entries
    .filter((name) => name.endsWith(".log"))
    .sort()
    .reverse()
    .slice(0, maxFiles);

  // Read files, accumulating content until maxBytes
  const chunks: string[] = [];
  let totalBytes = 0;
  let totalLines = 0;
  let truncated = false;

  for (const name of logFiles) {
    if (totalBytes >= maxBytes) {
      truncated = true;
      break;
    }

    const filePath = path.join(resolvedDir, name);

    // Use lstat to detect symlinks — skip symlinks pointing outside logDir
    try {
      const fileStat = fs.lstatSync(filePath);
      if (fileStat.isSymbolicLink()) {
        // Resolve the symlink's real target and check containment
        const linkTarget = getCanonicalPath(filePath);
        if (!linkTarget || !canonicalDir || !isPathContained(linkTarget, canonicalDir)) {
          // Symlink escapes the log directory — skip it
          continue;
        }
      }
    } catch {
      // Skip files that can't be stat'd
      continue;
    }

    try {
      let content = fs.readFileSync(filePath, "utf-8");

      // Measure and cap
      const remaining = maxBytes - totalBytes;
      const capped = utf8SafeTruncate(content, remaining);
      if (capped.truncated) {
        truncated = true;
      }

      chunks.push(capped.text);
      const byteLen = Buffer.byteLength(capped.text, "utf-8");
      totalBytes += byteLen;
      totalLines += countLines(capped.text);
    } catch {
      continue;
    }
  }

  return {
    success: true,
    data: chunks.join(""),
    byteCount: totalBytes,
    lineCount: totalLines,
    truncated,
  };
}
