// @vitest-environment happy-dom
import { describe, expect, it, afterEach, vi } from "vitest";
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { formatBandwidth, formatTotalBytes, formatBitrateShort, BandwidthDisplay } from "../BandwidthDisplay";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StreamMetricsService } from "@/services/stream-metrics-service";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BandwidthDisplay formatting", () => {
  // ── formatBandwidth ────────────────────────────────────────────────
  describe("formatBandwidth", () => {
    it('returns "0 K" for zero', () => {
      expect(formatBandwidth(0)).toBe("0 K");
      expect(formatBandwidth(-1)).toBe("0 K");
    });

    it("formats bytes per second ranges correctly", () => {
      // 8000 bps = 1 KB/s → "1.0 K"
      expect(formatBandwidth(8000)).toBe("1.0 K");
      // 80_000 bps = 10 KB/s → "10.0 K"
      expect(formatBandwidth(80_000)).toBe("10.0 K");
    });

    it("formats Mbps ranges correctly", () => {
      // 8_000_000 bps = 1 MB/s → "1.00 M"
      expect(formatBandwidth(8_000_000)).toBe("1.00 M");
      // 80_000_000 bps = 10 MB/s → "10.00 M"
      expect(formatBandwidth(80_000_000)).toBe("10.00 M");
    });

    it("handles low bandwidth (< 1000 B/s)", () => {
      // 800 bps = 100 B/s
      expect(formatBandwidth(800)).toBe("100 B");
      // 80 bps = 10 B/s
      expect(formatBandwidth(80)).toBe("10 B");
    });

    it("total = video + audio semantics hold in formatted output", () => {
      const totalBps = 8_000_000;   // 1 MB/s → "1.00 M"
      const videoBps = 6_000_000;   // 750 kB/s → "750.0 K"
      const audioBps = 2_000_000;   // 250 kB/s → "250.0 K"

      const totalFormatted = formatBandwidth(totalBps);
      const videoFormatted = formatBandwidth(videoBps);
      const audioFormatted = formatBandwidth(audioBps);

      // Total displays as Mbps when >= 1 MB/s
      expect(totalFormatted).toBe("1.00 M");
      // Video and audio display in kB/s when < 1 MB/s
      expect(videoFormatted).toBe("750.0 K");
      expect(audioFormatted).toBe("250.0 K");
    });
  });

  // ── formatTotalBytes ────────────────────────────────────────────────
  describe("formatTotalBytes", () => {
    it('returns "0 B" for zero', () => {
      expect(formatTotalBytes(0)).toBe("0 B");
    });

    it("formats bytes", () => {
      expect(formatTotalBytes(500)).toBe("500 B");
    });

    it("formats kilobytes", () => {
      expect(formatTotalBytes(2048)).toBe("2.0 KB");
    });

    it("formats megabytes", () => {
      expect(formatTotalBytes(5_242_880)).toBe("5.0 MB"); // 5 MiB
    });

    it("formats gigabytes", () => {
      expect(formatTotalBytes(5_368_709_120)).toBe("5.00 GB"); // 5 GiB
    });
  });

  // ── formatBitrateShort ──────────────────────────────────────────────
  describe("formatBitrateShort", () => {
    it('returns "0" for zero', () => {
      expect(formatBitrateShort(0)).toBe("0");
    });

    it("formats B/s for low bitrates", () => {
      // 800 bps = 100 B/s
      expect(formatBitrateShort(800)).toBe("100 B/s");
    });

    it("formats kB/s", () => {
      // 80_000 bps = 10 kB/s
      expect(formatBitrateShort(80_000)).toBe("10.0 kB/s");
    });

    it("formats MB/s", () => {
      // 8_000_000 bps = 1 MB/s
      expect(formatBitrateShort(8_000_000)).toBe("1.00 MB/s");
    });
  });
});

describe("BandwidthDisplay store integration", () => {
  it("renders without an infinite external-store update loop", () => {
    const subscribe = vi.fn(() => () => {});
    const getSnapshot = vi.fn(() => ({
      aggregate: {
        rawSamples: [{ videoBitsPerSecond: 2_000_000, audioBitsPerSecond: 128_000 }],
      },
    }));

    vi.spyOn(StreamMetricsService, "getInstance").mockReturnValue({
      subscribe,
      getSnapshot,
    } as unknown as StreamMetricsService);

    expect(() => {
      render(
        createElement(
          TooltipProvider,
          null,
          createElement(BandwidthDisplay, {
            currentBandwidthBps: 2_128_000,
            totalBytesReceived: 1024,
            activeDurationMs: 1000,
            viewerHistoryId: "history-1",
            onOpenBandwidthModal: () => {},
          }),
        ),
      );
    }).not.toThrow();
  });
});
