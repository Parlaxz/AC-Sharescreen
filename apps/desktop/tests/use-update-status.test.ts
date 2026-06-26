// @vitest-environment happy-dom
/**
 * use-update-status.test.ts
 *
 * Targeted tests for the renderer hook that owns interaction with the
 * main-process `UpdateManager`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useUpdateStatus } from "../src/renderer/hooks/use-update-status.js";
import type { UpdateStatusDTO } from "../src/preload/api-types.js";

const DEFAULT_STATUS: UpdateStatusDTO = {
  phase: "idle",
  currentVersion: "0.2.0",
  userMessage: "idle",
  isPackaged: true,
  isPortable: false,
  updaterSupported: true,
};

type StatusHandler = (status: UpdateStatusDTO) => void;

interface MockUpdateApi {
  getUpdateStatus: ReturnType<typeof vi.fn>;
  checkForUpdates: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
  restartAndInstallUpdate: ReturnType<typeof vi.fn>;
  onUpdateStatusChanged: ReturnType<typeof vi.fn>;
  /** Capture all subscribed status-change handlers. */
  subscribed: StatusHandler[];
}

function installMockApi(overrides: Partial<MockUpdateApi> = {}): MockUpdateApi {
  const subscribed: StatusHandler[] = [];
  const api: MockUpdateApi = {
    getUpdateStatus: vi.fn().mockResolvedValue(DEFAULT_STATUS),
    checkForUpdates: vi.fn().mockResolvedValue(DEFAULT_STATUS),
    downloadUpdate: vi.fn().mockResolvedValue(DEFAULT_STATUS),
    restartAndInstallUpdate: vi.fn().mockResolvedValue(DEFAULT_STATUS),
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

describe("useUpdateStatus", () => {
  beforeEach(() => {
    delete (window as unknown as { screenlink?: unknown }).screenlink;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the initial status on mount", async () => {
    const api = installMockApi();
    const { result } = renderHook(() => useUpdateStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(api.getUpdateStatus).toHaveBeenCalledTimes(1);
    expect(result.current.status).toEqual(DEFAULT_STATUS);
    expect(result.current.error).toBeNull();
  });

  it("subscribes to status-change events and reflects them", async () => {
    const api = installMockApi();
    const { result } = renderHook(() => useUpdateStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(api.onUpdateStatusChanged).toHaveBeenCalled();

    const next: UpdateStatusDTO = {
      ...DEFAULT_STATUS,
      phase: "update-available",
      availableVersion: "0.3.0",
    };
    act(() => {
      for (const handler of api.subscribed) handler(next);
    });

    await waitFor(() => {
      expect(result.current.status?.phase).toBe("update-available");
    });
    expect(result.current.status?.availableVersion).toBe("0.3.0");
  });

  it("cleans up the subscription on unmount", async () => {
    const api = installMockApi();
    const { result, unmount } = renderHook(() => useUpdateStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(api.subscribed.length).toBe(1);

    unmount();
    expect(api.subscribed.length).toBe(0);
  });

  it("prevents duplicate concurrent action calls", async () => {
    let resolveCheck!: (value: UpdateStatusDTO) => void;
    const api = installMockApi({
      checkForUpdates: vi.fn(
        () => new Promise<UpdateStatusDTO>((resolve) => {
          resolveCheck = resolve;
        }),
      ),
    });

    const { result } = renderHook(() => useUpdateStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      void result.current.check();
    });
    act(() => {
      void result.current.check();
    });
    act(() => {
      void result.current.check();
    });

    expect(api.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(result.current.actionInFlight).toBe("check");

    await act(async () => {
      resolveCheck(DEFAULT_STATUS);
    });
  });

  it("surfaces IPC rejection as an error state", async () => {
    installMockApi({
      getUpdateStatus: vi.fn().mockRejectedValue(new Error("IPC failed")),
    });
    const { result } = renderHook(() => useUpdateStatus());

    await waitFor(() => {
      expect(result.current.error).toBe("IPC failed");
    });
    expect(result.current.loading).toBe(false);
  });

  it("exposes typed actions: check, download, restartAndInstall", async () => {
    const api = installMockApi();
    const { result } = renderHook(() => useUpdateStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.check();
    });
    await act(async () => {
      await result.current.download();
    });
    await act(async () => {
      await result.current.restartAndInstall();
    });

    expect(api.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(api.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(api.restartAndInstallUpdate).toHaveBeenCalledTimes(1);
  });

  it("returns null status when no preload API is present (test env)", async () => {
    const { result } = renderHook(() => useUpdateStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.status).toBeNull();
  });
});
