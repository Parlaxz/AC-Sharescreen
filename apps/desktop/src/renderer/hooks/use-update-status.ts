/**
 * use-update-status.ts
 *
 * Single renderer hook that owns all interaction with the main-process
 * `UpdateManager`. Subscribes to status changes, exposes typed actions
 * (check / download / restartAndInstall), and prevents duplicate
 * concurrent action calls.
 *
 * The hook never invents update state. It returns the most recent
 * `UpdateStatusDTO` reported by the main process, plus a small
 * `error` surface for IPC failures that occur on the renderer side
 * (e.g. the bridge is missing, the invoke promise rejects).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { UpdateStatusDTO } from "../../preload/api-types.js";

interface ScreenLinkUpdateApi {
  getUpdateStatus: () => Promise<UpdateStatusDTO>;
  checkForUpdates: () => Promise<UpdateStatusDTO>;
  downloadUpdate: () => Promise<UpdateStatusDTO>;
  restartAndInstallUpdate: () => Promise<UpdateStatusDTO>;
  checkDownloadAndInstall: () => Promise<UpdateStatusDTO>;
  onUpdateStatusChanged: (callback: (status: UpdateStatusDTO) => void) => () => void;
}

type WindowWithScreenlink = Window & {
  screenlink?: ScreenLinkUpdateApi;
};

function getApi(): ScreenLinkUpdateApi | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as WindowWithScreenlink;
  return w.screenlink ?? null;
}

export type UpdateAction = "check" | "download" | "restartAndInstall" | "fullUpdate";

export interface UseUpdateStatusResult {
  status: UpdateStatusDTO | null;
  loading: boolean;
  actionInFlight: UpdateAction | null;
  error: string | null;
  /** True when a renderer-side action has been initiated at least once. */
  hasStarted: boolean;
  check: () => Promise<void>;
  download: () => Promise<void>;
  restartAndInstall: () => Promise<void>;
  checkDownloadAndInstall: () => Promise<void>;
}

const ACTIONS: Record<UpdateAction, keyof ScreenLinkUpdateApi> = {
  check: "checkForUpdates",
  download: "downloadUpdate",
  restartAndInstall: "restartAndInstallUpdate",
  fullUpdate: "checkDownloadAndInstall",
};

export function useUpdateStatus(): UseUpdateStatusResult {
  const [status, setStatus] = useState<UpdateStatusDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionInFlight, setActionInFlight] = useState<UpdateAction | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [hasStarted, setHasStarted] = useState<boolean>(false);

  // Refs allow the runAction callback to be stable while still
  // reading the latest state for in-flight tracking.
  const inFlightRef = useRef<UpdateAction | null>(null);
  const unmountedRef = useRef<boolean>(false);

  // ── 1. Initial status load ───────────────────────────────────────────
  useEffect(() => {
    const api = getApi();
    if (!api) {
      // No bridge available (e.g. test env). Leave status null; the
      // component should treat that as "no data".
      setLoading(false);
      return;
    }

    let cancelled = false;

    api
      .getUpdateStatus()
      .then((initial) => {
        if (cancelled) return;
        setStatus(initial);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // ── 2. Status subscription ───────────────────────────────────────────
  useEffect(() => {
    const api = getApi();
    if (!api?.onUpdateStatusChanged) return;

    const unsub = api.onUpdateStatusChanged((next) => {
      if (unmountedRef.current) return;
      setStatus(next);
    });

    return () => {
      if (typeof unsub === "function") unsub();
    };
  }, []);

  // ── 3. Cleanup on unmount ────────────────────────────────────────────
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  // ── 4. Typed actions with duplicate-call prevention ──────────────────
  const runAction = useCallback(
    async (action: UpdateAction): Promise<void> => {
      // Block re-entrancy: if a different action is in flight, ignore.
      if (inFlightRef.current !== null) return;
      // Block re-entrancy: if the same action is already in flight, ignore.
      if (actionInFlight === action) return;

      const api = getApi();
      if (!api) {
        setError("Update API is not available in this environment.");
        return;
      }

      const methodName = ACTIONS[action];
      const method = api[methodName];
      if (typeof method !== "function") {
        setError(`Update action "${action}" is not supported by the preload bridge.`);
        return;
      }

      inFlightRef.current = action;
      setActionInFlight(action);
      setHasStarted(true);
      setError(null);

      try {
        const next = await (method as () => Promise<UpdateStatusDTO>).call(api);
        if (unmountedRef.current) return;
        if (next) setStatus(next);
      } catch (err: unknown) {
        if (unmountedRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlightRef.current = null;
        if (!unmountedRef.current) {
          setActionInFlight(null);
        }
      }
    },
    [actionInFlight],
  );

  const check = useCallback(() => runAction("check"), [runAction]);
  const download = useCallback(() => runAction("download"), [runAction]);
  const restartAndInstall = useCallback(
    () => runAction("restartAndInstall"),
    [runAction],
  );
  const checkDownloadAndInstall = useCallback(
    () => runAction("fullUpdate"),
    [runAction],
  );

  return {
    status,
    loading,
    actionInFlight,
    error,
    hasStarted,
    check,
    download,
    restartAndInstall,
    checkDownloadAndInstall,
  };
}
