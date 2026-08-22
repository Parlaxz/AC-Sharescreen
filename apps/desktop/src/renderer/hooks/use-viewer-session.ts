/**
 * useViewerSession — Phase 4 hook
 *
 * Creates/manages a ViewerSessionController and exposes its snapshot.
 * ViewerWorkspace replaces module-level lifecycle state with this hook.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ViewerSessionController, setActiveController, type ViewerSessionSnapshot } from "@/services/viewer-session-controller";
import type { StreamTarget } from "@screenlink/shared";

let _controller: ViewerSessionController | null = null;
let _listenerCount = 0;
let _snapListeners = new Set<() => void>();
let _destroyTimer: ReturnType<typeof setTimeout> | null = null;

/** Small delay to absorb React StrictMode's transient unsubscribe/resubscribe. */
const DESTROY_DELAY_MS = 100;

function getOrCreateController(): ViewerSessionController {
  if (!_controller) {
    // Cancel any pending deferred destroy — a new controller is being created
    if (_destroyTimer !== null) {
      clearTimeout(_destroyTimer);
      _destroyTimer = null;
    }
    _controller = new ViewerSessionController();
    setActiveController(_controller);
  }
  return _controller;
}

function getSnapshot(): ViewerSessionSnapshot {
  return getOrCreateController().snapshot;
}

function subscribeToSnapshot(cb: () => void): () => void {
  // Cancel any pending deferred destroy — a new subscription is alive
  if (_destroyTimer !== null) {
    clearTimeout(_destroyTimer);
    _destroyTimer = null;
  }

  _snapListeners.add(cb);
  _listenerCount++;
  const unsub = getOrCreateController().subscribe(() => {
    for (const l of _snapListeners) l();
  });
  const cleanup = () => {
    _snapListeners.delete(cb);
    _listenerCount--;
    if (_listenerCount <= 0 && _controller) {
      // Defer destruction so React StrictMode's transient
      // unsubscribe/resubscribe does not tear down a live session.
      // A new subscription (from the probe's second mount) will
      // cancel the timer above in subscribeToSnapshot.
      _destroyTimer = setTimeout(() => {
        _destroyTimer = null;
        if (_listenerCount <= 0 && _controller) {
          setActiveController(null);
          _controller.destroy().catch(() => {});
          _controller = null;
        }
      }, DESTROY_DELAY_MS);
    }
    unsub();
  };
  return cleanup;
}

/**
 * Hook that provides the current ViewerSessionSnapshot and controller
 * commands. Replaces module-level lifecycle promise, sessionRef,
 * startAttemptRef, and duplicate lifecycle state in ViewerWorkspace.
 */
export function useViewerSession() {
  const snapshot = useSyncExternalStore(subscribeToSnapshot, getSnapshot, getSnapshot);
  const controllerRef = useRef<ViewerSessionController>(getOrCreateController());

  // Keep controllerRef synchronized with the module-level singleton on every
  // render so commands and snapshots cannot point at different controllers.
  if (_controller && controllerRef.current !== _controller) {
    controllerRef.current = _controller;
  }

  const start = useCallback(async (target: StreamTarget, videoElement: HTMLVideoElement | null) => {
    await controllerRef.current.start(target, videoElement);
  }, []);

  const retry = useCallback(async () => {
    await controllerRef.current.retry();
  }, []);

  /** Manual recovery — shares the same implementation as automatic recovery. */
  const recover = useCallback(async () => {
    await controllerRef.current.recover();
  }, []);

  const stop = useCallback(async () => {
    await controllerRef.current.stop();
  }, []);

  const refreshTarget = useCallback(() => {
    controllerRef.current.refreshTarget();
  }, []);

  return {
    snapshot,
    controller: controllerRef.current,
    start,
    retry,
    recover,
    stop,
    refreshTarget,
  };
}
