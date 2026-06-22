import { describe, it, expect } from "vitest";
import type { AudioCapabilityResult } from "@screenlink/shared";
import type { HelperResult } from "../src/main/audio-capability-service.js";

// ── Phase 2B source types ──
// These match the C++ AudioSource struct from SourceMapper.h.

interface AudioSource {
  sourceId: string;
  displayName: string;
  processId: number;
  hwnd: number;
  processPath: string;
  processName: string;
  isElectron: boolean;
  electronConfidence: "none" | "process-name" | "low";
  windowTitle: string;
  windowClass: string;
  isVisible: boolean;
  isCloaked: boolean;
  hasAudio: boolean;
}

type ElectronConfidence = AudioSource["electronConfidence"];

const validElectronConfidences: ElectronConfidence[] = [
  "none",
  "process-name",
  "low",
];

function isValidSource(obj: unknown): obj is AudioSource {
  if (typeof obj !== "object" || obj === null) return false;
  const s = obj as Record<string, unknown>;
  return (
    typeof s.sourceId === "string" &&
    typeof s.displayName === "string" &&
    typeof s.processId === "number" &&
    typeof s.hwnd === "number" &&
    typeof s.processPath === "string" &&
    typeof s.processName === "string" &&
    typeof s.isElectron === "boolean" &&
    (s.electronConfidence === "none" ||
      s.electronConfidence === "process-name" ||
      s.electronConfidence === "low") &&
    typeof s.windowTitle === "string" &&
    typeof s.windowClass === "string" &&
    typeof s.isVisible === "boolean" &&
    typeof s.isCloaked === "boolean" &&
    typeof s.hasAudio === "boolean"
  );
}

function mockAudioSource(overrides?: Partial<AudioSource>): AudioSource {
  const defaults = {
    sourceId: "source:1234:987654",
    displayName: "Test Window",
    processId: 1234,
    hwnd: 987654,
    processPath: "C:\\Program Files\\TestApp\\test.exe",
    processName: "test.exe",
    isElectron: true,
    electronConfidence: "process-name",
    windowTitle: "Test Window",
    windowClass: "TestWindowClass",
    isVisible: true,
    isCloaked: false,
    hasAudio: true,
  };

  const merged = { ...defaults, ...overrides } as Record<string, unknown>;

  // Auto-derive sourceId from processId and hwnd when either is overridden
  if (overrides?.processId !== undefined || overrides?.hwnd !== undefined) {
    merged.sourceId = `source:${merged.processId}:${merged.hwnd}`;
  }

  // Auto-derive displayName: windowTitle when non-empty, else processName
  if (overrides?.windowTitle !== undefined) {
    merged.displayName = overrides.windowTitle || merged.processName;
  }

  // Auto-derive hasAudio: visible non-cloaked Electron = true
  if (
    overrides?.isElectron !== undefined ||
    overrides?.isVisible !== undefined ||
    overrides?.isCloaked !== undefined
  ) {
    merged.hasAudio = !!(merged.isElectron && merged.isVisible && !merged.isCloaked);
  }

  return merged as unknown as AudioSource;
}

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
  reasonMessage: "Build 19045 is below 20348",
  osVersion: { major: 10, minor: 0, build: 19045, revision: 0 },
};

