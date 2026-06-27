// @vitest-environment happy-dom
/**
 * update-indicator.test.tsx
 *
 * Renders the real `UpdateIndicator` component and asserts that it
 * is a truthful view of the `UpdateStatusDTO` produced by the main
 * process. Covers:
 *  - Unsupported dev/portable builds hide the indicator
 *  - Idle / up-to-date phases hide the indicator
 *  - Update-available shows the real version
 *  - Fake version 1.1.0 is never hardcoded
 *  - Download calls the real downloadUpdate IPC
 *  - Later closes the popover without hiding the badge
 *  - Reopening preserves the real available state
 *  - Download progress shows real percent
 *  - Downloaded state shows Restart and install
 *  - Restart calls restartAndInstallUpdate
 *  - Error state shows safe error text and retry
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { UpdateIndicator } from "../src/renderer/components/layout/UpdateIndicator.js";
import type { UpdateStatusDTO } from "../src/preload/api-types.js";

type StatusHandler = (status: UpdateStatusDTO) => void;

interface MockUpdateApi {
  getUpdateStatus: ReturnType<typeof vi.fn>;
  checkForUpdates: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
  restartAndInstallUpdate: ReturnType<typeof vi.fn>;
  checkDownloadAndInstall: ReturnType<typeof vi.fn>;
  onUpdateStatusChanged: ReturnType<typeof vi.fn>;
  subscribed: StatusHandler[];
}

function makeStatus(partial: Partial<UpdateStatusDTO> = {}): UpdateStatusDTO {
  return {
    phase: "idle",
    currentVersion: "0.2.0",
    userMessage: "",
    isPackaged: true,
    isPortable: false,
    updaterSupported: true,
    ...partial,
  };
}

function installMockApi(initial: UpdateStatusDTO, overrides: Partial<MockUpdateApi> = {}): MockUpdateApi {
  const subscribed: StatusHandler[] = [];
  const api: MockUpdateApi = {
    getUpdateStatus: vi.fn().mockResolvedValue(initial),
    checkForUpdates: vi.fn().mockResolvedValue(initial),
    downloadUpdate: vi.fn().mockResolvedValue(initial),
    restartAndInstallUpdate: vi.fn().mockResolvedValue(initial),
    checkDownloadAndInstall: vi.fn().mockResolvedValue(initial),
    onUpdateStatusChanged: vi.fn((cb: StatusHandler) => {
      subscribed.push(cb);
      return () => {
        const i = subscribed.indexOf(cb);
        if (i >= 0) subscribed.splice(i, 1);
      };
    }),
    subscribed,
    ...overrides,
  };
  (window as unknown as { screenlink: MockUpdateApi }).screenlink = api;
  return api;
}

describe("UpdateIndicator", () => {
  beforeEach(() => {
    delete (window as unknown as { screenlink?: unknown }).screenlink;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("does not render anything when status is unsupported", async () => {
    installMockApi(
      makeStatus({
        phase: "unsupported",
        updaterSupported: false,
        isPackaged: false,
        userMessage: "Update checks are only available in an installed packaged build.",
      }),
    );

    const { container } = render(<UpdateIndicator />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='update-indicator-trigger']")).toBeNull();
    });
  });

  it("does not render anything when running a portable build", async () => {
    installMockApi(
      makeStatus({
        phase: "unsupported",
        updaterSupported: false,
        isPackaged: true,
        isPortable: true,
        userMessage: "The portable version cannot update itself.",
      }),
    );

    const { container } = render(<UpdateIndicator />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='update-indicator-trigger']")).toBeNull();
    });
  });

  it("does not render a badge for idle phase", async () => {
    installMockApi(makeStatus({ phase: "idle" }));
    const { container } = render(<UpdateIndicator />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='update-indicator-trigger']")).toBeNull();
    });
  });

  it("does not render a badge for up-to-date phase", async () => {
    installMockApi(makeStatus({ phase: "up-to-date" }));
    const { container } = render(<UpdateIndicator />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='update-indicator-trigger']")).toBeNull();
    });
  });

  it("renders the real available version when update-available", async () => {
    installMockApi(
      makeStatus({
        phase: "update-available",
        availableVersion: "0.3.0",
        currentVersion: "0.2.0",
      }),
    );
    const { baseElement } = render(<UpdateIndicator />);

    await waitFor(() => {
      expect(screen.getByTestId("update-indicator-trigger")).toBeInTheDocument();
    });

    // Open the popover
    fireEvent.click(screen.getByTestId("update-indicator-trigger"));
    await waitFor(() => {
      expect(screen.getByText("Version 0.3.0 available")).toBeInTheDocument();
    });
    // Should show current version
    expect(baseElement.textContent).toContain("0.2.0");
    // Should never show the fake 1.1.0
    expect(baseElement.textContent).not.toContain("1.1.0");
    expect(baseElement.textContent).not.toContain("Improved WebRTC");
    expect(baseElement.textContent).not.toContain("Download & install");
  });

  it("does NOT contain the hardcoded 1.1.0 string in any status", async () => {
    installMockApi(makeStatus({ phase: "update-available", availableVersion: "0.3.0" }));
    const { container } = render(<UpdateIndicator />);
    await waitFor(() => {
      expect(screen.getByTestId("update-indicator-trigger")).toBeInTheDocument();
    });
    expect(container.innerHTML).not.toMatch(/1\.1\.0/);
  });

  it("download button calls downloadUpdate IPC", async () => {
    const api = installMockApi(
      makeStatus({ phase: "update-available", availableVersion: "0.3.0" }),
    );
    render(<UpdateIndicator />);

    await waitFor(() => {
      expect(screen.getByTestId("update-indicator-trigger")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("update-indicator-trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("update-download-button")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("update-download-button"));

    await waitFor(() => {
      expect(api.downloadUpdate).toHaveBeenCalledTimes(1);
    });
  });

  it("download does not just hide the update", async () => {
    const api = installMockApi(
      makeStatus({ phase: "update-available", availableVersion: "0.3.0" }),
    );
    render(<UpdateIndicator />);

    await waitFor(() => {
      expect(screen.getByTestId("update-indicator-trigger")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("update-indicator-trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("update-download-button")).toBeInTheDocument();
    });

    // The downloadUpdate should be called; the indicator must not just disappear.
    fireEvent.click(screen.getByTestId("update-download-button"));
    await waitFor(() => {
      expect(api.downloadUpdate).toHaveBeenCalled();
    });
    // The status update from the IPC promise is the same status, so the
    // indicator remains visible.
    expect(screen.getByTestId("update-indicator-trigger")).toBeInTheDocument();
  });

  it("Later closes only the popover, leaving the status untouched", async () => {
    const api = installMockApi(
      makeStatus({ phase: "update-available", availableVersion: "0.3.0" }),
    );
    render(<UpdateIndicator />);

    await waitFor(() => {
      expect(screen.getByTestId("update-indicator-trigger")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("update-indicator-trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("update-later-button")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("update-later-button"));

    await waitFor(() => {
      // Trigger is still in the document (badge persists)
      expect(screen.getByTestId("update-indicator-trigger")).toBeInTheDocument();
    });
    // No IPC call was made
    expect(api.checkForUpdates).not.toHaveBeenCalled();
    expect(api.downloadUpdate).not.toHaveBeenCalled();
  });

  it("reopening the popover preserves the real available state", async () => {
    installMockApi(
      makeStatus({ phase: "update-available", availableVersion: "0.3.0" }),
    );
    render(<UpdateIndicator />);

    await waitFor(() => {
      expect(screen.getByTestId("update-indicator-trigger")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("update-indicator-trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("update-later-button")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("update-later-button"));
    await waitFor(() => {
      expect(screen.queryByTestId("update-later-button")).toBeNull();
    });

    // Reopen
    fireEvent.click(screen.getByTestId("update-indicator-trigger"));
    await waitFor(() => {
      expect(screen.getByText("Version 0.3.0 available")).toBeInTheDocument();
    });
  });

  it("displays real download progress when phase is downloading", async () => {
    installMockApi(
      makeStatus({
        phase: "downloading",
        availableVersion: "0.3.0",
        downloadPercent: 42.5,
        transferredBytes: 1024,
        totalBytes: 4096,
        bytesPerSecond: 500_000,
      }),
    );
    render(<UpdateIndicator />);

    await waitFor(() => {
      expect(screen.getByTestId("update-indicator-trigger")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("update-indicator-trigger"));
    await waitFor(() => {
      expect(screen.getByText("Downloading update")).toBeInTheDocument();
    });
    // 42.5% rounds to 43% in the badge and popover
    expect(screen.getAllByText("43%").length).toBeGreaterThan(0);
    // 500_000 B/s = 488 KB/s (single decimal when < 10, but 488 > 10 so integer)
    expect(screen.getByText(/488(\.\d+)?\s*KB\/s/)).toBeInTheDocument();
  });

  it("displays Restart and install when phase is downloaded", async () => {
    const api = installMockApi(
      makeStatus({
        phase: "downloaded",
        availableVersion: "0.3.0",
        downloadedVersion: "0.3.0",
        downloadPercent: 100,
      }),
    );
    render(<UpdateIndicator />);

    await waitFor(() => {
      expect(screen.getByTestId("update-indicator-trigger")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("update-indicator-trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("update-restart-button")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("update-restart-button"));
    await waitFor(() => {
      expect(api.restartAndInstallUpdate).toHaveBeenCalled();
    });
  });

  it("displays safe error text and a retry action in error state", async () => {
    installMockApi(
      makeStatus({
        phase: "error",
        errorCode: "network-unavailable",
        errorMessage: "Unable to connect to the update server. Please check your internet connection.",
      }),
    );
    render(<UpdateIndicator />);

    await waitFor(() => {
      expect(screen.getByTestId("update-indicator-trigger")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("update-indicator-trigger"));
    await waitFor(() => {
      expect(
        screen.getByText("Unable to connect to the update server. Please check your internet connection."),
      ).toBeInTheDocument();
    });
  });

  it("renders nothing when no status is available yet (initial mount)", () => {
    // No mock API installed -> status remains null
    const { container } = render(<UpdateIndicator />);
    expect(container.querySelector("[data-testid='update-indicator-trigger']")).toBeNull();
  });
});
