// @vitest-environment happy-dom
/**
 * Runtime behavior tests for AppErrorBoundary.
 *
 * These tests render a real AppErrorBoundary with throwing and
 * non-throwing children, verifying the fallback UI, role=alert,
 * retry recovery, and "Go home" navigation in the DOM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { AppErrorBoundary } from "../src/renderer/components/AppErrorBoundary.js";
import { useStore } from "../src/renderer/stores/main-store.js";

beforeEach(() => {
  useStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Non-throwing child used to verify normal rendering. */
function SafeChild() {
  return <div data-testid="safe-child">Normal content</div>;
}

/** Throwing child used to trigger the error boundary. */
function ThrowingChild(): React.ReactNode {
  throw new Error("Intentional test error");
}

/**
 * A child whose throwing behaviour can be controlled externally.
 * Set `throwRef.current = false` to stop throwing, then click
 * "Try again" to verify recovery.
 */
function ControllableChild({ throwRef }: { throwRef: { current: boolean } }) {
  if (throwRef.current) {
    throw new Error("Controlled throw");
  }
  return <div data-testid="recovered">Recovered content</div>;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("AppErrorBoundary runtime behavior", () => {
  it("renders children normally when no error occurs", () => {
    render(
      <AppErrorBoundary>
        <SafeChild />
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId("safe-child")).toBeInTheDocument();
    expect(screen.getByText("Normal content")).toBeInTheDocument();
  });

  it("renders role=alert fallback when a child throws", () => {
    // Suppress the expected console error from React's error reporting
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <AppErrorBoundary>
        <ThrowingChild />
      </AppErrorBoundary>,
    );

    // The fallback container should have role="alert"
    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();

    // Should show the error message and recovery buttons
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(
      screen.getByText("Intentional test error"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /go home/i }),
    ).toBeInTheDocument();

    spy.mockRestore();
  });

  it("retry clears error state allowing child to re-render", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwRef = { current: true };

    render(
      <AppErrorBoundary>
        <ControllableChild throwRef={throwRef} />
      </AppErrorBoundary>,
    );

    // Error caught — fallback visible
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Controlled throw")).toBeInTheDocument();

    // Stop the child from throwing
    throwRef.current = false;

    // Click "Try again" — boundary clears error state, re-renders children
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    // The child should now render without throwing
    expect(screen.getByTestId("recovered")).toBeInTheDocument();
    expect(screen.getByText("Recovered content")).toBeInTheDocument();

    spy.mockRestore();
  });

  it("go home navigates to the home page via zustand store", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Start on a non-home page
    useStore.getState().navigate("overview");
    expect(useStore.getState().currentPage).toBe("overview");

    render(
      <AppErrorBoundary>
        <ThrowingChild />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Click "Go home"
    fireEvent.click(screen.getByRole("button", { name: /go home/i }));

    // The store should now be on the home page
    expect(useStore.getState().currentPage).toBe("home");

    spy.mockRestore();
  });
});
