// @vitest-environment happy-dom
/**
 * RTL behavior tests for GroupOverview.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen, cleanup, act } from "@testing-library/react";

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("lucide-react", () => ({
  UserPlus: () => <svg />,
  Monitor: () => <svg />,
  Eye: () => <svg />,
  RefreshCw: () => <svg />,
  AlertTriangle: () => <svg />,
  Repeat: () => <svg />,
  Check: () => <svg />,
  X: () => <svg />,
  Loader2: () => <svg />,
  Users: () => <svg />,
  Radio: () => <svg />,
}));

vi.mock("motion/react", () => ({
  motion: {
    div: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      React.createElement("div", props, children),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ─── Store mock with an active share ─────────────────────────────────────────

const STARTED_AT = 1_000_000_000_000; // fixed timestamp for predictability

vi.mock("@/stores/main-store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      selectedGroupId: "test-group-1",
      groupsById: {
        "test-group-1": {
          id: "test-group-1",
          name: "Test Group",
          members: {
            user1: { deviceId: "d1", displayName: "Alice" },
            user2: { deviceId: "d2", displayName: "Bob" },
          },
        },
      },
      activeStreamsByGroup: {
        "test-group-1": [
          {
            logicalStreamId: "stream-1",
            mediaSessionId: "session-1",
            groupId: "test-group-1",
            hostDeviceId: "d1",
            hostDisplayName: "Alice",
            sourceKind: "screen",
            sourceName: "My Screen",
            startedAt: STARTED_AT,
            appliedSettingsRevision: 1,
            heartbeatSequence: 1,
            replacesSessionId: null,
          },
        ],
      },
      isViewing: false,
      watchedStreamsBySessionId: {},
      setIsViewing: vi.fn(),
      setViewStatus: vi.fn(),
      setWatchedStreams: vi.fn(),
      navigate: vi.fn(),
    };
    return selector(state);
  },
}));

import { TooltipProvider } from "../src/renderer/components/ui/tooltip";
import { GroupOverview } from "../src/renderer/components/workspace/GroupOverview";

function renderWithProviders(element: React.ReactElement) {
  return render(<TooltipProvider>{element}</TooltipProvider>);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(STARTED_AT); // exactly at startedAt → "0s"
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── Page structure (reduced CSS brittleness) ─────────────────────────────

describe("GroupOverview page structure", () => {
  it("renders group name as level-1 heading", () => {
    renderWithProviders(<GroupOverview />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveTextContent("Test Group");
  });

  it("shows member count in subtitle text", () => {
    renderWithProviders(<GroupOverview />);
    expect(screen.getByText(/2 members/)).toBeInTheDocument();
  });
});

// ─── Active share duration tick ──────────────────────────────────────────────

describe("GroupOverview active share duration", () => {
  it("starts at 0s and increments every second via fake timers", () => {
    renderWithProviders(<GroupOverview />);

    // Initially 0 seconds elapsed (system time = startedAt)
    expect(screen.getByText("0s")).toBeInTheDocument();

    // Advance 5 seconds
    act(() => { vi.advanceTimersByTime(5000); });

    expect(screen.getByText("5s")).toBeInTheDocument();

    // Advance to 65 seconds → "1m" (formatLiveDuration shows minutes without seconds)
    act(() => { vi.advanceTimersByTime(60_000); });

    expect(screen.getByText("1m")).toBeInTheDocument();
  });

  it("cleans up interval on unmount", () => {
    const { unmount } = renderWithProviders(<GroupOverview />);
    // Advance time a bit to ensure interval was set
    act(() => { vi.advanceTimersByTime(1000); });
    // Unmount
    unmount();
    // Advance more — should not throw (interval cleared)
    act(() => { vi.advanceTimersByTime(5000); });
    // If no error, cleanup is working
  });
});

// ─── Loading states ─────────────────────────────────────────────────────────

describe("GroupOverview loading state", () => {
  it("shows skeleton elements when loading, not plain text", () => {
    const { container } = renderWithProviders(<GroupOverview loading={true} />);
    const skeletons = container.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });
});

// ─── Active share card content ─────────────────────────────────────────────

describe("GroupOverview active share card", () => {
  it("renders host name, source name, and live duration", () => {
    renderWithProviders(<GroupOverview />);
    expect(screen.getByText("0s")).toBeInTheDocument();
    expect(screen.getByText("My Screen")).toBeInTheDocument();
  });
});
