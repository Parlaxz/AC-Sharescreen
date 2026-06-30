// @vitest-environment node
/**
 * Static checker: pixel/frame transport code must NEVER base64-encode
 * pixel data. Base64 encoding of raw pixel buffers would be a severe
 * performance anti-pattern (33% size inflation, extra encode/decode
 * cycles, GC pressure).
 *
 * This checker scans only the NVIDIA/video pixel transport files and
 * reports any base64 usage. Known false-positive sites (secure-storage
 * token encryption, group-secret encryption) are explicitly whitelisted
 * by file path and line pattern.
 *
 * The intent is to catch accidental base64 encoding of pixel data
 * during code review / CI — never in production pixel paths.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// ─── Files in scope (pixel/frame transport only) ────────────────────────────

const PIXEL_TRANSPORT_FILES: string[] = [
  "src/main/VideoHelperManager.ts",
  "src/renderer/services/viewer-image-processing/nvidia-vsr-backend.ts",
  "src/main/ipc-handlers.ts",
];

// ─── Known-allowed base64 uses (NOT pixel transport) ────────────────────────

interface AllowEntry {
  file: string;
  linePattern: string;       // substring must be present on the line
  reason: string;
}

const ALLOWED_BASE64_USES: AllowEntry[] = [
  {
    file: "src/main/ipc-handlers.ts",
    linePattern: `toString("base64")`,
    reason: "Secure-storage token encryption output",
  },
  {
    file: "src/main/ipc-handlers.ts",
    linePattern: `encryptedB64`,
    reason: "Secure-storage token decryption input",
  },
  {
    file: "src/main/ipc-handlers.ts",
    linePattern: `Buffer.from(encryptedB64, "base64")`,
    reason: "Secure-storage token decryption",
  },
  {
    file: "src/main/group-store.ts",
    linePattern: `toString("base64")`,
    reason: "Group-secret encryption for persistence",
  },
  {
    file: "src/main/group-store.ts",
    linePattern: `Buffer.from(record.encryptedGroupSecret, "base64")`,
    reason: "Group-secret decryption from storage",
  },
  {
    file: "src/main/VideoHelperManager.ts",
    linePattern: `"presenterUpdateBounds"`,
    reason: "IPC command name (not base64)",
  },
  {
    file: "src/main/VideoHelperManager.ts",
    linePattern: `"presenterGetDiagnostics"`,
    reason: "IPC command name (not base64)",
  },
  {
    file: "src/main/VideoHelperManager.ts",
    linePattern: `"sharedMemoryOpenFailed"`,
    reason: "Lifecycle log event name (not base64)",
  },
  {
    file: "src/main/VideoHelperManager.ts",
    linePattern: `"sharedMemoryAccessFailed"`,
    reason: "Lifecycle log event name (not base64)",
  },
  {
    file: "src/renderer/services/viewer-image-processing/nvidia-vsr-backend.ts",
    linePattern: `"natvPresActivated"`,
    reason: "Lifecycle log event name (not base64)",
  },
  {
    file: "src/renderer/services/viewer-image-processing/nvidia-vsr-backend.ts",
    linePattern: `"natvPresDetached"`,
    reason: "Lifecycle log event name (not base64)",
  },
];

// ─── Base64 regex ───────────────────────────────────────────────────────────

const BASE64_RE =
  /["'`][A-Za-z0-9+/=]{20,}["'`]|base64|\.toString\(\s*["']base64["']\s*\)|Buffer\.from\(\s*\w+\s*,\s*["']base64["']\s*\)/;

// Strip known-safe lines before scanning
function isAllowedLine(file: string, line: string): boolean {
  for (const entry of ALLOWED_BASE64_USES) {
    if (file.endsWith(entry.file) && line.includes(entry.linePattern)) {
      return true;
    }
  }
  return false;
}

describe("NVIDIA pixel transport — base64 static check", () => {
  const projectRoot = path.resolve(__dirname, "..");

  for (const relPath of PIXEL_TRANSPORT_FILES) {
    const fullPath = path.join(projectRoot, relPath);

    it(`${relPath} must not base64-encode pixel/frame data`, () => {
      if (!existsSync(fullPath)) {
        // File might be generated or conditionally present — skip gracefully
        return;
      }

      const content = readFileSync(fullPath, "utf-8");
      const lines = content.split("\n");
      const violations: Array<{ line: number; text: string }> = [];

      for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1;
        const line = lines[i]!;
        if (BASE64_RE.test(line) && !isAllowedLine(relPath, line)) {
          violations.push({ line: lineNum, text: line.trim() });
        }
      }

      expect(violations).toEqual([]);
    });
  }
});
