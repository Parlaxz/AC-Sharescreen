// @vitest-environment node
/**
 * Tests for FallbackChainController — consecutive-failure reset/bleed fix,
 * stage transitions, and idempotent operations.
 *
 * Mocks nvidia-vsr-backend entirely because its isNvidiaVsrAvailable()
 * accesses `window` which is not available in node environment.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Fully mock nvidia-vsr-backend with controllable isNvidiaVsrAvailable.
vi.mock("../src/renderer/services/viewer-image-processing/nvidia-vsr-backend", () => ({
  isNvidiaVsrAvailable: vi.fn(),
  NvidiaVsrBackend: class MockNvidiaVsrBackend {
    kind = "nvidia-vsr" as const;
    instanceId = 999;
    async initialize() { return { success: true }; }
    updateSettings() {}
    resizeOutput() {}
    onSourceResize() {}
    async processFrame() { return { success: true }; }
    getStats() { return { backend: "nvidia-vsr", staleConfigDrops: 0 }; }
    async destroy() {}
  },
}));

import { FallbackChainController } from "../src/renderer/services/viewer-image-processing/fallback-chain-controller";
import type { ImageProcessingCapabilities } from "../src/renderer/services/viewer-image-processing/viewer-image-capabilities";

// Access the mocked isNvidiaVsrAvailable for per-test control.
// vi.mock hoists, so this import resolves to the mock version.
import { isNvidiaVsrAvailable } from "../src/renderer/services/viewer-image-processing/nvidia-vsr-backend";
const mockIsNvidiaAvailable = isNvidiaVsrAvailable as ReturnType<typeof vi.fn>;

// ─── Fixtures ─────────────────────────────────────────────────────────────

const defaultCaps: ImageProcessingCapabilities = {
  webgl2: true,
  nvidiaVsrAvailable: true,
  nvidiaCapabilityProbed: true,
};

const noNvidiaCaps: ImageProcessingCapabilities = {
  webgl2: true,
  nvidiaVsrAvailable: false,
  nvidiaCapabilityProbed: true,
};

// ─── Constructor / initial stage ────────────────────────────────────────

describe("FallbackChainController — initial stage selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts with nvidia-vsr when nvidia-vsr requested and SDK available", () => {
    mockIsNvidiaAvailable.mockReturnValue(true);
    const chain = new FallbackChainController("nvidia-vsr", defaultCaps);
    expect(chain.activeStage).toBe("nvidia-vsr");
    expect(chain.activeBackend.kind).toBe("nvidia-vsr");
    expect(chain.reason).toBeNull();
  });

  it("starts with webgl-fsr1 when nvidia-vsr requested but SDK unavailable", () => {
    mockIsNvidiaAvailable.mockReturnValue(false);
    const chain = new FallbackChainController("nvidia-vsr", noNvidiaCaps);
    expect(chain.activeStage).toBe("webgl-fsr1");
    expect(chain.activeBackend.kind).toBe("webgl2");
  });

  it("starts with webgl-fsr1 when webgl2 requested and SDK NOT available", () => {
    mockIsNvidiaAvailable.mockReturnValue(false);
    const chain = new FallbackChainController("webgl2", noNvidiaCaps);
    expect(chain.activeStage).toBe("webgl-fsr1");
    expect(chain.activeBackend.kind).toBe("webgl2");
  });

  it("stays on webgl-fsr1 when webgl2 is explicitly requested", () => {
    mockIsNvidiaAvailable.mockReturnValue(true);
    const chain = new FallbackChainController("webgl2", defaultCaps);
    expect(chain.activeStage).toBe("webgl-fsr1");
    expect(chain.activeBackend.kind).toBe("webgl2");
  });
});

// ─── Stage advancement ──────────────────────────────────────────────────

describe("FallbackChainController — stage advancement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsNvidiaAvailable.mockReturnValue(true);
  });

  async function makeChainFromStage(stage: "nvidia-vsr" | "webgl-fsr1"): Promise<FallbackChainController> {
    const chain = new FallbackChainController("nvidia-vsr", defaultCaps);
    expect(chain.activeStage).toBe("nvidia-vsr");
    if (stage === "webgl-fsr1") {
      const s = await chain.advance("SDK crash"); // → webgl-fsr1
      expect(s).toBe("webgl-fsr1");
    }
    return chain;
  }

  it("advances immediately from nvidia-vsr to webgl-fsr1 on first error", async () => {
    const chain = await makeChainFromStage("nvidia-vsr");
    const stage = await chain.advance("SDK crash");
    expect(stage).toBe("webgl-fsr1");
    expect(chain.activeStage).toBe("webgl-fsr1");
    expect(chain.reason).toBe("SDK crash");
  });

  it("stays on webgl-fsr1 after one failure (below MAX_FAILURES=3)", async () => {
    const chain = await makeChainFromStage("webgl-fsr1");
    const stage = await chain.advance("transient glitch");
    expect(stage).toBe("webgl-fsr1");
    expect(chain.activeStage).toBe("webgl-fsr1");
  });

  it("transitions to webgl-lanczos3 after 3 consecutive failures on webgl-fsr1", async () => {
    const chain = await makeChainFromStage("webgl-fsr1");
    await chain.advance("fail 1");
    await chain.advance("fail 2");
    const stage = await chain.advance("fail 3");
    expect(stage).toBe("webgl-lanczos3");
    expect(chain.activeStage).toBe("webgl-lanczos3");
  });

  it("stays on webgl-lanczos3 after one failure (below MAX_FAILURES=3)", async () => {
    const chain = await makeChainFromStage("webgl-fsr1");
    await chain.advance("1");
    await chain.advance("2");
    await chain.advance("3"); // → webgl-lanczos3
    expect(chain.activeStage).toBe("webgl-lanczos3");

    const stage = await chain.advance("lanczos glitch");
    expect(stage).toBe("webgl-lanczos3");
    expect(chain.activeStage).toBe("webgl-lanczos3");
  });

  it("transitions to original after 3 consecutive failures on webgl-lanczos3", async () => {
    const chain = await makeChainFromStage("webgl-fsr1");
    await chain.advance("1");
    await chain.advance("2");
    await chain.advance("3"); // → webgl-lanczos3
    await chain.advance("l1");
    await chain.advance("l2");
    const stage = await chain.advance("l3");
    expect(stage).toBe("original");
    expect(chain.activeStage).toBe("original");
  });

  it("fires onFatalError when at original stage", async () => {
    const onFatal = vi.fn();
    const chain = new FallbackChainController("nvidia-vsr", defaultCaps, { onFatalError: onFatal });
    expect(chain.activeStage).toBe("nvidia-vsr");
    await chain.advance("1");  // → webgl-fsr1
    await chain.advance("2");
    await chain.advance("3");
    await chain.advance("4");  // → webgl-lanczos3
    await chain.advance("l1");
    await chain.advance("l2");
    await chain.advance("l3"); // → original
    await chain.advance("final");
    expect(onFatal).toHaveBeenCalledWith("final");
  });
});

// ─── Consecutive-failure reset/bleed fix ────────────────────────────────

describe("FallbackChainController — consecutive-failure reset/bleed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsNvidiaAvailable.mockReturnValue(true);
  });

  it("recordSuccess resets the consecutive failure counter", async () => {
    const chain = new FallbackChainController("nvidia-vsr", defaultCaps);
    expect(chain.activeStage).toBe("nvidia-vsr");

    // Advance to webgl-fsr1 first (immediate transition)
    await chain.advance("nvidia crash"); // → webgl-fsr1
    expect((chain as any).consecutiveFailures).toBe(0); // reset by transitionTo

    // One more failure on webgl-fsr1
    await chain.advance("glitch");
    expect((chain as any).consecutiveFailures).toBe(1);

    // Record success — should reset counter
    chain.recordSuccess();
    expect((chain as any).consecutiveFailures).toBe(0);
  });

  it("recordSuccess prevents premature stage advancement from non-consecutive failures", async () => {
    // Without recordSuccess, 3 non-consecutive failures (with successes between)
    // would trigger advancement after 3 total failures.
    const chain = new FallbackChainController("nvidia-vsr", defaultCaps);
    await chain.advance("nvidia crash"); // → webgl-fsr1

    // Failure 1 → success → failure 2 → success → failure 3
    await chain.advance("f1");          // consecutiveFailures = 1
    chain.recordSuccess();              // consecutiveFailures = 0
    await chain.advance("f2");          // consecutiveFailures = 1
    chain.recordSuccess();              // consecutiveFailures = 0
    const stage = await chain.advance("f3"); // consecutiveFailures = 1

    // Should NOT have advanced — still on webgl-fsr1
    expect(stage).toBe("webgl-fsr1");
    expect(chain.activeStage).toBe("webgl-fsr1");
  });

  it("still advances after 3 truly consecutive failures despite previous successes", async () => {
    const chain = new FallbackChainController("nvidia-vsr", defaultCaps);
    await chain.advance("nvidia crash"); // → webgl-fsr1

    await chain.advance("f1");
    chain.recordSuccess();
    await chain.advance("f2");
    chain.recordSuccess();

    // Now 3 CONSECUTIVE failures — should advance
    await chain.advance("boom1");       // consecutiveFailures = 1
    await chain.advance("boom2");       // consecutiveFailures = 2
    const stage = await chain.advance("boom3"); // consecutiveFailures = 3

    expect(stage).toBe("webgl-lanczos3");
    expect(chain.activeStage).toBe("webgl-lanczos3");
  });

  it("recordSuccess is idempotent before any failure", () => {
    mockIsNvidiaAvailable.mockReturnValue(false);
    const chain = new FallbackChainController("webgl2", noNvidiaCaps);
    expect(() => chain.recordSuccess()).not.toThrow();
    expect((chain as any).consecutiveFailures).toBe(0);
  });

  it("does not affect counter when called multiple times", () => {
    mockIsNvidiaAvailable.mockReturnValue(false);
    const chain = new FallbackChainController("webgl2", noNvidiaCaps);
    chain.recordSuccess();
    chain.recordSuccess();
    chain.recordSuccess();
    expect((chain as any).consecutiveFailures).toBe(0);
  });
});

// ─── Destroy ────────────────────────────────────────────────────────────

describe("FallbackChainController — destroy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is idempotent", async () => {
    mockIsNvidiaAvailable.mockReturnValue(false);
    const chain = new FallbackChainController("webgl2", noNvidiaCaps);
    await chain.destroy();
    await chain.destroy(); // second should not throw
    expect((chain as any).destroyed).toBe(true);
  });

  it("advance is a no-op after destroy", async () => {
    mockIsNvidiaAvailable.mockReturnValue(false);
    const chain = new FallbackChainController("webgl2", noNvidiaCaps);
    expect(chain.activeStage).toBe("webgl-fsr1");
    await chain.destroy();
    const stage = await chain.advance("after-destroy");
    expect(stage).toBe("webgl-fsr1"); // unchanged
  });
});
