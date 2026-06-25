// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/renderer/services/share-coordinator.js", () => ({
  stopShare: vi.fn().mockResolvedValue(undefined),
}));

describe("usePreloadEvents helpers", () => {
  it("subscribes to preload events and cleans up", async () => {
    const openCleanup = vi.fn();
    const stopCleanup = vi.fn();
    const diagnosticsCleanup = vi.fn();
    const handlers = {
      onOpenSourcePicker: vi.fn(),
      onStopSharing: vi.fn(),
      onOpenDiagnostics: vi.fn(),
    };

    const { subscribeToPreloadEvents } = await import("../src/renderer/hooks/use-preload-events.js");

    const cleanup = subscribeToPreloadEvents({
      onOpenSourcePicker: (callback) => {
        callback();
        return openCleanup;
      },
      onStopSharing: (callback) => {
        callback();
        return stopCleanup;
      },
      onOpenDiagnostics: (callback) => {
        callback();
        return diagnosticsCleanup;
      },
    }, handlers);

    expect(handlers.onOpenSourcePicker).toHaveBeenCalledTimes(1);
    expect(handlers.onStopSharing).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenDiagnostics).toHaveBeenCalledTimes(1);

    cleanup();

    expect(openCleanup).toHaveBeenCalledTimes(1);
    expect(stopCleanup).toHaveBeenCalledTimes(1);
    expect(diagnosticsCleanup).toHaveBeenCalledTimes(1);
  });

  it("returns a no-op cleanup when no preload API exists", async () => {
    const { subscribeToPreloadEvents } = await import("../src/renderer/hooks/use-preload-events.js");
    const cleanup = subscribeToPreloadEvents(undefined, {
      onOpenSourcePicker: vi.fn(),
      onStopSharing: vi.fn(),
      onOpenDiagnostics: vi.fn(),
    });

    expect(() => cleanup()).not.toThrow();
  });
});
