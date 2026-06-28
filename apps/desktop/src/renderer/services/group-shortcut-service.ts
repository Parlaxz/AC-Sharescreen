import { useStore } from "@/stores/main-store";
import { startShare, type ShareSource } from "./share-coordinator";
import { presetSettingsToOverride, type PresetSettingsLike } from "./share-quality";
import { showNotification } from "./notifications";
import type { GroupShortcutConfigDTO, CaptureSourceDTO } from "../../preload/api-types.js";

/**
 * Per-group-action in-progress guards to prevent race conditions
 * from rapid shortcut presses.
 *
 * Map: "groupId:action" -> true while an action is in progress.
 */
const inProgressGuards = new Set<string>();

function guardKey(groupId: string, action: string): string {
  return `${groupId}:${action}`;
}

function isInProgress(groupId: string, action: string): boolean {
  return inProgressGuards.has(guardKey(groupId, action));
}

function setInProgress(groupId: string, action: string, value: boolean): void {
  const key = guardKey(groupId, action);
  if (value) {
    inProgressGuards.add(key);
  } else {
    inProgressGuards.delete(key);
  }
}

/**
 * Get the preload API, returning null when unavailable (tests, SSR).
 */
function getApi(): Record<string, unknown> | null {
  try {
    return (window as unknown as { screenlink?: Record<string, unknown> }).screenlink ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a configured source by matching against current available sources.
 * Returns null when the source no longer exists or cannot be uniquely identified.
 */
async function resolveConfiguredSource(
  config: GroupShortcutConfigDTO,
): Promise<{ source: ShareSource } | null> {
  if (!config.quickShareSource) return null;

  const api = getApi();
  if (!api || typeof api.getSources !== "function") return null;

  try {
    const sources: CaptureSourceDTO[] = await api.getSources();
    const configured = config.quickShareSource;

    // Try exact match by sourceId first
    const exact = sources.find((s) => s.id === configured.id);
    if (exact) {
      return {
        source: {
          id: exact.id,
          name: exact.name,
          kind: exact.kind,
          displayId: exact.displayId,
          fingerprint: null,
        },
      };
    }

    // For screens, try matching by displayId
    if (configured.kind === "screen") {
      const byDisplay = sources.filter(
        (s) => s.kind === "screen" && s.displayId === configured.displayId,
      );
      if (byDisplay.length === 1) {
        const match = byDisplay[0];
        return {
          source: {
            id: match.id,
            name: match.name,
            kind: match.kind,
            displayId: match.displayId,
            fingerprint: null,
          },
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Get audio mode from a quality preset's settings.
 */
function getAudioModeFromPreset(preset: unknown): "none" | "monitor" | "application" {
  if (!preset || typeof preset !== "object") return "none";
  const p = preset as Record<string, unknown>;
  const settings = p.settings as Record<string, unknown> | undefined;
  if (!settings || typeof settings !== "object") return "none";
  const audio = settings.audio as Record<string, unknown> | undefined;
  if (!audio || typeof audio !== "object") return "none";
  // QualityPreset audio doesn't have an explicit "audio mode" —
  // if audio fec is enabled or bitrate > 0, default to "monitor" for screen
  const fec = audio.fec as boolean | undefined;
  const bitrate = audio.bitrateKbps as number | undefined;
  if (fec || (bitrate && bitrate > 0)) return "monitor";
  return "none";
}

/**
 * Execute a Quick Share for a group.
 * Resolves the configured source and preset, then starts the share.
 */
export async function executeQuickShare(groupId: string): Promise<void> {
  const guard = guardKey(groupId, "quick-share");
  if (isInProgress(groupId, "quick-share")) return;
  setInProgress(groupId, "quick-share", true);

  try {
    const store = useStore.getState();

    // 1. Confirm group still exists
    if (!store.groupsById[groupId]) {
      showNotification({
        title: "Quick Share",
        body: "The target group no longer exists.",
      });
      return;
    }

    // 2. Check if already sharing in this group
    if (store.isSharing && store.sharingGroupId === groupId) {
      return; // Already sharing — no-op
    }

    const api = getApi();

    // 3. Resolve shortcut config
    let config: GroupShortcutConfigDTO | null = null;
    if (api && typeof api.getGroupShortcutConfig === "function") {
      config = await api.getGroupShortcutConfig(groupId) as GroupShortcutConfigDTO;
    }

    if (!config) {
      showNotification({
        title: "Quick Share",
        body: "Quick Share is not configured for this group.",
      });
      return;
    }

    // 4. Resolve the configured source
    const resolved = await resolveConfiguredSource(config);
    if (!resolved) {
      showNotification({
        title: "Quick Share",
        body: "The configured Quick Share source is unavailable.",
      });
      return; // No fallback — spec says show toast
    }

    // 5. Resolve the configured preset
    const presetId = config.quickShareDefaultPresetId;
    let qualityOverride: ReturnType<typeof presetSettingsToOverride> | undefined;
    if (presetId && api && typeof api.getQualityPreset === "function") {
      const preset = await api.getQualityPreset(presetId);
      if (!preset) {
        showNotification({
          title: "Quick Share",
          body: "The configured Quick Share preset is no longer available.",
        });
        return; // No fallback
      }
      qualityOverride = presetSettingsToOverride(
        (preset as { settings: PresetSettingsLike }).settings,
      );
    }

    // 6. Start the share
    const source: ShareSource = {
      ...resolved.source,
      // Determine audio mode from preset settings
      audioMode: qualityOverride
        ? getAudioModeFromPreset({ settings: { video: qualityOverride } })
        : "none",
    };

    await startShare({ groupId, source, qualityOverride });
  } catch (err) {
    console.error("[GroupShortcut] Quick Share failed:", err);
    showNotification({
      title: "Quick Share",
      body: `Failed to start share: ${err instanceof Error ? err.message : "Unknown error"}`,
    });
  } finally {
    setInProgress(groupId, "quick-share", false);
  }
}

/**
 * Execute a Quick Join for a group.
 * Finds the newest non-local active stream and opens the viewer.
 */
export async function executeQuickJoin(groupId: string): Promise<void> {
  const guard = guardKey(groupId, "quick-join");
  if (isInProgress(groupId, "quick-join")) return;
  setInProgress(groupId, "quick-join", true);

  try {
    const store = useStore.getState();

    // 1. Confirm group still exists
    if (!store.groupsById[groupId]) {
      showNotification({
        title: "Quick Join",
        body: "The target group no longer exists.",
      });
      return;
    }

    // 2. Find the local device ID
    const api = getApi();
    let localDeviceId: string | null = null;
    if (api && typeof api.getDeviceIdentity === "function") {
      const identity = await api.getDeviceIdentity() as { deviceId: string };
      localDeviceId = identity.deviceId;
    }

    // 3. Read active streams, exclude local, sort by startedAt desc
    const streams = store.activeStreamsByGroup[groupId] ?? [];
    const eligible = streams.filter((s) => s.hostDeviceId !== localDeviceId);

    if (eligible.length === 0) {
      showNotification({
        title: "Quick Join",
        body: "There are no active streams to join in this group.",
      });
      return;
    }

    // Sort by startedAt descending (newest first)
    eligible.sort((a, b) => b.startedAt - a.startedAt);

    // 4. Try the newest stream, with one retry if it disappears
    let selected = eligible[0];
    let retried = false;

    function alreadyWatching(stream: typeof selected): boolean {
      const target = store.watchingTarget;
      if (!target) return false;
      return (
        target.logicalStreamId === stream.logicalStreamId &&
        target.mediaSessionId === stream.mediaSessionId
      );
    }

    // Check if already viewing this stream
    if (alreadyWatching(selected)) {
      return; // No-op
    }

    // 5. Check if the stream still exists (refresh once)
    const currentStreams = useStore.getState().activeStreamsByGroup[groupId] ?? [];
    const stillExists = currentStreams.some(
      (s) =>
        s.logicalStreamId === selected.logicalStreamId &&
        s.mediaSessionId === selected.mediaSessionId,
    );

    if (!stillExists && eligible.length > 1) {
      // Retry once with next-newest
      selected = eligible[1];
      retried = true;

      if (alreadyWatching(selected)) {
        return; // No-op
      }
    } else if (!stillExists) {
      showNotification({
        title: "Quick Join",
        body: "There are no active streams to join in this group.",
      });
      return;
    }

    // 6. Open the viewer
    store.setWatchingTarget({
      groupId: selected.groupId,
      logicalStreamId: selected.logicalStreamId,
      mediaSessionId: selected.mediaSessionId,
      hostDeviceId: selected.hostDeviceId,
      hostName: selected.hostDisplayName,
      startedAt: selected.startedAt,
      sourceName: selected.sourceName,
      sourceKind: selected.sourceKind,
    });
    store.setIsViewing(true);
    store.setViewStatus("connecting");
  } catch (err) {
    console.error("[GroupShortcut] Quick Join failed:", err);
    showNotification({
      title: "Quick Join",
      body: `Failed to join stream: ${err instanceof Error ? err.message : "Unknown error"}`,
    });
  } finally {
    setInProgress(groupId, "quick-join", false);
  }
}

/**
 * Initialize the group shortcut event listener.
 * Call once at app startup. Returns a cleanup function.
 */
export function initGroupShortcutListener(): () => void {
  const api = getApi();
  if (!api || typeof api.onGroupShortcutExecute !== "function") {
    return () => {};
  }

  const cleanup = (api.onGroupShortcutExecute as (cb: (payload: { groupId: string; action: "quick-share" | "quick-join" }) => void) => () => void)(
    (payload: { groupId: string; action: "quick-share" | "quick-join" }) => {
      if (payload.action === "quick-share") {
        executeQuickShare(payload.groupId).catch((err) =>
          console.error("[GroupShortcut] executeQuickShare error:", err),
        );
      } else if (payload.action === "quick-join") {
        executeQuickJoin(payload.groupId).catch((err) =>
          console.error("[GroupShortcut] executeQuickJoin error:", err),
        );
      }
    },
  );

  return cleanup;
}
