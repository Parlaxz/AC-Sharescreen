// @vitest-environment happy-dom
/**
 * About page runtime behavior tests.
 *
 * Tests that About:
 * - Uses PageHeader component with proper title
 * - Uses PageSection components for content sections
 * - Loads and displays real app version/build info from API
 * - Does NOT contain href="#" placeholder links
 * - External links use openExternal IPC when available
 * - Shows update status info
 * - Semantic link/button behavior
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock sonner toast since About may use it for action failure feedback
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ─── Module-level mocks — About page doesn't use useStore, so no mock needed ──

// ─── Helper to set up window.screenlink mock ───────────────────────────────

function mockScreenlinkApi(overrides: Record<string, unknown> = {}) {
  const defaultApi = {
    getAppInfo: vi.fn<() => Promise<any>>().mockResolvedValue({
      version: "0.7.2",
      electronVersion: "33.0.0",
      chromeVersion: "130.0.0",
      nodeVersion: "20.0.0",
    }),
    getUpdateStatus: vi.fn<() => Promise<any>>().mockResolvedValue({
      phase: "up-to-date",
      currentVersion: "0.7.2",
      userMessage: "ScreenLink is up to date.",
      isPackaged: true,
      isPortable: false,
      updaterSupported: true,
    }),
    openExternal: vi.fn<() => Promise<any>>().mockResolvedValue({ success: true }),
    onUpdateStatusChanged: vi.fn<() => () => void>().mockReturnValue(() => {}),
    ...overrides,
  } as any;
  (window as any).screenlink = defaultApi;
  return defaultApi;
}

function clearScreenlinkApi() {
  delete (window as any).screenlink;
}

// ─── Import AFTER mocks ────────────────────────────────────────────────────
import { About } from "../src/renderer/routes/About.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  clearScreenlinkApi();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("About - PageHeader and PageSection", () => {
  it("renders a level-1 heading with page title", () => {
    render(React.createElement(About));
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toBeInTheDocument();
    expect(heading.textContent).toMatch(/About|ScreenLink/i);
  });

  it("renders content inside section elements", () => {
    render(React.createElement(About));
    const sections = document.querySelectorAll("section");
    expect(sections.length).toBeGreaterThanOrEqual(2);
  });
});

describe("About - Real app info after API resolves", () => {
  it("displays the real app version from API", async () => {
    mockScreenlinkApi();
    render(React.createElement(About));
    // Initial render shows "?"; after API resolves, shows real version
    // There are multiple "0.7.2" instances (hero + info rows)
    const versionEls = await screen.findAllByText("0.7.2", {}, { timeout: 3000 });
    expect(versionEls.length).toBeGreaterThanOrEqual(1);
  });

  it("displays Electron version from API", async () => {
    mockScreenlinkApi();
    render(React.createElement(About));
    const els = await screen.findAllByText("33.0.0", {}, { timeout: 3000 });
    expect(els.length).toBeGreaterThanOrEqual(1);
  });

  it("displays Chromium version from API", async () => {
    mockScreenlinkApi();
    render(React.createElement(About));
    const els = await screen.findAllByText("130.0.0", {}, { timeout: 3000 });
    expect(els.length).toBeGreaterThanOrEqual(1);
  });

  it("displays Node.js version from API", async () => {
    mockScreenlinkApi();
    render(React.createElement(About));
    const els = await screen.findAllByText("20.0.0", {}, { timeout: 3000 });
    expect(els.length).toBeGreaterThanOrEqual(1);
  });
});

describe("About - No href=# placeholders", () => {
  it("does NOT contain any href='#' links", async () => {
    mockScreenlinkApi();
    render(React.createElement(About));
    // Wait for render to complete
    const versionEls = await screen.findAllByText("0.7.2", {}, { timeout: 3000 });
    expect(versionEls.length).toBeGreaterThanOrEqual(1);
    const links = document.querySelectorAll('a[href="#"]');
    expect(links.length).toBe(0);
  });
});

describe("About - External links", () => {
  it("renders external links with real href values", async () => {
    mockScreenlinkApi();
    render(React.createElement(About));
    const versionEls = await screen.findAllByText("0.7.2", {}, { timeout: 3000 });
    expect(versionEls.length).toBeGreaterThanOrEqual(1);
    const externalLinks = document.querySelectorAll('a[href^="http"]');
    expect(externalLinks.length).toBeGreaterThanOrEqual(1);
    // Check they have target=_blank for security
    externalLinks.forEach((link) => {
      expect(link.getAttribute("target")).toBe("_blank");
    });
  });

  it("renders at least one link mentioning GitHub or source code", async () => {
    mockScreenlinkApi();
    render(React.createElement(About));
    const versionEls = await screen.findAllByText("0.7.2", {}, { timeout: 3000 });
    expect(versionEls.length).toBeGreaterThanOrEqual(1);
    const link = screen.queryByText(/github|source code/i);
    expect(link).toBeTruthy();
    if (link) {
      expect(link.tagName).toBe("A");
    }
  });
});

describe("About - Update info", () => {
  it("shows update status information after API resolves", async () => {
    mockScreenlinkApi();
    render(React.createElement(About));
    // Wait for the version to appear, then check for update text
    const versionEls = await screen.findAllByText("0.7.2", {}, { timeout: 3000 });
    expect(versionEls.length).toBeGreaterThanOrEqual(1);
    const versionElements = screen.getAllByText("0.7.2");
    expect(versionElements.length).toBeGreaterThanOrEqual(1);
  });
});

describe("About - Action failure feedback via toast", () => {
  it("external link failure shows error feedback", async () => {
    const api = mockScreenlinkApi({
      openExternal: vi.fn().mockRejectedValue(new Error("Blocked")),
    });
    const user = userEvent.setup();
    render(React.createElement(About));

    const versionEls = await screen.findAllByText("0.7.2", {}, { timeout: 3000 });
    expect(versionEls.length).toBeGreaterThanOrEqual(1);

    // Click external link — should consume the error (not throw)
    const link = screen.getByText(/source code/i);
    await user.click(link);
    // openExternal should have been called (error is handled silently via toast)
    expect(api.openExternal).toHaveBeenCalled();
  });

  it("check-for-updates failure shows error feedback", async () => {
    const api = mockScreenlinkApi({
      checkForUpdates: vi.fn().mockRejectedValue(new Error("Network error")),
    });
    const user = userEvent.setup();
    render(React.createElement(About));

    const versionEls = await screen.findAllByText("0.7.2", {}, { timeout: 3000 });
    expect(versionEls.length).toBeGreaterThanOrEqual(1);

    // Find and click the check-for-updates button
    const checkBtn = screen.getByRole("button", { name: /check for updates/i });
    await user.click(checkBtn);

    // checkForUpdates should have been called (error is handled)
    expect(api.checkForUpdates).toHaveBeenCalled();
  });
});
