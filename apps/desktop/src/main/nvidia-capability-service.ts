import { spawn } from "node:child_process";
import { getVideoEnhancerHelperPath } from "./helper-path.js";

export interface NvidiaCapabilityResult {
  available: boolean;
  reason: string;
  adapterName?: string;
  driverVersion?: string;
}

let cachedResult: NvidiaCapabilityResult | null = null;

/**
 * Probe NVIDIA RTX VSR capability.
 * First tries the native helper --capabilities command.
 * Falls back to a graceful unavailable if the helper isn't built yet.
 */
export async function probeNvidiaVsrCapability(): Promise<NvidiaCapabilityResult> {
  if (cachedResult) return cachedResult;

  try {
    const helperPath = getVideoEnhancerHelperPath();

    // Check if the helper binary exists
    const fs = await import("node:fs");
    if (!fs.existsSync(helperPath)) {
      const result: NvidiaCapabilityResult = {
        available: false,
        reason: "Video-enhancer helper not found. Build native/video-enhancer first.",
      };
      cachedResult = result;
      return result;
    }

    // Spawn helper --capabilities
    const result = await spawnHelperCapabilities(helperPath);
    cachedResult = result;
    return result;
  } catch (err) {
    const result: NvidiaCapabilityResult = {
      available: false,
      reason: `Capability probe error: ${err instanceof Error ? err.message : String(err)}`,
    };
    cachedResult = result;
    return result;
  }
}

function spawnHelperCapabilities(helperPath: string): Promise<NvidiaCapabilityResult> {
  return new Promise((resolve) => {
    const child = spawn(helperPath, ["--capabilities"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

    child.on("error", (err) => {
      resolve({
        available: false,
        reason: `Failed to launch helper: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      if (code !== 0 || !stdout) {
        resolve({
          available: false,
          reason: stderr.trim() || `Helper exited with code ${code}`,
        });
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve({
          available: parsed.available === true,
          reason: parsed.reason || "Unknown",
          adapterName: parsed.adapterName || undefined,
          driverVersion: parsed.driverVersion || undefined,
        });
      } catch {
        resolve({
          available: false,
          reason: "Failed to parse helper output",
        });
      }
    });
  });
}

/**
 * Invalidate the cached capability result (e.g., after helper restart or
 * driver change detected).
 */
export function invalidateNvidiaCapabilityCache(): void {
  cachedResult = null;
}