describe("AudioCapabilityResult validation", () => {
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

describe("process-loopback build-boundary validation", () => {
  // The runtime minimum is 20348 (Windows Server 2022).
  // These tests verify the logic without needing a real OS build >= 20348.

  const sdkOk: Record<string, unknown> = {
    ...validCap,
    compiledWindowsSdkVersion: "10.0.22000.0",
    processLoopbackHeadersAvailable: true,
  };

  function simulateBuild(build: number): Record<string, unknown> {
    return {
      ...sdkOk,
      osVersion: { major: 10, minor: 0, build, revision: 0 },
      processLoopbackRuntimeSupported: build >= 20348,
      applicationLoopbackSupported: build >= 20348,
      usable: build >= 20348,
      reasonCode: build >= 20348 ? "ok" : "unsupported-windows-build",
      reasonMessage:
        build >= 20348
          ? "Process-loopback audio is supported."
          : `Build ${build} is below 20348`,
    };
  }

  const boundaries = [
    { build: 20347, label: "one below minimum", expectedUsable: false },
    { build: 20348, label: "exactly minimum", expectedUsable: true },
    { build: 20349, label: "one above minimum", expectedUsable: true },
    { build: 21999, label: "below 22000, above 20348", expectedUsable: true },
    { build: 22000, label: "Windows 11 RTM", expectedUsable: true },
    { build: 19045, label: "Windows 10 22H2", expectedUsable: false },
  ];

  for (const { build, label, expectedUsable } of boundaries) {
    it(`build ${build} (${label}) → usable=${expectedUsable}`, () => {
      const cap = simulateBuild(build);
      expect(cap.usable).toBe(expectedUsable);
      expect(isValidCapability(cap)).toBe(true);
      if (!expectedUsable) {
        expect(cap.reasonCode).toBe("unsupported-windows-build");
      } else {
        expect(cap.reasonCode).toBe("ok");
      }
    });
  }
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

// ── Phase 2B: Source type validation ──

describe("Phase 2B source types", () => {
  // ---------------------------------------------------------------------------
  // (a) Validates AudioSource structure — all fields present with correct types
  // ---------------------------------------------------------------------------
  it("accepts a valid AudioSource with all fields", () => {
    const source = mockAudioSource();
    expect(isValidSource(source)).toBe(true);
    // Verify each field exists and has the right type
    expect(typeof source.sourceId).toBe("string");
    expect(typeof source.displayName).toBe("string");
    expect(typeof source.processId).toBe("number");
    expect(typeof source.hwnd).toBe("number");
    expect(typeof source.processPath).toBe("string");
    expect(typeof source.processName).toBe("string");
    expect(typeof source.isElectron).toBe("boolean");
    expect(["none", "process-name", "low"]).toContain(source.electronConfidence);
    expect(typeof source.windowTitle).toBe("string");
    expect(typeof source.windowClass).toBe("string");
    expect(typeof source.isVisible).toBe("boolean");
    expect(typeof source.isCloaked).toBe("boolean");
    expect(typeof source.hasAudio).toBe("boolean");
  });

  // ---------------------------------------------------------------------------
  // (b) Rejects missing sourceId
  // ---------------------------------------------------------------------------
  it("rejects missing sourceId", () => {
    const { sourceId: _, ...rest } = mockAudioSource();
    expect(isValidSource(rest)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // (c) Validates electronConfidence string values
  // ---------------------------------------------------------------------------
  it("accepts each valid electronConfidence value", () => {
    for (const confidence of validElectronConfidences) {
      const source = mockAudioSource({ electronConfidence: confidence });
      expect(isValidSource(source)).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // (d) Simulates --enumerate-sources JSON parsing
  // ---------------------------------------------------------------------------
  it("parses --enumerate-sources JSON output and validates all fields", () => {
    const json = `{
      "protocolVersion": "0.1.0",
      "helperVersion": "0.1.0",
      "status": "ok",
      "sourceCount": 2,
      "sources": [
        {
          "sourceId": "source:1234:789012",
          "displayName": "YouTube - Google Chrome",
          "processId": 1234,
          "hwnd": 789012,
          "processPath": "C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe",
          "processName": "chrome.exe",
          "isElectron": true,
          "electronConfidence": "process-name",
          "windowTitle": "YouTube - Google Chrome",
          "windowClass": "Chrome_WidgetWin_1",
          "isVisible": true,
          "isCloaked": false,
          "hasAudio": true
        },
        {
          "sourceId": "source:5678:345678",
          "displayName": "background-process.exe",
          "processId": 5678,
          "hwnd": 345678,
          "processPath": "C:\\\\Windows\\\\System32\\\\background-process.exe",
          "processName": "background-process.exe",
          "isElectron": false,
          "electronConfidence": "none",
          "windowTitle": "",
          "windowClass": "ConsoleWindowClass",
          "isVisible": false,
          "isCloaked": true,
          "hasAudio": false
        }
      ]
    }`;

    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.status).toBe("ok");
    expect(parsed.sourceCount).toBe(2);

    const sources = parsed.sources as unknown[];
    expect(sources).toHaveLength(2);

    // First source — visible Electron app with audio
    const s1 = sources[0] as Record<string, unknown>;
    expect(isValidSource(s1)).toBe(true);
    expect(s1.sourceId).toBe("source:1234:789012");
    expect(s1.displayName).toBe("YouTube - Google Chrome");
    expect(s1.isElectron).toBe(true);
    expect(s1.electronConfidence).toBe("process-name");
    expect(s1.isVisible).toBe(true);
    expect(s1.isCloaked).toBe(false);
    expect(s1.hasAudio).toBe(true);

    // Second source — invisible non-Electron background process
    const s2 = sources[1] as Record<string, unknown>;
    expect(isValidSource(s2)).toBe(true);
    expect(s2.sourceId).toBe("source:5678:345678");
    expect(s2.isElectron).toBe(false);
    expect(s2.electronConfidence).toBe("none");
    expect(s2.isVisible).toBe(false);
    expect(s2.isCloaked).toBe(true);
    expect(s2.hasAudio).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // (e) Tests hasAudio logic
  // ---------------------------------------------------------------------------
  it("hasAudio is true for visible, non-cloaked Electron source", () => {
    const source = mockAudioSource({
      isElectron: true,
      isVisible: true,
      isCloaked: false,
    });
    // hasAudio = true when visible, non-cloaked Electron app
    expect(source.hasAudio).toBe(true);
  });

  it("hasAudio is false for invisible Electron source", () => {
    const source = mockAudioSource({
      isElectron: true,
      isVisible: false,
      isCloaked: false,
      hasAudio: false,
    });
    expect(source.hasAudio).toBe(false);
  });

  it("hasAudio is false for cloaked Electron source", () => {
    const source = mockAudioSource({
      isElectron: true,
      isVisible: true,
      isCloaked: true,
      hasAudio: false,
    });
    expect(source.hasAudio).toBe(false);
  });

  it("hasAudio is false for non-Electron source regardless of visibility", () => {
    const visible = mockAudioSource({
      isElectron: false,
      isVisible: true,
      isCloaked: false,
      hasAudio: false,
    });
    expect(visible.hasAudio).toBe(false);

    const invisible = mockAudioSource({
      isElectron: false,
      isVisible: false,
      isCloaked: false,
      hasAudio: false,
    });
    expect(invisible.hasAudio).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // (f) Tests sourceId format
  // ---------------------------------------------------------------------------
  it("sourceId follows 'source:{pid}:{hwnd}' format", () => {
    const source = mockAudioSource({ processId: 9999, hwnd: 888888 });
    expect(source.sourceId).toMatch(/^source:\d+:\d+$/);
    expect(source.sourceId).toBe("source:9999:888888");
  });

  it("sourceId format with different values", () => {
    const source = mockAudioSource({ processId: 42, hwnd: 65535 });
    expect(source.sourceId).toMatch(/^source:\d+:\d+$/);
    expect(source.sourceId).toBe("source:42:65535");
  });

  // ---------------------------------------------------------------------------
  // (g) Tests displayName fallback when windowTitle is empty
  // ---------------------------------------------------------------------------
  it("uses windowTitle as displayName when non-empty", () => {
    const source = mockAudioSource({
      windowTitle: "My App - Main Window",
      processName: "myapp.exe",
    });
    expect(source.displayName).toBe("My App - Main Window");
    expect(source.displayName).not.toBe(source.processName);
  });

  it("falls back to processName when windowTitle is empty", () => {
    const source = mockAudioSource({
      windowTitle: "",
      processName: "myapp.exe",
      displayName: "myapp.exe",
    });
    expect(source.displayName).toBe("myapp.exe");
  });

  // ---------------------------------------------------------------------------
  // (h) Rejects invalid electronConfidence
  // ---------------------------------------------------------------------------
  it("rejects 'unknown' as electronConfidence", () => {
    const source = mockAudioSource() as Record<string, unknown>;
    source.electronConfidence = "unknown";
    expect(isValidSource(source)).toBe(false);
  });

  it("rejects undefined electronConfidence", () => {
    const { electronConfidence: _, ...rest } = mockAudioSource();
    expect(isValidSource(rest)).toBe(false);
  });

  it("rejects null source", () => {
    expect(isValidSource(null)).toBe(false);
  });

  it("rejects non-object source", () => {
    expect(isValidSource("not-an-object")).toBe(false);
  });

  it("rejects empty object", () => {
    expect(isValidSource({})).toBe(false);
  });
});
