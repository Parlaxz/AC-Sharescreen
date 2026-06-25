import { getRuntime } from "./phase3-runtime.js";
import { useStore } from "../stores/main-store.js";

/**
 * Source descriptor for starting a share.
 * Aligned with StartStreamInput.source from StreamSessionManager.
 */
export interface ShareSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  displayId: string | null;
  fingerprint: string | null;
  /** User's audio mode choice. When omitted, source-derived mode is used. */
  audioMode?: "none" | "monitor" | "application";
}


/**
 * Start sharing the given source to the currently selected group.
 *
 * Uses the Phase3 runtime's StreamSessionManager for the real stream lifecycle
 * (capture → publish → register → heartbeat). Updates the Zustand store on
 * success/failure. Preserves audio-degrade behavior from StreamSessionManager.
 *
 * Throws on failure. The caller (ShareSetup) is responsible for showing toasts
 * and closing the dialog.
 */
export async function startShare(source: ShareSource): Promise<void> {
  const store = useStore.getState();

  // Validate that a group is selected
  const groupId = store.selectedGroupId;
  if (!groupId) {
    store.setLocalShareState("error");
    throw new Error("No group selected");
  }

  // Optimistically set source info in store before starting
  store.setSource({
    id: source.id,
    name: source.name,
    kind: source.kind,
    displayId: source.displayId ?? "",
    fingerprint: source.fingerprint,
  });
  store.setLocalShareState("starting");

  const runtime = getRuntime();
  if (!runtime) {
    store.setLocalShareState("error");
    throw new Error("Phase3 runtime not available");
  }

  try {
    const ssm = runtime.getStreamSessionManager();

    // Build startStream input with optional audio mode
    const streamInput: {
      groupId: string;
      source: {
        id: string; name: string; kind: "screen" | "window";
        displayId: string | null; fingerprint: string | null;
      };
      audioMode?: "none" | "monitor" | "application";
    } = {
      groupId,
      source: {
        id: source.id,
        name: source.name,
        kind: source.kind,
        displayId: source.displayId ?? null,
        fingerprint: source.fingerprint,
      },
    };
    if (source.audioMode !== undefined) {
      streamInput.audioMode = source.audioMode;
    }

    // Start the real stream via StreamSessionManager
    await ssm.startStream(streamInput);

    // Persist last audio mode per source kind
    if (source.audioMode !== undefined) {
      if (source.kind === "screen" && (source.audioMode === "none" || source.audioMode === "monitor")) {
        store.setLastScreenAudioMode(source.audioMode);
      }
      if (source.kind === "window" && (source.audioMode === "none" || source.audioMode === "application")) {
        store.setLastWindowAudioMode(source.audioMode);
      }
    }

    // Read back actual capture dimensions from the SSM (Gate 4.4)
    const dims = ssm.getActualCaptureDimensions();
    store.setCaptureInfo(dims.width, dims.height, dims.fps);

    // Propagate audio degrade state
    if (ssm.isAudioDegraded) {
      store.setIsDegraded(true);
    }

    // Mark as actively sharing
    store.setIsSharing(true);
    store.setLocalShareState("sharing");
  } catch (err) {
    store.setLocalShareState("error");
    throw err;
  }

}

/**
 * Stop the active share.
 *
 * Uses the Phase3 runtime's StreamSessionManager.stopStream for clean
 * teardown (broadcast stream.stopped, remove registry entry, close viewer
 * mappings, stop publication/capture). Resets store state on completion.
 *
 * Safe to call when no share is active or when runtime is unavailable.
 */
export async function stopShare(): Promise<void> {
  const store = useStore.getState();
  store.setLocalShareState("stopping");

  const runtime = getRuntime();
  if (!runtime) {
    // No runtime — just reset store state
    store.setIsSharing(false);
    store.setLocalShareState("idle");
    store.setIsDegraded(false);
    return;
  }

  try {
    const ssm = runtime.getStreamSessionManager();
    await ssm.stopStream();
  } catch {
    // Stop is best-effort; reset store regardless of errors
  } finally {
    store.setIsSharing(false);
    store.setLocalShareState("idle");
    store.setIsDegraded(false);
  }
}
