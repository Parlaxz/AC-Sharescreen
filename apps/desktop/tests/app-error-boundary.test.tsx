// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";

const boundaryPath = path.resolve(
  __dirname,
  "../src/renderer/components/AppErrorBoundary.tsx",
);
const appPath = path.resolve(
  __dirname,
  "../src/renderer/App.tsx",
);

const src = fs.readFileSync(boundaryPath, "utf-8");
const appSrc = fs.readFileSync(appPath, "utf-8");

// ─── AppErrorBoundary component (static guardrails) ─────────────────────────

describe("AppErrorBoundary", () => {
  it("exports an AppErrorBoundary class component", () => {
    expect(src).toContain("class AppErrorBoundary");
  });

  it("extends React.Component", () => {
    expect(src).toContain("extends React.Component");
  });

  it("defines a state interface with hasError and error", () => {
    expect(src).toMatch(/hasError:\s*boolean/);
    expect(src).toMatch(/error:\s*(Error\s*\||null)/);
  });

  it("has getDerivedStateFromError static method", () => {
    expect(src).toContain("static getDerivedStateFromError");
  });

  it("getDerivedStateFromError returns hasError: true and the error", () => {
    expect(src).toMatch(/hasError:\s*true/);
    expect(src).toMatch(/error/);
  });

  it("has handleRetry instance method that clears error state", () => {
    expect(src).toContain("handleRetry");
    expect(src).toContain("setState({ hasError: false, error: null })");
  });

  it("has handleGoHome method that navigates via store and resets state", () => {
    expect(src).toContain("handleGoHome");
    expect(src).toContain('navigate("home")');
    expect(src).toContain("useStore.getState()");
  });

  it("has componentDidCatch that logs the error", () => {
    expect(src).toContain("componentDidCatch");
    expect(src).toContain("console.error");
  });

  it("renders a recovery UI with Try Again and Go Home buttons", () => {
    expect(src).toContain("Try again");
    expect(src).toContain("Go home");
  });

  it("renders the error message when an error is caught", () => {
    expect(src).toContain("error?.message");
    expect(src).toContain("Something went wrong");
  });

  it("renders error fallback with role alert", () => {
    expect(src).toContain('role="alert"');
  });

  it("uses Watermelon Button component from @/components/ui/button", () => {
    expect(src).toContain('from "@/components/ui/button"');
  });

  it("uses ScreenLink design tokens (text-text-primary, text-text-secondary)", () => {
    expect(src).toContain("text-text-primary");
    expect(src).toContain("text-text-secondary");
  });

  it("uses lucide-react AlertTriangle, Home, and RefreshCw icons", () => {
    expect(src).toContain("AlertTriangle");
    expect(src).toContain("Home");
    expect(src).toContain("RefreshCw");
  });

  it("does not hardcode hex color values", () => {
    const hexColors = src.match(/#[0-9a-fA-F]{3,8}/g) || [];
    const suspicious = hexColors.filter((h) => {
      const line = src.split("\n").find((l) => l.includes(h));
      return line && !line.trim().startsWith("*");
    });
    expect(suspicious.length).toBe(0);
  });

  it("renders children normally when no error", () => {
    expect(src).toMatch(/this\.props\.children/);
  });

  it("initializes state with hasError: false and error: null", () => {
    expect(src).toMatch(/hasError:\s*false/);
    expect(src).toMatch(/error:\s*null/);
  });
});

// ─── App.tsx integration ────────────────────────────────────────────────────

describe("App.tsx error boundary integration", () => {
  it("imports AppErrorBoundary from AppErrorBoundary.tsx", () => {
    expect(appSrc).toContain("AppErrorBoundary");
    expect(appSrc).toContain(
      'from "./components/AppErrorBoundary.js"',
    );
  });

  it("wraps the active page region with <AppErrorBoundary>", () => {
    expect(appSrc).toContain("<AppErrorBoundary>");
    expect(appSrc).toContain("</AppErrorBoundary>");
  });

  it("does not place AppErrorBoundary outside AppShell root", () => {
    const appShellOpen = appSrc.indexOf("<AppShell>");
    const boundaryOpen = appSrc.indexOf("<AppErrorBoundary>");
    expect(boundaryOpen).toBeGreaterThan(appShellOpen);
  });

  it("uses a div (not main) for the inner page wrapper since AppShell owns main", () => {
    // AppShell already renders a <main> element. The inner wrapper
    // inside AppErrorBoundary should be a <div> to avoid nested mains.
    // Tolerates additional inert attributes (e.g. data-testid="app-root").
    expect(appSrc).toMatch(
      /<AppErrorBoundary>\s*<div className="h-full overflow-auto"[^>]*>/,
    );
  });
});
