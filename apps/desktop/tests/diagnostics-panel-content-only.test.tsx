// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { TooltipProvider } from "../src/renderer/components/ui/tooltip.js";
import { DiagnosticsPanel } from "../src/renderer/components/workspace/viewer/DiagnosticsPanel.js";

function renderWithProviders(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("DiagnosticsPanel contentOnly", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("polls diagnostics immediately in contentOnly mode", async () => {
    const getDiagnostics = vi.fn().mockResolvedValue({
      connectionState: "connected",
      inboundVideo: {
        codecId: "VP9",
        packetsReceived: 100,
        packetsLost: 0,
        framesPerSecond: 30,
        frameWidth: 1280,
        frameHeight: 720,
        bitrateBps: 2_000_000,
        jitter: 2,
        framesDropped: 1,
        freezeCount: 0,
      },
      inboundAudio: {
        codecId: "opus",
        packetsReceived: 50,
        packetsLost: 0,
        bitrateBps: 64_000,
        jitter: 1,
      },
      selectedCandidatePair: { local: "1.1.1.1", remote: "2.2.2.2", state: "succeeded", nominated: true },
      localCandidateType: "host",
      remoteCandidateType: "srflx",
      rttMs: 10,
      timestamp: Date.now(),
    });

    const { container } = renderWithProviders(
      <DiagnosticsPanel session={{ getDiagnostics } as any} contentOnly>
        <span />
      </DiagnosticsPanel>,
    );

    await waitFor(() => {
      expect(getDiagnostics).toHaveBeenCalled();
      expect(container.textContent).toContain("connected");
      expect(container.textContent).toContain("VP9");
    });
  });
});
