// @vitest-environment happy-dom
/**
 * Real RTL behavior tests for StreamHistorySection.
 *
 * Tests:
 * 1. Pending getHistory renders accessible loading skeleton markers
 * 2. Rejected getHistory renders error Alert + Retry; Retry calls
 *    getHistory again then shows recovered records
 * 3. Clicking a record row expands detail panel; clicking again collapses it
 *
 * Uses controllable promises and observable DOM only — no source-string assertions.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import React from "react";

// ─── Controllable promise helper ────────────────────────────────────────────

interface ControlledPromise<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function makeControlledPromise<T>(): ControlledPromise<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ─── Record factory ─────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<Record<string, unknown>> & { historyId: string }) {
  return {
    role: "host" as const,
    groupName: "Test Group",
    durationMs: 120_000,
    startedAt: Date.now() - 120_000,
    totalBytes: 2_000_000,
    averageBytesPerSecond: 1_000_000,
    interrupted: false,
    mediaSessionId: "session-abc123",
    samples: [
      { timestamp: Date.now() - 100_000, bytesPerSecond: 800_000, totalBytes: 800_000 },
      { timestamp: Date.now() - 50_000, bytesPerSecond: 1_200_000, totalBytes: 1_200_000 },
    ],
    markers: [
      { timestamp: Date.now() - 90_000, type: "bitrate", label: "Bitrate changed", from: "500 kbps", to: "1000 kbps" },
    ],
    presetName: "High Quality",
    customQuality: false,
    ...overrides,
  };
}

// ─── Mocks ──────────────────────────────────────────────────────────────────

let mockGetHistory: ReturnType<typeof vi.fn>;
let mockSetOnHistoryChanged: ReturnType<typeof vi.fn>;

vi.mock("@/services/stream-metrics-service", () => ({
  StreamMetricsService: {
    getInstance: vi.fn(() => ({
      getHistory: (...args: unknown[]) => mockGetHistory(...args),
      setOnHistoryChanged: (...args: unknown[]) => mockSetOnHistoryChanged(...args),
    })),
  },
}));

import { StreamHistorySection } from "@/components/settings/StreamHistorySection";
import * as streamMetricsService from "@/services/stream-metrics-service";

beforeEach(() => {
  mockGetHistory = vi.fn();
  mockSetOnHistoryChanged = vi.fn();
  vi.mocked(streamMetricsService.StreamMetricsService.getInstance).mockReturnValue(
    {
      getHistory: mockGetHistory,
      setOnHistoryChanged: mockSetOnHistoryChanged,
    } as unknown as streamMetricsService.StreamMetricsService,
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("StreamHistorySection behavior", () => {
  /* ──────────────── 1. Loading skeleton markers ──────────────── */
  describe("loading state", () => {
    it("renders accessible skeleton markers while getHistory is pending", () => {
      const { promise } = makeControlledPromise<never[]>();
      mockGetHistory.mockReturnValue(promise);

      render(React.createElement(StreamHistorySection));

      // The loading skeleton container must be present
      const loadingContainer = screen.getByTestId("stream-history-loading");
      expect(loadingContainer).toBeTruthy();

      // The count skeleton must also be present
      const countSkeleton = screen.getByTestId("history-count-skeleton");
      expect(countSkeleton).toBeTruthy();

      // The record count text must NOT be shown while loading
      expect(screen.queryByText(/session/)).toBeNull();
    });

    it("does not show empty state or records while loading", () => {
      const { promise } = makeControlledPromise<never[]>();
      mockGetHistory.mockReturnValue(promise);

      render(React.createElement(StreamHistorySection));

      // Empty state must not show
      expect(screen.queryByText("No past streams yet.")).toBeNull();

      // Error state must not show
      expect(screen.queryByText("Failed to load stream history")).toBeNull();
    });
  });

  /* ──────────────── 2. Error + Retry → recovery ──────────────── */
  describe("error and retry", () => {
    it("renders error Alert with message when getHistory rejects", async () => {
      mockGetHistory.mockRejectedValue(new Error("Connection failed"));

      render(React.createElement(StreamHistorySection));

      // Error alert must appear
      const alertTitle = await screen.findByText("Failed to load stream history");
      expect(alertTitle).toBeTruthy();

      // Error description must contain the error message
      const alertDesc = screen.getByText("Connection failed");
      expect(alertDesc).toBeTruthy();

      // Retry button must be present
      const retryBtn = screen.getByText("Retry");
      expect(retryBtn).toBeTruthy();
    });

    it("Retry calls getHistory again and shows recovered records on success", async () => {
      // First call: reject
      mockGetHistory.mockRejectedValueOnce(new Error("Temporary failure"));

      render(React.createElement(StreamHistorySection));

      // Wait for error state
      await screen.findByText("Failed to load stream history");

      // Configure second call: resolve with records
      const records = [makeRecord({ historyId: "hist-1", groupName: "Recovered Stream" })];
      mockGetHistory.mockResolvedValueOnce(records);

      // Click Retry
      fireEvent.click(screen.getByText("Retry"));

      // The error should disappear and records should appear
      await vi.waitFor(() => {
        expect(screen.queryByText("Failed to load stream history")).toBeNull();
      });

      // The recovered record should be visible
      expect(await screen.findByText("Recovered Stream")).toBeTruthy();

      // getHistory must have been called twice
      expect(mockGetHistory).toHaveBeenCalledTimes(2);
    });

    it("Retry preserves records from a previous successful load on subsequent failure", async () => {
      // First call: success with records
      const records = [makeRecord({ historyId: "hist-1", groupName: "Original Stream" })];
      mockGetHistory.mockResolvedValueOnce(records);

      render(React.createElement(StreamHistorySection));

      // Wait for records
      await screen.findByText("Original Stream");

      // Second call: failure
      mockGetHistory.mockRejectedValueOnce(new Error("Network error"));

      // Trigger a reload (simulate onHistoryChanged calling load)
      // The setOnHistoryChanged callback is set; let's call it manually
      // by extracting the callback from the mock
      const onChangedCallback = mockSetOnHistoryChanged.mock.calls[0]?.[0];
      if (onChangedCallback) {
        onChangedCallback();
      }

      // Wait for error state
      await screen.findByText("Failed to load stream history");

      // The original records should still be visible (preserved)
      expect(screen.getByText("Original Stream")).toBeTruthy();

      // The session count should still show
      expect(screen.getByText("1 session")).toBeTruthy();
    });
  });

  /* ──────────────── 3. Expand / collapse ──────────────── */
  describe("expand and collapse", () => {
    it("clicking a record row expands detail panel with session info", async () => {
      const records = [makeRecord({ historyId: "hist-1", groupName: "Expandable Stream" })];
      mockGetHistory.mockResolvedValue(records);

      render(React.createElement(StreamHistorySection));

      // Wait for record to render
      await screen.findByText("Expandable Stream");

      // Details should NOT be visible initially
      expect(screen.queryByText(/Session:/)).toBeNull();
      expect(screen.queryByText(/Avg rate:/)).toBeNull();

      // Click the record button
      const recordBtn = screen.getByText("Expandable Stream").closest("button");
      expect(recordBtn).toBeTruthy();
      fireEvent.click(recordBtn!);

      // Expanded details should now be visible
      await vi.waitFor(() => {
        expect(screen.getByText(/Session:/)).toBeTruthy();
      });
      expect(screen.getByText(/Avg rate:/)).toBeTruthy();
      expect(screen.getByText(/Duration:/)).toBeTruthy();
      expect(screen.getByText(/Total:/)).toBeTruthy();
      expect(screen.getByText(/Samples:/)).toBeTruthy();
      expect(screen.getByText(/Status:/)).toBeTruthy();

      // The "Changes" section should be visible (has markers)
      expect(screen.getByText("Changes")).toBeTruthy();

      // The sparkline should be visible (has samples)
      expect(screen.getByText(/avg/)).toBeTruthy();
    });

    it("clicking a record row again collapses the detail panel", async () => {
      const records = [makeRecord({ historyId: "hist-1", groupName: "Collapsible Stream" })];
      mockGetHistory.mockResolvedValue(records);

      render(React.createElement(StreamHistorySection));

      // Wait for record
      await screen.findByText("Collapsible Stream");

      // Click to expand
      const recordBtn = screen.getByText("Collapsible Stream").closest("button");
      expect(recordBtn).toBeTruthy();
      fireEvent.click(recordBtn!);

      // Wait for details to appear
      await screen.findByText(/Session:/);

      // Click again to collapse
      fireEvent.click(recordBtn!);

      // Details should disappear
      await vi.waitFor(() => {
        expect(screen.queryByText(/Session:/)).toBeNull();
      });
    });

    it("expand and collapse work independently for multiple records", async () => {
      const records = [
        makeRecord({ historyId: "hist-1", groupName: "First Stream" }),
        makeRecord({ historyId: "hist-2", groupName: "Second Stream", role: "viewer", remoteDisplayName: "Second Stream" }),
      ];
      mockGetHistory.mockResolvedValue(records);

      render(React.createElement(StreamHistorySection));

      // Wait for both records
      await screen.findByText("First Stream");
      expect(screen.getByText("Second Stream")).toBeTruthy();

      // Expand first record
      const firstBtn = screen.getByText("First Stream").closest("button")!;
      fireEvent.click(firstBtn);

      // First details visible
      await screen.findByText(/Session:/);
      // There should be one set of session details (for first record)
      const sessionLabels = screen.getAllByText(/Session:/);
      expect(sessionLabels.length).toBe(1);

      // Expand second record (first should stay expanded)
      const secondBtn = screen.getByText("Second Stream").closest("button")!;
      fireEvent.click(secondBtn);

      // Now both expanded — two session detail labels
      await vi.waitFor(() => {
        expect(screen.getAllByText(/Session:/).length).toBe(2);
      });

      // Collapse first record
      fireEvent.click(firstBtn);
      await vi.waitFor(() => {
        expect(screen.getAllByText(/Session:/).length).toBe(1);
      });

      // Collapse second record
      fireEvent.click(secondBtn);
      await vi.waitFor(() => {
        expect(screen.queryByText(/Session:/)).toBeNull();
      });
    });

    it("records with no samples still expand (sparkline shows 'No data')", async () => {
      const records = [
        makeRecord({ historyId: "hist-1", groupName: "No Samples Stream", samples: [], markers: [] }),
      ];
      mockGetHistory.mockResolvedValue(records);

      render(React.createElement(StreamHistorySection));

      await screen.findByText("No Samples Stream");

      const recordBtn = screen.getByText("No Samples Stream").closest("button")!;
      fireEvent.click(recordBtn);

      // Should show "No data" for sparkline
      expect(await screen.findByText("No data")).toBeTruthy();

      // Should still show session details
      expect(screen.getByText(/Duration:/)).toBeTruthy();

      // Should NOT show "Changes" (no markers)
      expect(screen.queryByText("Changes")).toBeNull();
    });
  });
});
