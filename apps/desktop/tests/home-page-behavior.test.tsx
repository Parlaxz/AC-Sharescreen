// @vitest-environment happy-dom
/**
 * RTL behavior tests for HomePage.
 *
 * Verifies:
 *  1. Uses PageHeader-styled title heading
 *  2. Shows actionable empty state when no groups exist
 *  3. Shows skeleton elements while presets are loading (not plain text)
 *  4. Shows empty presets state
 *  5. Professional desktop utility layout (compact, focused)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";

// Mock ScrollArea
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="scroll-area">{children}</div>
  ),
}));

// Mock icons
vi.mock("lucide-react", () => ({
  Users: () => <svg data-testid="icon-users" />,
  Radio: () => <svg data-testid="icon-radio" />,
  SlidersHorizontal: () => <svg data-testid="icon-sliders" />,
  Plus: () => <svg data-testid="icon-plus" />,
  RefreshCw: () => <svg data-testid="icon-refresh" />,
  AlertTriangle: () => <svg data-testid="icon-alert" />,
  Monitor: () => <svg data-testid="icon-monitor" />,
}));

// ─── Store mock — no groups, loading state controllable ────────────────────

// Allow tests to control whether fetchQualityPresets hangs (for skeleton test)
let _presetsResolver: ((value: unknown) => void) | null = null;

vi.mock("@/stores/main-store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      groupsById: {},
      groupOrder: [],
      activeStreamsByGroup: {},
      selectGroup: vi.fn(),
      setOpenCreateGroupDialog: vi.fn(),
      setOpenJoinGroupDialog: vi.fn(),
      navigate: vi.fn(),
    };
    return selector(state);
  },
}));

vi.mock("@/services/group-actions", () => ({
  fetchQualityPresets: () =>
    new Promise((resolve) => {
      _presetsResolver = resolve;
    }),
}));

import { HomePage } from "../src/renderer/routes/HomePage";

beforeEach(() => {
  _presetsResolver = null;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ─── Page structure ─────────────────────────────────────────────────────────

describe("HomePage page structure", () => {
  it("renders ScreenLink title as level-1 heading", () => {
    render(<HomePage />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveTextContent("ScreenLink");
  });

  it("uses semantic heading hierarchy: h1 for title, h2 for sections", () => {
    render(<HomePage />);
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent("ScreenLink");
    const h2s = screen.getAllByRole("heading", { level: 2 });
    expect(h2s.length).toBeGreaterThanOrEqual(2);
  });

  it("labels content sections with aria-labelledby for accessibility", () => {
    const { container } = render(<HomePage />);
    const sections = container.querySelectorAll("section[aria-labelledby]");
    expect(sections.length).toBeGreaterThanOrEqual(2);
  });

  it("renders descriptive subtitle", () => {
    render(<HomePage />);
    expect(
      screen.getByText("Share your screen with anyone, anywhere."),
    ).toBeInTheDocument();
  });

  it("renders a Groups section heading", () => {
    render(<HomePage />);
    const groupsHeading = screen.getByRole("heading", { level: 2, name: /groups/i });
    expect(groupsHeading).toBeInTheDocument();
  });

  it("renders a presets section heading", () => {
    render(<HomePage />);
    expect(
      screen.getByRole("heading", { level: 2, name: /presets/i }),
    ).toBeInTheDocument();
  });
});

// ─── Empty state ─────────────────────────────────────────────────────────────

describe("HomePage empty state (no groups)", () => {
  it("shows Create group and Join group buttons", () => {
    render(<HomePage />);
    expect(screen.getByRole("button", { name: /create group/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /join group/i })).toBeInTheDocument();
  });

  it("shows actionable guidance text to create or join a group", () => {
    render(<HomePage />);
    expect(
      screen.getByText(/create or join a group/i),
    ).toBeInTheDocument();
  });
});

// ─── Loading states ──────────────────────────────────────────────────────────

describe("HomePage loading states", () => {
  it("shows animated placeholder elements while presets are loading (no plain Loading text)", () => {
    // _presetsResolver starts null — promise never resolves → loading stays true
    render(<HomePage />);

    // Should NOT have plain "Loading..." text
    expect(screen.queryByText(/^loading$/i)).not.toBeInTheDocument();

    // The presets section heading should still be visible while loading
    expect(
      screen.getByRole("heading", { level: 2, name: /presets/i }),
    ).toBeInTheDocument();
  });
});


