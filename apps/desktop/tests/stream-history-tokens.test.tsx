// @vitest-environment happy-dom
/**
 * Behavioral tests for StreamHistorySection semantic token migration.
 *
 * Tests that:
 * - No hardcoded Tailwind color classes (blue-, amber-, green-) are used
 * - Semantic tokens (accent, warning, success, text-secondary) are used instead
 * - Component renders correctly with mock data
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";

// ─── Mocks ─────────────────────────────────────────────────────────────────

vi.mock("@/services/stream-metrics-service", () => ({
  StreamMetricsService: {
    getInstance: vi.fn(() => ({
      getHistory: vi.fn(),
      setOnHistoryChanged: vi.fn(),
    })),
  },
}));

import { StreamHistorySection } from "@/components/settings/StreamHistorySection";
import * as streamMetricsService from "@/services/stream-metrics-service";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("StreamHistorySection token migration", () => {
  it("shows empty state when no records", async () => {
    const mockInstance = {
      getHistory: vi.fn().mockResolvedValue([]),
      setOnHistoryChanged: vi.fn(),
    };
    vi.mocked(streamMetricsService.StreamMetricsService.getInstance).mockReturnValue(
      mockInstance as unknown as streamMetricsService.StreamMetricsService,
    );

    render(React.createElement(StreamHistorySection));
    const emptyText = await screen.findByText("No past streams yet.");
    expect(emptyText).toBeTruthy();
  });

  it("renders records with semantic colors (no hardcoded blue/amber/green)", async () => {
    const mockRecords = [
      {
        historyId: "hist-1",
        role: "host",
        groupName: "Test Group",
        durationMs: 60000,
        startedAt: Date.now() - 60000,
        totalBytes: 1024 * 1024,
        averageBytesPerSecond: 1024 * 100,
        interrupted: false,
        mediaSessionId: "session-1",
        samples: [],
        markers: [],
        presetName: "High Quality",
        customQuality: false,
      },
      {
        historyId: "hist-2",
        role: "viewer",
        remoteDisplayName: "Remote User",
        durationMs: 30000,
        startedAt: Date.now() - 30000,
        totalBytes: 512 * 1024,
        averageBytesPerSecond: 512 * 100,
        interrupted: true,
        mediaSessionId: "session-2",
        samples: [],
        markers: [],
      },
    ];

    const mockInstance = {
      getHistory: vi.fn().mockResolvedValue(mockRecords),
      setOnHistoryChanged: vi.fn(),
    };
    vi.mocked(streamMetricsService.StreamMetricsService.getInstance).mockReturnValue(
      mockInstance as unknown as streamMetricsService.StreamMetricsService,
    );

    const { container } = render(React.createElement(StreamHistorySection));

    // Wait for records to render
    await screen.findByText("Test Group");

    // Check that the semantic token classes are used
    const hostBadge = screen.getByText("HOST");
    expect(hostBadge.className).toContain("text-accent");

    const viewBadge = screen.getByText("VIEW");
    expect(viewBadge.className).toContain("text-text-secondary");

    const doneBadge = screen.getByText("Done");
    expect(doneBadge.className).toContain("text-success");

    const interruptedBadge = screen.getByText("Interrupted");
    expect(interruptedBadge.className).toContain("text-warning");

    // Verify NO hardcoded color classes
    expect(container.innerHTML).not.toContain("text-blue-400");
    expect(container.innerHTML).not.toContain("bg-blue-500/10");
    expect(container.innerHTML).not.toContain("text-amber-400");
    expect(container.innerHTML).not.toContain("bg-amber-500/10");
    expect(container.innerHTML).not.toContain("text-green-400");
    expect(container.innerHTML).not.toContain("bg-green-500/10");
  });
});
