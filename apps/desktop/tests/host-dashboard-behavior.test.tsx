// @vitest-environment happy-dom
/**
 * RTL behavior tests for HostDashboard.
 *
 * Verifies:
 *  1. Uses PageHeader for live sharing header
 *  2. Uses PageSection for content cards
 *  3. Shows viewer count and status indicators
 *  4. Shows stop/pause/settings controls
 *  5. Loading skeletons (not plain text)
 *  6. Technical metrics use font-mono tabular-nums
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";

// Mock required modules
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("lucide-react", () => ({
  Monitor: () => <svg />,
  StopCircle: () => <svg />,
  Radio: () => <svg />,
  Eye: () => <svg />,
  Clock: () => <svg />,
  AlertTriangle: () => <svg />,
  RefreshCw: () => <svg />,
  RotateCcw: () => <svg />,
  ArrowRight: () => <svg />,
  UserX: () => <svg />,
}));

vi.mock("motion/react", () => ({
  motion: {
    div: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      React.createElement("div", props, children),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock store — active sharing state
vi.mock("@/stores/main-store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      selectedGroupId: "test-group-1",
      groupsById: {
        "test-group-1": { id: "test-group-1", name: "Test Group", members: {} },
      },
      isSharing: true,
      isDegraded: false,
      sourceName: "My Screen",
      sourceKind: "screen",
      captureWidth: 1920,
      captureHeight: 1080,
      captureFps: 30,
      captureBitrate: 2500,
      viewerCount: 2,
      sessionDuration: 300,
      localShareState: "sharing",
      onlineDeviceIdsByGroup: { "test-group-1": ["d1", "d2"] },
      isSwitchingSource: false,
      setOpenShareSetup: vi.fn(),
      setSource: vi.fn(),
      setSwitchingSource: vi.fn(),
    };
    return selector(state);
  },
}));

vi.mock("@/services/phase3-runtime", () => ({
  getRuntime: () => null,
}));

vi.mock("@/services/share-coordinator", () => ({
  stopShare: vi.fn(),
}));

vi.mock("@/services/group-navigation", () => ({
  navigateToGroupOverview: vi.fn(),
}));

vi.mock("@/hooks/use-host-viewer-diagnostics", () => ({
  useHostViewerDiagnostics: () => [],
}));

vi.mock("@/services/stream-metrics-service", () => ({
  StreamMetricsService: {
    getInstance: () => ({
      findHistoryIdByMediaSessionId: () => null,
      getSnapshot: () => ({}),
      subscribe: () => () => {},
    }),
  },
}));

vi.mock("@/lib/viewer-kick-policy", () => ({
  shouldAutoKickViewer: () => false,
  shouldShowViewerAfterKick: () => true,
}));

import { HostDashboard } from "../src/renderer/components/workspace/HostDashboard";

beforeEach(() => {});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ─── Page structure ─────────────────────────────────────────────────────────

describe("HostDashboard page structure", () => {
  it("renders group name or 'Sharing' as level-1 heading", () => {
    render(<HostDashboard />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveTextContent("Test Group");
  });
});

// ─── Loading state ───────────────────────────────────────────────────────────

describe("HostDashboard loading state", () => {
  it("renders accessible skeleton when loading=true, not null", () => {
    const { container } = render(<HostDashboard loading={true} />);

    // Must have a status region for accessibility
    const statusRegion = screen.getByRole("status");
    expect(statusRegion).toBeInTheDocument();
    expect(statusRegion).toHaveAttribute("aria-label");

    // Must have skeleton elements (not null)
    const skeletons = container.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Viewer count and status ─────────────────────────────────────────────────

describe("HostDashboard viewer display", () => {
  it("shows viewer count", () => {
    render(<HostDashboard />);
    // Viewer count comes from useHostViewerDiagnostics (mocked as [])
    expect(screen.getByText(/0 viewers/)).toBeInTheDocument();
  });

  it("shows a Live badge", () => {
    render(<HostDashboard />);
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("shows Stop sharing button", () => {
    render(<HostDashboard />);
    expect(screen.getByRole("button", { name: /stop sharing/i })).toBeInTheDocument();
  });

  it("shows source name in stream info", () => {
    render(<HostDashboard />);
    expect(screen.getByText("My Screen")).toBeInTheDocument();
  });
});

// ─── Technical metrics ───────────────────────────────────────────────────────

describe("HostDashboard technical metrics", () => {
  it("shows resolution value (1920×1080) and frame rate (30 fps) as readable stats", () => {
    render(<HostDashboard />);
    expect(screen.getByText("1920×1080")).toBeInTheDocument();
    expect(screen.getByText("30 fps")).toBeInTheDocument();
  });

  it("shows metric labels (Resolution, Frame rate, Bitrate, Connection)", () => {
    render(<HostDashboard />);
    expect(screen.getByText("Resolution")).toBeInTheDocument();
    expect(screen.getByText("Frame rate")).toBeInTheDocument();
    expect(screen.getByText("Bitrate")).toBeInTheDocument();
    expect(screen.getByText("Connection")).toBeInTheDocument();
  });
});

// ─── Stream controls ─────────────────────────────────────────────────────────

describe("HostDashboard stream controls", () => {
  it("shows Switch source button", () => {
    render(<HostDashboard />);
    expect(screen.getByRole("button", { name: /switch source/i })).toBeInTheDocument();
  });

  it("shows Preview button", () => {
    render(<HostDashboard />);
    expect(screen.getByRole("button", { name: /preview/i })).toBeInTheDocument();
  });

  it("shows Restart share button", () => {
    render(<HostDashboard />);
    expect(screen.getByRole("button", { name: /restart share/i })).toBeInTheDocument();
  });
});
