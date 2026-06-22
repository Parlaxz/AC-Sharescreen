import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { app } from "electron";
import type { AudioCapabilityResult } from "@screenlink/shared";

const HELPER_TIMEOUT_MS = 5000;
const HELPER_EXE = "screenlink-audio-helper.exe";

export function getHelperPath(): string {
  if (app.isPackaged) {
    // In production, helper sits next to the app executable in resources
    return path.join(process.resourcesPath, HELPER_EXE);
  }
  // Development: built in native/audio-helper/build/Release/
  return path.join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "native",
    "audio-helper",
    "build",
    "Release",
    HELPER_EXE,
  );
}

export interface HelperResult<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

function errorResult(code: string, message: string): HelperResult<never> {
  return { success: false, error: { code, message } };
}

export async function getAudioCapabilities(): Promise<HelperResult<AudioCapabilityResult>> {
  const helperPath = getHelperPath();

  try {
    await fs.promises.access(helperPath);
  } catch {
    return errorResult("helper-not-found", `Audio helper not found at: ${helperPath}`);
  }

  return new Promise((resolve) => {
    const child = spawn(helperPath, ["--capabilities"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        resolve(errorResult("timeout", "Audio helper did not respond within 5 seconds"));
      }
    }, HELPER_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(errorResult("spawn-error", `Failed to start audio helper: ${err.message}`));
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (exitCode !== 0) {
        const reason = stderr.trim() || `exit code ${exitCode}`;
        resolve(errorResult("nonzero-exit", `Audio helper exited with ${reason}`));
        return;
      }

      if (!stdout.trim()) {
        resolve(errorResult("empty-output", "Audio helper produced no output"));
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        resolve(errorResult("invalid-json", "Audio helper produced malformed JSON"));
        return;
      }

      const cap = parsed as Record<string, unknown>;

      if (typeof cap.protocolVersion !== "string" || cap.protocolVersion !== "0.1.0") {
        resolve(
          errorResult(
            "unsupported-protocol",
            `Unsupported protocol version: ${String(cap.protocolVersion)}`,
          ),
        );
        return;
      }

      if (cap.status === "error") {
        const errMsg = typeof cap.error === "string" ? cap.error : "unknown error";
        resolve(errorResult("helper-error", `Audio helper reported: ${errMsg}`));
        return;
      }

      if (!validateCapability(parsed)) {
        resolve(errorResult("invalid-capability", "Audio helper returned incomplete capability data"));
        return;
      }

      resolve({ success: true, data: parsed });
    });

    function validateCapability(obj: unknown): obj is AudioCapabilityResult {
      if (typeof obj !== "object" || obj === null) return false;
      const cap = obj as Record<string, unknown>;
      return (
        typeof cap.protocolVersion === "string" &&
        typeof cap.helperVersion === "string" &&
        typeof cap.architecture === "string" &&
        typeof cap.operatingSystem === "string" &&
        typeof cap.detectionMethod === "string" &&
        typeof cap.detectionSucceeded === "boolean" &&
        typeof cap.compiledWindowsSdkVersion === "string" &&
        typeof cap.processLoopbackHeadersAvailable === "boolean" &&
        typeof cap.processLoopbackRuntimeSupported === "boolean" &&
        typeof cap.applicationLoopbackSupported === "boolean" &&
        typeof cap.usable === "boolean" &&
        typeof cap.is64BitProcess === "boolean" &&
        typeof cap.is64BitOperatingSystem === "boolean" &&
        typeof cap.reasonCode === "string" &&
        typeof cap.reasonMessage === "string" &&
        typeof cap.status === "string" &&
        typeof cap.osVersion === "object" &&
        cap.osVersion !== null &&
        typeof (cap.osVersion as Record<string, unknown>).major === "number"
      );
    }

  });
}
