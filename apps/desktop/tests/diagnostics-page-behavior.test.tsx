// @vitest-environment happy-dom
/**
 * DiagnosticsPage runtime behavior tests.
 *
 * Tests that DiagnosticsPage:
 * - Loads real data from the screenlink API (no hardcoded fake values)
 * - Shows loading state while data is being fetched
 * - Shows API-unavailable state when window.screenlink is absent
 * - Shows failure state when API calls reject
 * - Shows empty state when no diagnostics data is available
 * - Copy actions use clipboardWriteText IPC with exact content
 * - Open log folder action invokes openLogFolder IPC
 * - readRecentLogs is called and results displayed
 * - Copy Logs copies actual log content (disabled/no-op without content)
 * - Disclosure sections have proper aria-controls
 * - Renders health sections with semantic state badges
 * - showVideoHelper state (not showWebrtc) controls video helper disclosure
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Wrapper to provide required context providers ──────────────────────────
function renderWithProviders(ui: React.ReactElement) {
  return render(React.createElement(TooltipProvider, null, ui));
}

// ─── Module-level mock: make sure import(…) doesn't pull real store ────────

vi.mock("@/stores/main-store", () => ({
  useStore: (selector: any) =>
    selector({
      navigate: vi.fn(),
      currentPage: "diagnostics",
    }),
}));

// ─── Helper to set up window.screenlink mock ───────────────────────────────

const SAMPLE_LOG_TEXT = [
  '[2026-07-12T10:00:00.000Z] [INFO] App initialized',
  '[2026-07-12T10:00:01.000Z] [WARN] Helper spawned',
  '[2026-07-12T10:00:02.000Z] [ERROR] Connection timeout',
].join("\n");

function mockScreenlinkApi(overrides: Record<string, unknown> = {}) {
  const defaultApi = {
    getAppInfo: vi.fn().mockResolvedValue({
      version: "0.7.2",
      electronVersion: "33.0.0",
      chromeVersion: "130.0.0",
      nodeVersion: "20.0.0",
    }),
    getAudioState: vi.fn().mockResolvedValue("active"),
    getMixerDiagnostics: vi.fn().mockResolvedValue({
      success: true,
      data: {
        sourceType: "filtered-monitor",
        pipeline: "dynamic-process-mix",
        running: true,
        activeCaptureSources: 2,
        mixerInputPackets: 5000,
        mixerOutputPackets: 4800,
      },
    }),
    getPipelineSnapshot: vi.fn().mockResolvedValue({
      helperState: "running",
      helperUptimeMs: 3600000,
      streamGeneration: 3,
    }),
    clipboardWriteText: vi.fn().mockResolvedValue({ success: true, length: 42 }),
    openLogFolder: vi.fn().mockResolvedValue({ success: true }),
    readRecentLogs: vi.fn().mockResolvedValue({
      success: true,
      data: SAMPLE_LOG_TEXT,
      byteCount: SAMPLE_LOG_TEXT.length,
      lineCount: 3,
      truncated: false,
    }),
    videoHelperGetDiagnostics: vi.fn().mockResolvedValue({
      state: "idle",
      framesProcessed: 150,
      framesDropped: 2,
    }),
    nativePresenterGetDiagnostics: vi.fn().mockResolvedValue({
      success: true,
      diagnostics: { attached: false },
    }),
    probeNvidiaVsrCapability: vi.fn().mockResolvedValue({
      available: false,
      reason: "sdk-not-built",
    }),
    ...overrides,
  } as any;
  (window as any).screenlink = defaultApi;
  return defaultApi;
}

function clearScreenlinkApi() {
  delete (window as any).screenlink;
}

// ─── Import AFTER mocks are set up ──────────────────────────────────────────
import { DiagnosticsPage } from "../src/renderer/components/workspace/DiagnosticsPage.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  clearScreenlinkApi();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("DiagnosticsPage - Loading state", () => {
  it("shows a loading skeleton or status while API data is being fetched", () => {
    const api = mockScreenlinkApi();
    api.getAppInfo.mockReturnValue(new Promise(() => {}));

    renderWithProviders(React.createElement(DiagnosticsPage));

    expect(screen.queryByText("0.7.2")).not.toBeInTheDocument();
  });
});

describe("DiagnosticsPage - API unavailable state", () => {
  it('shows "API not available" message when window.screenlink is missing', () => {
    clearScreenlinkApi();
    renderWithProviders(React.createElement(DiagnosticsPage));
    expect(screen.getByText(/API not available/i)).toBeInTheDocument();
    expect(screen.getByText(/running outside Electron/i)).toBeInTheDocument();
  });
});

describe("DiagnosticsPage - Failure state", () => {
  it("shows an error message when getAppInfo fails", async () => {
    const api = mockScreenlinkApi();
    api.getAppInfo.mockRejectedValue(new Error("IPC connection failed"));

    renderWithProviders(React.createElement(DiagnosticsPage));

    await waitFor(() => {
      expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
    });
  });
});

describe("DiagnosticsPage - Empty state", () => {
  it("renders gracefully when all API calls return null/empty", async () => {
    mockScreenlinkApi({
      getAppInfo: vi.fn().mockResolvedValue(null),
      getAudioState: vi.fn().mockResolvedValue("disabled"),
      getMixerDiagnostics: vi.fn().mockResolvedValue({ success: false, error: "no-audio-helper" }),
      getPipelineSnapshot: vi.fn().mockResolvedValue(null),
      videoHelperGetDiagnostics: vi.fn().mockResolvedValue(null),
      nativePresenterGetDiagnostics: vi.fn().mockResolvedValue({ success: false }),
      probeNvidiaVsrCapability: vi.fn().mockResolvedValue(null),
      readRecentLogs: vi.fn().mockResolvedValue({ success: true, data: "", byteCount: 0, lineCount: 0, truncated: false }),
    });

    renderWithProviders(React.createElement(DiagnosticsPage));

    await waitFor(() => {
      expect(screen.getByText("Application")).toBeInTheDocument();
      expect(screen.getAllByText(/—|N\/A|unavailable/i).length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("DiagnosticsPage - Success state", () => {
  beforeEach(() => {
    mockScreenlinkApi();
  });

  it("loads and displays real app version info from API", async () => {
    renderWithProviders(React.createElement(DiagnosticsPage));
    await waitFor(() => {
      expect(screen.getByText("0.7.2")).toBeInTheDocument();
    });
  });

  it("loads and displays Electron and Chrome versions from API", async () => {
    renderWithProviders(React.createElement(DiagnosticsPage));
    await waitFor(() => {
      expect(screen.getByText("33.0.0")).toBeInTheDocument();
      expect(screen.getByText("130.0.0")).toBeInTheDocument();
    });
  });

  it("loads and displays Node.js version from API", async () => {
    renderWithProviders(React.createElement(DiagnosticsPage));
    await waitFor(() => {
      expect(screen.getByText("20.0.0")).toBeInTheDocument();
    });
  });

  it("loads and displays audio state from API", async () => {
    renderWithProviders(React.createElement(DiagnosticsPage));
    await waitFor(() => {
      expect(screen.getByText("active")).toBeInTheDocument();
    });
  });

  it("loads and displays helper state from pipeline snapshot", async () => {
    renderWithProviders(React.createElement(DiagnosticsPage));
    await waitFor(() => {
      expect(screen.getByText("running")).toBeInTheDocument();
    });
  });

  it("renders NVIDIA VSR capability section", async () => {
    renderWithProviders(React.createElement(DiagnosticsPage));
    await waitFor(() => {
      expect(screen.getByText(/sdk-not-built/i)).toBeInTheDocument();
    });
  });

  it("renders video helper diagnostics section", async () => {
    mockScreenlinkApi();
    renderWithProviders(React.createElement(DiagnosticsPage));
    await waitFor(() => {
      expect(screen.getByText("Video Helper Diagnostics")).toBeInTheDocument();
    });
  });
});

describe("DiagnosticsPage - Copy individual value uses clipboardWriteText with exact content", () => {
  it("clicking a copyable value calls clipboardWriteText with that exact text", async () => {
    const api = mockScreenlinkApi();
    const user = userEvent.setup();

    renderWithProviders(React.createElement(DiagnosticsPage));

    await waitFor(() => {
      expect(screen.getByText("0.7.2")).toBeInTheDocument();
    });

    // Find the "App version" value button (it has aria-label "Copy App version")
    const copyBtn = screen.getByRole("button", { name: /copy app version/i });
    await user.click(copyBtn);

    // clipboardWriteText must be called with the exact displayed value
    expect(api.clipboardWriteText).toHaveBeenCalledWith("0.7.2");
  });

  it("clicking Electron version copy calls clipboardWriteText with '33.0.0'", async () => {
    const api = mockScreenlinkApi();
    const user = userEvent.setup();

    renderWithProviders(React.createElement(DiagnosticsPage));
    await waitFor(() => {
      expect(screen.getByText("33.0.0")).toBeInTheDocument();
    });

    const copyBtn = screen.getByRole("button", { name: /copy electron/i });
    await user.click(copyBtn);

    expect(api.clipboardWriteText).toHaveBeenCalledWith("33.0.0");
  });
});

describe("DiagnosticsPage - Log reading and copy", () => {
  it("calls readRecentLogs on mount and displays log content", async () => {
    const api = mockScreenlinkApi();

    renderWithProviders(React.createElement(DiagnosticsPage));

    // Logs load independently from diagnostics data
    await waitFor(() => {
      expect(api.readRecentLogs).toHaveBeenCalled();
    });

    // Log content should be visible
    await waitFor(() => {
      expect(screen.getByText(/App initialized/)).toBeInTheDocument();
      expect(screen.getByText(/Connection timeout/)).toBeInTheDocument();
    });
  });

  it("Copy Logs button copies actual log content via clipboardWriteText", async () => {
    const api = mockScreenlinkApi();
    const user = userEvent.setup();

    renderWithProviders(React.createElement(DiagnosticsPage));

    await waitFor(() => {
      expect(screen.getByText("0.7.2")).toBeInTheDocument();
    });

    // Click "Copy to clipboard" button in the logs section
    const copyLogsBtn = screen.getByRole("button", { name: /copy to clipboard/i });
    await user.click(copyLogsBtn);

    // Must call clipboardWriteText with the exact log content
    expect(api.clipboardWriteText).toHaveBeenCalledWith(SAMPLE_LOG_TEXT);
  });

  it("shows empty state when no logs are available and Copy Logs is disabled/no-op", async () => {
    const api = mockScreenlinkApi({
      readRecentLogs: vi.fn().mockResolvedValue({
        success: true,
        data: "",
        byteCount: 0,
        lineCount: 0,
        truncated: false,
      }),
    });
    const user = userEvent.setup();

    renderWithProviders(React.createElement(DiagnosticsPage));

    await waitFor(() => {
      expect(screen.getByText("0.7.2")).toBeInTheDocument();
    });

    // Should show empty state
    expect(screen.getByText(/no log content/i)).toBeInTheDocument();

    // Button should be disabled when no content
    const copyLogsBtn = screen.getByRole("button", { name: /copy to clipboard/i });
    expect((copyLogsBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows error state when readRecentLogs fails", async () => {
    mockScreenlinkApi({
      readRecentLogs: vi.fn().mockResolvedValue({
        success: false,
        error: "Permission denied",
        data: "",
        byteCount: 0,
        lineCount: 0,
        truncated: false,
      }),
    });

    renderWithProviders(React.createElement(DiagnosticsPage));

    await waitFor(() => {
      expect(screen.getByText("0.7.2")).toBeInTheDocument();
    });

    expect(screen.getByText(/permission denied/i)).toBeInTheDocument();
  });

  it("Open log folder button calls openLogFolder IPC", async () => {
    const api = mockScreenlinkApi();
    const user = userEvent.setup();

    renderWithProviders(React.createElement(DiagnosticsPage));

    await waitFor(() => {
      expect(screen.getByText("0.7.2")).toBeInTheDocument();
    });

    const openLogBtn = screen.getByRole("button", { name: /open log folder/i });
    await user.click(openLogBtn);

    expect(api.openLogFolder).toHaveBeenCalled();
  });
});

describe("DiagnosticsPage - Health sections with semantic states", () => {
  beforeEach(() => {
    mockScreenlinkApi();
  });

  it("renders a health section with a status badge", async () => {
    mockScreenlinkApi();
    renderWithProviders(React.createElement(DiagnosticsPage));

    await waitFor(() => {
      expect(screen.getByText("Unavailable")).toBeInTheDocument();
    });
  });
});

describe("DiagnosticsPage - Disclosure sections", () => {
  beforeEach(() => {
    mockScreenlinkApi();
  });

  it("disclosure section has aria-expanded and aria-controls", async () => {
    renderWithProviders(React.createElement(DiagnosticsPage));

    await waitFor(() => {
      const disclosureButtons = document.querySelectorAll('button[aria-expanded]');
      expect(disclosureButtons.length).toBeGreaterThanOrEqual(1);

      disclosureButtons.forEach((btn) => {
        expect(btn.getAttribute("aria-controls")).toBeTruthy();
      });
    });
  });

  it("disclosure toggle shows/hides content when clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(React.createElement(DiagnosticsPage));

    await waitFor(() => {
      const disclosureButtons = document.querySelectorAll('button[aria-expanded]');
      expect(disclosureButtons.length).toBeGreaterThanOrEqual(1);
    });

    const firstBtn = document.querySelector('button[aria-expanded]')!;
    const initialExpanded = firstBtn.getAttribute("aria-expanded") === "true";
    await user.click(firstBtn);
    expect(firstBtn.getAttribute("aria-expanded")).toBe(String(!initialExpanded));
  });
});

describe("DiagnosticsPage - No hardcoded fake values", () => {
  it("does NOT contain the fake version string '1.0.0' from the old implementation", async () => {
    mockScreenlinkApi();
    renderWithProviders(React.createElement(DiagnosticsPage));

    await waitFor(() => {
      expect(screen.getByText("0.7.2")).toBeInTheDocument();
    });
    const fakeVersionElements = screen.queryAllByText("1.0.0");
    expect(fakeVersionElements.length).toBe(0);
  });
});

describe("DiagnosticsPage - State name: showVideoHelper (not showWebrtc)", () => {
  it("uses showVideoHelper state variable (not showWebrtc)", () => {
    const diagSource = fs.readFileSync(
      path.resolve(__dirname, "../src/renderer/components/workspace/DiagnosticsPage.tsx"),
      "utf-8"
    );
    expect(diagSource).toContain("showVideoHelper");
    expect(diagSource).not.toContain("showWebrtc");
  });
});

describe("DiagnosticsPage - Log content area accessibility", () => {
  it("renders log content area with role='log'", async () => {
    mockScreenlinkApi();
    renderWithProviders(React.createElement(DiagnosticsPage));

    await waitFor(() => {
      const logRegion = document.querySelector('[role="log"]');
      expect(logRegion).toBeInTheDocument();
    });
  });

  it("renders log content area with tabIndex={0} for keyboard focus", async () => {
    mockScreenlinkApi();
    renderWithProviders(React.createElement(DiagnosticsPage));

    await waitFor(() => {
      const logRegion = document.querySelector('[role="log"]');
      expect(logRegion).toBeInTheDocument();
      expect(logRegion!.getAttribute("tabindex")).toBe("0");
    });
  });

  it("renders log content area with an accessible label", async () => {
    mockScreenlinkApi();
    renderWithProviders(React.createElement(DiagnosticsPage));

    await waitFor(() => {
      const logRegion = document.querySelector('[role="log"]');
      expect(logRegion).toBeInTheDocument();
      expect(logRegion!.getAttribute("aria-label") || logRegion!.getAttribute("aria-labelledby")).toBeTruthy();
    });
  });
});
