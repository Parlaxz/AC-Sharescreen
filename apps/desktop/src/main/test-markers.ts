/**
 * test-markers — Production-safe E2E lifecycle markers (main process).
 *
 * Enabled ONLY when SCREENLINK_E2E=1 is present in the environment of the
 * app process. When disabled, markE2E() is a no-op and nothing is written.
 *
 * Markers are appended as newline-delimited JSON to
 * userData/logs/e2e-markers.log with an `e2eMarker` field so the E2E
 * harness can await lifecycle events alongside the JSONL LogManager output.
 */
import { app } from "electron";
import path from "path";
import fs from "fs";

let markerFilePath: string | null = null;

/** True when the app was launched with SCREENLINK_E2E=1. */
export function isE2EMainEnabled(): boolean {
  return process.env.SCREENLINK_E2E === "1";
}

/**
 * Write one E2E lifecycle marker line. Never throws — marker logging must
 * not be able to break product code paths.
 */
export function markE2E(name: string, data?: Record<string, unknown>): void {
  if (!isE2EMainEnabled()) return;
  try {
    if (!markerFilePath) {
      const dir = path.join(app.getPath("userData"), "logs");
      fs.mkdirSync(dir, { recursive: true });
      markerFilePath = path.join(dir, "e2e-markers.log");
    }
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      e2eMarker: name,
      ...(data ?? {}),
    });
    fs.appendFileSync(markerFilePath, entry + "\n", "utf-8");
  } catch {
    // best-effort only
  }
}
