import { getRuntime } from "./phase3-runtime.js";
import { useStore } from "../stores/main-store.js";
import type {
  AudioModeValue,
  SessionQualityOverride,
  ShareSource,
} from "./share-quality.js";
import { validateSessionQualityOverride } from "./share-quality.js";

export type { AudioModeValue, ShareSource, SessionQualityOverride };

/**
 * Typed input for the shared start transaction. Mirrors StartShareInput
 * in share-quality.ts but keeps the local type so other renderer
 * callers don't have to import the type module just to start a share.
 */
export interface StartShareInput {
  groupId: string;
  source: ShareSource;
  qualityOverride?: SessionQualityOverride;
}

/**
 * Start sharing the given source in the given group using the given
 * optional quality override.
 *
 * Uses the Phase3 runtime's StreamSessionManager for the real stream
 * lifecycle (capture → publish → register → heartbeat). Updates the
 * Zustand store on success/failure. Preserves audio-degrade behavior
 * from StreamSessionManager.
 *
 * Throws on failure. Callers (ShareSetup, QuickShareDialog) are
 * responsible for showing toasts and closing their dialogs.
 */
export async function startShare(input: StartShareInput): Promise<void> {
  const store = useStore.getState();

  // Validate explicit group ID.
  if (!input.groupId || typeof input.groupId !== "string") {
    store.setLocalShareState("error");
    throw new Error("Group ID is required to start a share");
  }

  if (!input.source || !input.source.id) {
    store.setLocalShareState("error");
    throw new Error("Source is required to start a share");
  }

  if (input.qualityOverride) {
    const err = validateSessionQualityOverride(input.qualityOverride);
    if (err) {
      store.setLocalShareState("error");
      throw new Error(`Invalid quality override: ${err}`);
    }
  }

  // Optimistically set source info in store before starting.
  store.setSource({
    id: input.source.id,
    name: input.source.name,
    kind: input.source.kind,
    displayId: input.source.displayId ?? "",
    fingerprint: input.source.fingerprint,
  });
  store.setLocalShareState("starting");

  const runtime = getRuntime();
  if (!runtime) {
    store.setLocalShareState("error");
    throw new Error("Phase3 runtime not available");
  }

  try {
    const ssm = runtime.getStreamSessionManager();

    const streamInput: {
      groupId: string;
      source: {
        id: string;
        name: string;
        kind: "screen" | "window";
        displayId: string | null;
        fingerprint: string | null;
      };
      audioMode?: "none" | "monitor" | "application";
      qualityOverride?: SessionQualityOverride;
    } = {
      groupId: input.groupId,
      source: {
        id: input.source.id,
        name: input.source.name,
        kind: input.source.kind,
        displayId: input.source.displayId ?? null,
        fingerprint: input.source.fingerprint,
      },
    };
    if (input.source.audioMode !== undefined) {
      streamInput.audioMode = input.source.audioMode;
    }
    if (input.qualityOverride) {
      streamInput.qualityOverride = input.qualityOverride;
    }

    await ssm.startStream(streamInput);

    if (input.source.audioMode !== undefined) {
      const mode = input.source.audioMode;
      if (
        input.source.kind === "screen" &&
        (mode === "none" || mode === "monitor")
      ) {
        store.setLastScreenAudioMode(mode);
      }
      if (
        input.source.kind === "window" &&
        (mode === "none" || mode === "application")
      ) {
        store.setLastWindowAudioMode(mode);
      }
    }

    const dims = ssm.getActualCaptureDimensions();
    store.setCaptureInfo(dims.width, dims.height, dims.fps);

    if (ssm.isAudioDegraded) {
      store.setIsDegraded(true);
    }

    store.setIsSharing(true);
    store.setLocalShareState("sharing");
  } catch (err) {
    store.setLocalShareState("error");
    throw err;
  }
}

/**
 * Backward-compatible overload for callers that still pass a
 * source-only object. The group is read from selectedGroupId; this
 * is acceptable for in-app flows that have already populated the
 * store. Quick Share must use the explicit `groupId` overload.
 */
export async function startShareLegacy(source: ShareSource): Promise<void> {
  const store = useStore.getState();
  const groupId = store.selectedGroupId;
  if (!groupId) {
    store.setLocalShareState("error");
    throw new Error("No group selected");
  }
  return startShare({ groupId, source });
}

/**
 * Stop the active share.
 *
 * Uses the Phase3 runtime's StreamSessionManager.stopStream for clean
 * teardown (broadcast stream.stopped, remove registry entry, close
 * viewer mappings, stop publication/capture). Resets store state on
 * completion.
 *
 * Safe to call when no share is active or when runtime is unavailable.
 */
export async function stopShare(): Promise<void> {
  const store = useStore.getState();
  store.setLocalShareState("stopping");

  const runtime = getRuntime();
  if (!runtime) {
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
