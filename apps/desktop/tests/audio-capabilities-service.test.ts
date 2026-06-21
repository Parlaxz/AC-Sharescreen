import { describe, it, expect } from "vitest";
import type { AudioCapabilityResult } from "@screenlink/shared";
import type { HelperResult } from "../src/main/audio-capability-service.js";

// We can't easily import the service due to Electron deps, but we CAN
// test the shared type and run the real helper as an integration test.
// For unit tests, we test the validateCapability logic by re-implementing
// a minimal validator and testing it directly.

function isValidCapability(obj: unknown): obj is AudioCapabilityResult {
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

describe("AudioCapabilityResult validation", () => {
  const validCap: Record<string, unknown> = {
    protocolVersion: "0.1.0",
    helperVersion: "0.1.0",
    architecture: "x64",
    status: "ok",
    operatingSystem: "Windows",
    detectionMethod: "RtlGetVersion",
    detectionSucceeded: true,
    compiledWindowsSdkVersion: "10.0.22000.0",
    processLoopbackHeadersAvailable: true,
    processLoopbackRuntimeSupported: false,
    applicationLoopbackSupported: false,
    usable: false,
    is64BitProcess: true,
    is64BitOperatingSystem: true,
    reasonCode: "unsupported-windows-build",
    reasonMessage: "Build 19045 is below 22000",
    osVersion: { major: 10, minor: 0, build: 19045, revision: 0 },
  };

  it("accepts a valid capability object", () => {
    expect(isValidCapability(validCap)).toBe(true);
  });

  it("rejects null", () => {
    expect(isValidCapability(null)).toBe(false);
  });

  it("rejects non-object", () => {
    expect(isValidCapability("string")).toBe(false);
  });

  it("rejects missing protocolVersion", () => {
    const { protocolVersion: _, ...rest } = validCap;
    expect(isValidCapability(rest)).toBe(false);
  });

  it("rejects wrong protocolVersion type", () => {
    expect(isValidCapability({ ...validCap, protocolVersion: 1 })).toBe(false);
  });

  it("rejects missing status field", () => {
    const { status: _, ...rest } = validCap;
    expect(isValidCapability(rest)).toBe(false);
  });

  it("rejects wrong status type", () => {
    expect(isValidCapability({ ...validCap, status: true })).toBe(false);
  });

  it("rejects missing usable field", () => {
    const { usable: _, ...rest } = validCap;
    expect(isValidCapability(rest)).toBe(false);
  });

  it("rejects wrong usable type", () => {
    expect(isValidCapability({ ...validCap, usable: "true" })).toBe(false);
  });

  it("rejects missing osVersion", () => {
    const { osVersion: _, ...rest } = validCap;
    expect(isValidCapability(rest)).toBe(false);
  });

  it("rejects null osVersion", () => {
    expect(isValidCapability({ ...validCap, osVersion: null })).toBe(false);
  });

  it("rejects osVersion without major", () => {
    expect(isValidCapability({ ...validCap, osVersion: { minor: 0 } })).toBe(false);
  });

  it("rejects empty object", () => {
    expect(isValidCapability({})).toBe(false);
  });

  it("rejects missing helperVersion", () => {
    const { helperVersion: _, ...rest } = validCap;
    expect(isValidCapability(rest)).toBe(false);
  });

  it("rejects missing architecture", () => {
    const { architecture: _, ...rest } = validCap;
    expect(isValidCapability(rest)).toBe(false);
  });

  it("rejects missing detectionMethod", () => {
    const { detectionMethod: _, ...rest } = validCap;
    expect(isValidCapability(rest)).toBe(false);
  });

  it("rejects missing reasonCode", () => {
    const { reasonCode: _, ...rest } = validCap;
    expect(isValidCapability(rest)).toBe(false);
  });

  it("rejects missing reasonMessage", () => {
    const { reasonMessage: _, ...rest } = validCap;
    expect(isValidCapability(rest)).toBe(false);
  });
});

describe("Audio capability integration", () => {
  it("real helper --capabilities returns valid output", { timeout: 10000 }, async () => {
    // Skip if we're not on Windows (CI or other platforms)
    if (process.platform !== "win32") {
      return;
    }

    const { spawn } = await import("child_process");
    const path = await import("path");

    const helperPath = path.join(
      __dirname, "..", "..", "..",
      "native", "audio-helper", "build", "Release",
      "screenlink-audio-helper.exe",
    );

    const { access } = await import("fs/promises");
    try {
      await access(helperPath);
    } catch {
      // Helper not built — skip test
      return;
    }

    const result = await new Promise<{ stdout: string; exitCode: number | null }>((resolve, reject) => {
      const child = spawn(helperPath, ["--capabilities"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("timeout"));
      }, 5000);

      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, exitCode: code });
      });
    });

    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.status).toBe("ok");
    expect(parsed.protocolVersion).toBe("0.1.0");
    expect(parsed.helperVersion).toBe("0.1.0");
    expect(parsed.architecture).toBe("x64");
    expect(parsed.operatingSystem).toBe("Windows");
    expect(parsed.detectionSucceeded).toBe(true);
    expect(parsed.detectionMethod).toBe("RtlGetVersion");

    // The helper correctly reports compile-time availability and runtime status
    expect(typeof parsed.processLoopbackHeadersAvailable).toBe("boolean");
    expect(typeof parsed.processLoopbackRuntimeSupported).toBe("boolean");
    expect(typeof parsed.usable).toBe("boolean");
    expect(typeof parsed.is64BitProcess).toBe("boolean");
    expect(typeof parsed.is64BitOperatingSystem).toBe("boolean");
    expect(typeof parsed.reasonCode).toBe("string");
    expect(typeof parsed.reasonMessage).toBe("string");

    // OS version should be a real number
    const osv = parsed.osVersion as Record<string, unknown>;
    expect(typeof osv.major).toBe("number");
    expect(typeof osv.build).toBe("number");
    expect((osv.build as number) > 0).toBe(true);
  });
});
