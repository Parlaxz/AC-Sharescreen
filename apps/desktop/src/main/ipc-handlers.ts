import { ipcMain, app, shell, BrowserWindow, clipboard } from "electron";
import { enumerateSources, getSourceFingerprint } from "./capture-source-manager.js";
import { setApprovedSource } from "./display-media-handler.js";
import { getAudioCapabilities, getHelperPath } from "./audio-capability-service.js";
import { probeNvidiaVsrCapability } from "./nvidia-capability-service.js";
import { AudioHelperManager } from "./AudioHelperManager.js";
import { VideoHelperManager } from "./VideoHelperManager.js";
import { randomUUID } from "node:crypto";
import type { VideoEnhancerConfig } from "./video-enhancer-protocol.js";
import {
  generateVdoStreamId,
  generateVdoPassword,
  GroupSharedStateSchema,
  HybridTimestampSchema,
  type GroupInviteV1,
} from "@screenlink/shared";
import type { SettingsStore } from "./settings-store.js";
import type { SecureStore } from "./secure-store.js";
import type { TrayManager } from "./tray-manager.js";
import type { GroupStore } from "./group-store.js";
import type { QualityPresetStore } from "./quality-preset-store.js";
import type { GroupShortcutManager } from "./group-shortcut-manager.js";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  sendShortcutViaPowerShellSendInput,
  sendShortcutWithFallback,
  type ShortcutBinding,
} from "./shortcut-sender.js";

// In-memory VDO session credentials (set by host when sharing starts)
let currentVdoStreamId = "";
let currentVdoPassword = "";

export function setCurrentVdoCredentials(streamId: string, password: string): void {
  currentVdoStreamId = streamId;
  currentVdoPassword = password;
}

export function clearCurrentVdoCredentials(): void {
  currentVdoStreamId = "";
  currentVdoPassword = "";
}

// ── Audio helper state (set by main process lifecycle) ──────────────────────

let currentAudioHelper: AudioHelperManager | null = null;
let currentAudioState: string = "disabled";

export function setCurrentAudioHelper(helper: AudioHelperManager | null): void {
  currentAudioHelper = helper;
}

export function setCurrentAudioState(state: string): void {
  currentAudioState = state;
}

/**
 * Shut down the active audio helper cleanly. Safe to call even when no
 * helper is running. Exported so the update-manager can shut down the
 * helper before quitAndInstall().
 */
export async function stopCurrentAudioHelper(): Promise<void> {
  if (!currentAudioHelper) return;
  setCurrentAudioState("stopping");
  try {
    await currentAudioHelper.shutdown();
  } catch (err) {
    console.error("[ipc] Audio helper shutdown error:", err);
  }
  setCurrentAudioHelper(null);
  setCurrentAudioState("disabled");
}

async function ensureAudioHelper(): Promise<AudioHelperManager> {
  if (currentAudioHelper) return currentAudioHelper;

  const helperPath = getHelperPath();
  setCurrentAudioState("starting-helper");

  const helper = new AudioHelperManager({ helperPath });
  helper.onPacket(() => {});
  helper.onError((err) => console.error("[Audio] Helper error:", err));
  await helper.start();

  setCurrentAudioHelper(helper);
  setCurrentAudioState("connecting-transport");

  return helper;
}

// ── Video helper state (singleton manager) ──

let videoHelperManager: VideoHelperManager | null = null;

function ensureVideoHelperManager(): VideoHelperManager {
  if (!videoHelperManager) {
    videoHelperManager = new VideoHelperManager();
  }
  return videoHelperManager;
}

export function registerIpcHandlers(
  window: BrowserWindow,
  settings: SettingsStore,
  secureStore: SecureStore,
  trayManager: TrayManager,
  groupStore?: GroupStore,
  presetStore?: QualityPresetStore,
  onQuickShareConfigUpdated?: (enabled: boolean, accelerator: string) => void,
  groupShortcutManager?: GroupShortcutManager,
): void {
  // ── VDO session credentials (for LAN testing) ─────────────────────────

  ipcMain.handle("get-vdo-credentials", () => {
    return {
      streamId: currentVdoStreamId,
      password: currentVdoPassword,
    };
  });

  ipcMain.handle("start-vdo-session", () => {
    const streamId = generateVdoStreamId();
    const password = generateVdoPassword();
    setCurrentVdoCredentials(streamId, password);
    return { streamId, password };
  });

  ipcMain.handle("stop-vdo-session", () => {
    clearCurrentVdoCredentials();
  });

  // ── Desktop capture sources ──────────────────────────────────────────────

  ipcMain.handle("get-sources", async () => {
    try {
      const sources = await enumerateSources();
      console.log(`[IPC] get-sources: found ${sources.length} sources`);
      return sources;
    } catch (err) {
      console.error("[IPC] get-sources failed:", err);
      throw err;
    }
  });

  ipcMain.handle("set-source", async (_event, sourceId: string | null) => {
    setApprovedSource(sourceId);
  });

  ipcMain.handle("get-source-fingerprint", async (_event, sourceId: string) => {
    const sources = await enumerateSources();
    const source = sources.find(s => s.id === sourceId);
    if (!source) return null;
    return getSourceFingerprint(source);
  });

  // ── Settings persistence ─────────────────────────────────────────────────

  ipcMain.handle("get-settings", () => {
    return settings.get();
  });

  ipcMain.handle(
    "update-settings",
    (_event, partial: Record<string, unknown>) => {
      settings.update(partial as never);
    },
  );

  // ── Secure storage (token encryption) ────────────────────────────────────

  ipcMain.handle("encrypt-token", (_event, plaintext: string) => {
    const encrypted = secureStore.encrypt(plaintext);
    return encrypted?.toString("base64") ?? null;
  });

  ipcMain.handle("decrypt-token", (_event, encryptedB64: string) => {
    const buf = Buffer.from(encryptedB64, "base64");
    return secureStore.decrypt(buf);
  });

  // ── Window management ────────────────────────────────────────────────────

  ipcMain.handle("minimize-to-tray", () => {
    window.hide();
  });

  // ── Window controls (Stage 3.7B custom title bar) ─────────────────────────

  ipcMain.handle("window:minimize", () => {
    window.minimize();
  });

  ipcMain.handle("window:toggle-maximize", () => {
    const newState = !window.isMaximized();
    if (newState) {
      window.maximize();
    } else {
      window.unmaximize();
    }
    return newState;
  });

  ipcMain.handle("window:close", () => {
    window.close();
  });

  // ── Device identity ──────────────────────────────────────────────────────

  ipcMain.handle("safe-storage-available", () => {
    return secureStore.isEncryptionAvailable();
  });

  ipcMain.handle("get-device-identity", () => {
    return settings.get().deviceIdentity;
  });

  // ── Clipboard ────────────────────────────────────────────────────
  //
  // The renderer's `navigator.clipboard.writeText` is blocked in
  // many Electron contexts with "Write permission denied" because
  // the document must be focused and the user gesture policy is
  // strict. Use the main-process clipboard module instead — it
  // always works inside the desktop app.
  ipcMain.handle("clipboard-write-text", (_event, text: string) => {
    if (typeof text !== "string") {
      throw new Error("clipboard-write-text expects a string");
    }
    clipboard.writeText(text);
    return { success: true, length: text.length };
  });

  ipcMain.handle("update-display-name", (_event, displayName: string) => {
    const trimmed = String(displayName ?? "").trim();
    if (trimmed.length < 1 || trimmed.length > 100) {
      throw new Error("displayName must be 1-100 characters");
    }
    const current = settings.get();
    settings.update({
      deviceIdentity: { ...current.deviceIdentity, displayName: trimmed },
      hostDisplayName: trimmed,
    });
    return settings.get().deviceIdentity;
  });

  // ── Groups ──────────────────────────────────────────────────────────────

  if (groupStore) {
    ipcMain.handle("list-groups", () => groupStore.list());

    ipcMain.handle("get-group", (_event, groupId: string) => groupStore.get(groupId));

    ipcMain.handle(
      "create-group",
      async (
        _event,
        input: { groupName: string; groupId?: string; nowMs?: number },
      ) => {
        const identity = settings.get().deviceIdentity;
        const { createGroupInvite, formatGroupInviteLink } = await import("@screenlink/shared");
        const invite = createGroupInvite({
          groupName: input.groupName,
          displayName: identity.displayName,
          nodeId: identity.deviceId,
          groupId: input.groupId,
          nowMs: input.nowMs,
        });
        const record = await groupStore.create({
          groupId: invite.groupId,
          controlRoomId: invite.controlRoomId,
          groupSecret: invite.groupSecret,
          nodeId: identity.deviceId,
          groupName: input.groupName,
          displayName: identity.displayName,
        });
        const link = formatGroupInviteLink(invite);
        return { record, invite, link };
      },
    );

    ipcMain.handle(
      "join-group",
      async (_event, payload: { link: string; nowMs?: number }) => {
        const identity = settings.get().deviceIdentity;
        const { parseGroupInviteLink, parseGroupInviteCode } = await import(
          "@screenlink/shared"
        );
        const invite: GroupInviteV1 | null = payload.link.startsWith("screenlink://")
          ? parseGroupInviteLink(payload.link)
          : parseGroupInviteCode(payload.link);
        if (!invite) {
          throw new Error("Invalid group link or code");
        }
        const record = await groupStore.import({ invite, nodeId: identity.deviceId, displayName: identity.displayName, joinedAt: payload.nowMs });
        return record;
      },
    );

    ipcMain.handle(
      "get-group-invite",
      async (_event, groupId: string) => {
        const link = groupStore.getInviteLink(groupId);
        if (!link) return null;
        return { link };
      },
    );

    ipcMain.handle(
      "update-group-shared-state",
      (_event, groupId: string, state: unknown) => {
        const record = groupStore.get(groupId);
        if (!record) throw new Error("Group not found");

        const parsed = GroupSharedStateSchema.safeParse(state);
        if (!parsed.success) {
          throw new Error(`Invalid group state: ${parsed.error.message}`);
        }

        // Verify group ID matches
        if (parsed.data.groupId !== groupId) {
          throw new Error("State groupId does not match IPC groupId");
        }

        // Verify no empty hashes
        if (!parsed.data.name.valueHash || !parsed.data.defaultQuality.valueHash) {
          throw new Error("State contains empty LWW hashes");
        }

        groupStore.updateSharedState(groupId, parsed.data as never);
        return groupStore.get(groupId);
      },
    );

    ipcMain.handle("update-group-clock", (_event, groupId: string, stamp: unknown) => {
      const parsed = HybridTimestampSchema.safeParse(stamp);
      if (!parsed.success) throw new Error(`Invalid clock: ${parsed.error.message}`);
      groupStore.updateClock(groupId, parsed.data as never);
    });

    ipcMain.handle("set-group-notifications", (_event, groupId: string, enabled: boolean) => {
      groupStore.setNotificationsEnabled(groupId, enabled);
    });

    ipcMain.handle("leave-group", (_event, groupId: string) => {
      // Unregister any per-group shortcuts before removing
      if (groupShortcutManager) {
        groupShortcutManager.unregister(groupId, "quick-share");
        groupShortcutManager.unregister(groupId, "quick-join");
      }
      groupStore.leave(groupId);
    });

    ipcMain.handle("get-group-connection-config", (_event, groupId: string) => {
      const identity = settings.get().deviceIdentity;
      return groupStore.getConnectionConfig(groupId, identity.deviceId);
    });

    // ── Per-group shortcut config ─────────────────────────────────────
    ipcMain.handle("get-group-shortcut-config", (_event, groupId: string) => {
      return groupStore.getGroupShortcutConfig(groupId);
    });

    ipcMain.handle(
      "update-group-shortcut-config",
      (
        _event,
        groupId: string,
        config: {
          quickShareShortcut?: string | null;
          quickJoinShortcut?: string | null;
          quickShareSource?: { id: string; name: string; kind: "screen" | "window"; displayId: string | null } | null;
          quickShareDefaultPresetId?: string | null;
        },
      ) => {
        if (!groupShortcutManager || !groupStore.get(groupId)) {
          throw new Error("Group not found or shortcut manager unavailable");
        }

        // If quickShareShortcut is being changed, try to register it
        if ("quickShareShortcut" in config) {
          const result = groupShortcutManager.register(
            groupId,
            "quick-share",
            config.quickShareShortcut ?? null,
          );
          if (!result.success) {
            throw new Error(result.error ?? "Failed to register Quick Share shortcut");
          }
        }

        // If quickJoinShortcut is being changed, try to register it
        if ("quickJoinShortcut" in config) {
          const result = groupShortcutManager.register(
            groupId,
            "quick-join",
            config.quickJoinShortcut ?? null,
          );
          if (!result.success) {
            throw new Error(result.error ?? "Failed to register Quick Join shortcut");
          }
        }

        groupStore.updateGroupShortcutConfig(groupId, config);
        return groupStore.getGroupShortcutConfig(groupId);
      },
    );

    // Validation-only (no registration, no persistence)
    ipcMain.handle(
      "validate-group-shortcut",
      (
        _event,
        shortcut: string,
        groupId: string,
        action: "quick-share" | "quick-join",
        excludeSelf?: boolean,
      ) => {
        if (!groupShortcutManager) {
          return { valid: false, error: "Shortcut manager not available" };
        }
        return groupShortcutManager.validate(shortcut, groupId, action, excludeSelf);
      },
    );
  }

  // ── Quality presets ────────────────────────────────────────────────────────

  if (presetStore) {
    ipcMain.handle("list-quality-presets", () => presetStore.list());
    ipcMain.handle("get-quality-preset", (_event, id: string) => presetStore.get(id));
    ipcMain.handle(
      "create-quality-preset",
      (_event, input: { name: string; settings: import("@screenlink/shared").QualityPreset["settings"]; showInViewerPanel?: boolean; viewerPanelSlot?: number | null }) => {
        return presetStore.create({ name: input.name, settings: input.settings, showInViewerPanel: input.showInViewerPanel, viewerPanelSlot: input.viewerPanelSlot });
      },
    );
    ipcMain.handle(
      "update-quality-preset",
      (_event, id: string, input: { name?: string; settings?: import("@screenlink/shared").QualityPreset["settings"]; showInViewerPanel?: boolean; viewerPanelSlot?: number | null }) => {
        return presetStore.update(id, { name: input.name, settings: input.settings, showInViewerPanel: input.showInViewerPanel, viewerPanelSlot: input.viewerPanelSlot });
      },
    );
    ipcMain.handle("duplicate-quality-preset", (_event, id: string, newName: string) =>
      presetStore.duplicate(id, newName),
    );
    ipcMain.handle("delete-quality-preset", (_event, id: string) =>
      presetStore.delete(id),
    );
    ipcMain.handle("export-quality-preset", async (_event, id: string) =>
      presetStore.export(id),
    );
    ipcMain.handle("import-quality-preset", async (_event, exportString: string) =>
      presetStore.import(exportString),
    );
  }

  // ── Quick Share config ──────────────────────────────────────────────────

  ipcMain.handle("get-quick-share-config", () => {
    const s = settings.get();
    return {
      shortcutEnabled: s.quickShareShortcutEnabled ?? false,
      shortcutAccelerator: s.quickShareShortcutAccelerator ?? "Super+Alt+S",
      lastGroupId: s.lastQuickShareGroupId ?? null,
      lastSourceKind: s.lastQuickShareSourceKind ?? null,
      lastPresetId: s.lastQuickSharePresetId ?? null,
    };
  });

  ipcMain.handle(
    "update-quick-share-config",
    (_event, partial: Record<string, unknown>) => {
      const mapped: Partial<Record<string, unknown>> = {};
      if ("shortcutEnabled" in partial) mapped.quickShareShortcutEnabled = partial.shortcutEnabled;
      if ("shortcutAccelerator" in partial) {
        // Normalise "Win" → "Super" before persisting so the stored value
        // is always a valid Electron accelerator.
        mapped.quickShareShortcutAccelerator = String(partial.shortcutAccelerator).replace(/\bWin\b/g, "Super");
      }
      if ("lastGroupId" in partial) mapped.lastQuickShareGroupId = partial.lastGroupId;
      if ("lastSourceKind" in partial) mapped.lastQuickShareSourceKind = partial.lastSourceKind;
      if ("lastPresetId" in partial) mapped.lastQuickSharePresetId = partial.lastPresetId;
      settings.update(mapped as never);
      const next = settings.get();
      onQuickShareConfigUpdated?.(
        next.quickShareShortcutEnabled ?? true,
        next.quickShareShortcutAccelerator ?? "Super+Alt+S",
      );
    },
  );

  // ── Application info ─────────────────────────────────────────────────────

  ipcMain.handle("get-app-info", () => {
    return {
      version: app.getVersion(),
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      nodeVersion: process.versions.node,
    };
  });

  // ── NVIDIA RTX VSR capability ────────────────────────────────────────────

  ipcMain.handle("nvidia:probe-capability", async () => {
    return await probeNvidiaVsrCapability();
  });

  // ── Audio capabilities ────────────────────────────────────────────────────

  ipcMain.handle("get-audio-capabilities", async () => {
    return getAudioCapabilities();
  });

  // ── Audio pipeline ─────────────────────────────────────────────────────

  ipcMain.handle("ensure-audio-helper", async () => {
    try {
      await ensureAudioHelper();
      return { success: true };
    } catch (err) {
      console.error("[IPC] ensure-audio-helper failed:", err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle("request-audio-port", async (event) => {
    try {
      const helper = await ensureAudioHelper();
      helper.attachPcmToWebContents(event.sender);
      return { success: true };
    } catch (err) {
      console.error("[IPC] request-audio-port failed:", err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle("get-audio-state", () => {
    return currentAudioState ?? "disabled";
  });

  ipcMain.handle("start-synthetic-audio", async (_event, mode?: number) => {
    try {
      const helper = await ensureAudioHelper();
      await helper.startSyntheticCapture({ mode: mode ?? 0 });
      setCurrentAudioState("active");
      return { success: true };
    } catch (err) {
      console.error("[IPC] start-synthetic-audio failed:", err);
      setCurrentAudioState("error");
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle("stop-audio", async () => {
    try {
      setCurrentAudioState("stopping");
      if (currentAudioHelper) {
        await currentAudioHelper.shutdown();
        setCurrentAudioHelper(null);
      }
      setCurrentAudioState("disabled");
      return { success: true };
    } catch (err) {
      console.error("[IPC] stop-audio failed:", err);
      setCurrentAudioState("error");
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('enumerate-audio-sessions', async () => {
    if (!currentAudioHelper) {
      return { success: false, error: 'no-audio-helper' };
    }
    try {
      return await currentAudioHelper.enumerateAudioSessions();
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('start-application-audio', async (_event, options: {
    sourceId: string;
  }) => {
    if (!currentAudioHelper) return { success: false, error: 'no-audio-helper' };
    try {
      const src = await currentAudioHelper.resolveSource(options.sourceId);
      if (!src.found) return { success: false, error: `Source not found: ${src.error}` };

      const targetPid = Number(src.source.capturePid ?? src.source.pid);
      const expectedCreationTimeUtc100ns = String(
        src.source.captureCreationTimeUtc100ns ??
        src.source.processCreationTimeUtc100ns ??
        '',
      );

      if (!Number.isSafeInteger(targetPid) || targetPid <= 0) {
        return { success: false, error: 'invalid-resolved-capture-pid' };
      }
      if (!/^[1-9]\d*$/.test(expectedCreationTimeUtc100ns)) {
        return { success: false, error: 'invalid-resolved-capture-creation-time' };
      }

      const { streamGeneration } = await currentAudioHelper.startApplicationCapture({
        targetPid,
        expectedCreationTimeUtc100ns,
      });
      setCurrentAudioState('active');
      return { success: true, streamGeneration };
    } catch (err) {
      setCurrentAudioState('error');
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('start-filtered-monitor-audio', async (_event, options: {
    excludeDiscord?: boolean;
    excludeScreenLink?: boolean;
  }) => {
    if (!currentAudioHelper) {
      return { success: false, error: 'no-audio-helper' };
    }
    try {
      const result = await currentAudioHelper.startFilteredMonitorCapture(options);
      setCurrentAudioState('active');
      return { success: true, streamGeneration: result.streamGeneration };
    } catch (err) {
      setCurrentAudioState('error');
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle("start-system-audio", async () => {
    try {
      const helper = await ensureAudioHelper();
      const streamGen = await helper.startEndpointLoopback();
      setCurrentAudioState('active');
      return { success: true, streamGeneration: streamGen };
    } catch (err) {
      console.error("[IPC] start-system-audio failed:", err);
      setCurrentAudioState('error');
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('get-mixer-state', async () => {
    if (!currentAudioHelper) {
      return { state: 'stopped', activeSources: 0 };
    }
    try {
      return await currentAudioHelper.getMixerState();
    } catch {
      return { state: 'error', activeSources: 0 };
    }
  });

  ipcMain.handle('get-mixer-diagnostics', async () => {
    if (!currentAudioHelper) {
      return { success: false, error: 'no-audio-helper' };
    }
    try {
      return await currentAudioHelper.getMixerDiagnostics();
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('get-pipeline-snapshot', async () => {
    if (!currentAudioHelper) {
      return { success: false, error: 'no-audio-helper' };
    }
    try {
      return await currentAudioHelper.getPipelineSnapshot();
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── Video helper client leases (Phase 5/6) ────────────────────────────────────

  ipcMain.handle("video-helper:acquire-client", async () => {
    const manager = ensureVideoHelperManager();
    const clientId = manager.acquireClient();
    return { clientId };
  });

  ipcMain.handle("video-helper:release-client", async (_event, clientId: string) => {
    const manager = ensureVideoHelperManager();
    manager.releaseClient(clientId);
    return { success: true };
  });

  ipcMain.handle("video-helper:is-client-active", async (_event, clientId: string) => {
    const mgr = videoHelperManager;
    return mgr ? mgr.isClientActive(clientId) : false;
  });

  // ── Video helper (Phase 5: MessagePort frame IPC) ─────────────────────────────

  ipcMain.handle("request-frame-port", async (event) => {
    const manager = ensureVideoHelperManager();
    // Legacy path: acquire an anonymous client for backward compatibility
    const clientId = manager.acquireClient();
    const port = manager.createFramePort(clientId);
    if (!port) {
      // Release acquired client on failure
      manager.releaseClient(clientId);
      return { success: false, error: "Failed to create frame port" };
    }
    // Self-cleaning: when port closes (renderer releases or navigates away),
    // release the anonymous client lease to prevent leaks.
    port.on("close", () => {
      manager.releaseClient(clientId);
    });
    event.sender.postMessage("frame:port", null, [port]);
    return { success: true, clientId };
  });

  ipcMain.handle("video-helper:request-frame-port", async (event, clientId: string) => {
    const manager = ensureVideoHelperManager();
    const port = manager.createFramePort(clientId);
    if (!port) {
      return { success: false, error: "Invalid or inactive client" };
    }
    event.sender.postMessage("frame:port", null, [port]);
    return { success: true };
  });

  // ── Slice 5: Renderer-owned shared input slots ─────────────────────────────────

  ipcMain.handle("video-helper:register-renderer-slots", async (_event, slots: SharedArrayBuffer[]) => {
    const manager = ensureVideoHelperManager();
    // Validate: must be exactly 3 slots
    if (!Array.isArray(slots) || slots.length !== 3) {
      return { success: false, error: "Expected exactly 3 SharedArrayBuffer slots" };
    }
    for (let i = 0; i < slots.length; i++) {
      if (!(slots[i] instanceof SharedArrayBuffer)) {
        return { success: false, error: `Slot ${i} is not a SharedArrayBuffer` };
      }
    }
    manager.registerRendererSlots(slots);
    return { success: true };
  });

  ipcMain.handle("video-helper:release-renderer-slots", async () => {
    const mgr = videoHelperManager;
    if (mgr) mgr.releaseRendererSlots();
    return { success: true };
  });

  // ── Video helper ──────────────────────────────────────────────────────────────

  ipcMain.handle("video-helper:start", async (_event, config: VideoEnhancerConfig) => {
    const manager = ensureVideoHelperManager();
    return await manager.start(config);
  });

  ipcMain.handle("video-helper:get-applied-config", async () => {
    const mgr = videoHelperManager;
    return mgr?.getAppliedConfig() ?? null;
  });

  ipcMain.handle("video-helper:stop", async (_event, shutdown?: boolean) => {
    const manager = ensureVideoHelperManager();
    await manager.stop(shutdown ?? false);
  });

  ipcMain.handle("video-helper:reconfigure", async (_event, config: VideoEnhancerConfig) => {
    const manager = ensureVideoHelperManager();
    return await manager.reconfigure(config);
  });

  ipcMain.handle("video-helper:submit-frame", async (_event, generation: number, frameSequence: number, frameData: Buffer | Uint8Array, inputWidth: number, inputHeight: number) => {
    const manager = ensureVideoHelperManager();
    const buffer = frameData instanceof Uint8Array ? frameData : Buffer.from(frameData);
    return await manager.submitFrame(generation, frameSequence, buffer, inputWidth, inputHeight);
  });

  ipcMain.handle("video-helper:flush", async () => {
    const manager = ensureVideoHelperManager();
    return await manager.flush();
  });

  ipcMain.handle("video-helper:get-state", async () => {
    const mgr = videoHelperManager;
    return mgr ? mgr.getState() : "disconnected";
  });

  // ── Video helper typed diagnostics ──────────────────────────────────────

  ipcMain.handle("video-helper:get-diagnostics", async () => {
    const mgr = videoHelperManager;
    if (!mgr) return null;
    return await mgr.getDiagnostics();
  });

  // ── Native presenter IPC ──────────────────────────────────────────────────

  ipcMain.handle("video-helper:attach-presenter", async (_event, width: number, height: number) => {
    const manager = ensureVideoHelperManager();
    return { success: await manager.attachPresenter(window, width, height) };
  });

  ipcMain.handle("video-helper:detach-presenter", async () => {
    const manager = ensureVideoHelperManager();
    return { success: await manager.detachPresenter() };
  });

  ipcMain.handle(
    "video-helper:update-presenter-bounds",
    async (_event, x: number, y: number, width: number, height: number) => {
      const manager = ensureVideoHelperManager();
      return { success: await manager.updatePresenterBounds(x, y, width, height) };
    },
  );

  ipcMain.handle("video-helper:set-presenter-visible", async (_event, visible: boolean) => {
    const manager = ensureVideoHelperManager();
    return { success: await manager.setPresenterVisible(visible) };
  });

  ipcMain.handle("video-helper:get-presenter-diagnostics", async () => {
    const mgr = videoHelperManager;
    if (!mgr) return { success: false, error: "no-helper" };
    return { success: true, diagnostics: await mgr.getPresenterDiagnostics() };
  });

  // ── NVIDIA benchmark operations ─────────────────────────────────────────

  /**
   * Open the userData benchmark results folder in the OS file manager.
   */
  ipcMain.handle("nvidia:open-benchmark-folder", async () => {
    const benchmarkDir = path.join(app.getPath("userData"), "nvidia-benchmarks");
    try {
      await fs.mkdir(benchmarkDir, { recursive: true });
      await shell.openPath(benchmarkDir);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle("nvidia:save-benchmark-result", async (_event, record: unknown) => {
    const benchmarkDir = path.join(app.getPath("userData"), "nvidia-benchmarks");
    try {
      await fs.mkdir(benchmarkDir, { recursive: true });
      const resultsFile = path.join(benchmarkDir, "results.json");
      let results: Record<string, unknown>[] = [];
      try {
        const raw = await fs.readFile(resultsFile, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          results = parsed as Record<string, unknown>[];
        }
      } catch {
        // no existing file
      }

      const normalized = (record && typeof record === "object"
        ? { ...(record as Record<string, unknown>) }
        : {}) as Record<string, unknown>;
      const id = typeof normalized.id === "string" && normalized.id
        ? normalized.id
        : randomUUID();
      normalized.id = id;

      const existingIndex = results.findIndex((entry) => entry.id === id);
      if (existingIndex >= 0) {
        results[existingIndex] = normalized;
      } else {
        results.push(normalized);
      }

      await fs.writeFile(resultsFile, JSON.stringify(results, null, 2), "utf-8");
      return { success: true, id };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to save benchmark result",
      };
    }
  });

  /**
   * Export a benchmark result to a JSON file in the benchmark folder.
   * Returns the file path on success, null on failure.
   */
  ipcMain.handle("nvidia:export-benchmark-result", async (_event, resultId: string) => {
    if (typeof resultId !== "string" || !resultId) return null;
    const benchmarkDir = path.join(app.getPath("userData"), "nvidia-benchmarks");
    try {
      await fs.mkdir(benchmarkDir, { recursive: true });
      const resultsFile = path.join(benchmarkDir, "results.json");
      // Read existing results, find the one with matching id, export it
      let results: unknown[] = [];
      try {
        const raw = await fs.readFile(resultsFile, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) results = parsed;
      } catch { /* file doesn't exist yet */ }
      const record = results.find((r: unknown) => {
        const obj = r as Record<string, unknown>;
        return obj.id === resultId;
      });
      if (!record) return null;
      const exportPath = path.join(benchmarkDir, `benchmark-${resultId}.json`);
      await fs.writeFile(exportPath, JSON.stringify(record, null, 2), "utf-8");
      return exportPath;
    } catch {
      return null;
    }
  });

  /**
   * Return all stored benchmark results.
   */
  ipcMain.handle("nvidia:get-benchmark-results", async () => {
    const benchmarkDir = path.join(app.getPath("userData"), "nvidia-benchmarks");
    try {
      const resultsFile = path.join(benchmarkDir, "results.json");
      const raw = await fs.readFile(resultsFile, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  /**
   * Start a native benchmark run.
   * Forwards config to the native helper via the video helper manager.
   */
  ipcMain.handle("nvidia:run-benchmark", async (_event, config: import("./video-enhancer-protocol.js").NativeBenchmarkConfig) => {
    const manager = ensureVideoHelperManager();
    return await manager.runBenchmark(config);
  });

  /**
   * Get current benchmark status from the native helper.
   */
  ipcMain.handle("nvidia:get-benchmark-status", async () => {
    const mgr = videoHelperManager;
    if (!mgr) return null;
    return await mgr.getBenchmarkStatus();
  });

  /**
   * Cancel a running benchmark.
   */
  ipcMain.handle("nvidia:cancel-benchmark", async () => {
    const mgr = videoHelperManager;
    if (!mgr) return false;
    return await mgr.cancelBenchmark();
  });

  /**
   * Get aggregated benchmark results after a completed run.
   */
  ipcMain.handle("nvidia:get-benchmark-results-aggregate", async () => {
    const mgr = videoHelperManager;
    if (!mgr) return null;
    return await mgr.getBenchmarkResults();
  });

  // ── Tray state updates ──────────────────────────────────────────────────

  ipcMain.on("tray-set-sharing", (_event, sharing: boolean) => {
    trayManager.setSharing(sharing);
    if (sharing) trayManager.setState("sharing");
    else trayManager.setState("idle");
  });

  ipcMain.on("tray-set-viewing", (_event, viewing: boolean) => {
    trayManager.setViewing(viewing);
    if (viewing) trayManager.setState("viewing");
    else trayManager.setState("idle");
  });

  ipcMain.on("tray-set-viewer-count", (_event, count: number) => {
    trayManager.setViewerCount(count);
  });


  // ── Stream history ────────────────────────────────────────────────────────

  const STREAM_HISTORY_FILE = "stream-history.json";

  /**
   * Read stream history, performing crash recovery on active records.
   * Any record with status "active" is converted to "interrupted" on read,
   * and the corrected file is written back atomically.
   */
  ipcMain.handle("get-stream-history", async () => {
    const filePath = path.join(app.getPath("userData"), STREAM_HISTORY_FILE);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      const records: any[] = Array.isArray(parsed.records) ? parsed.records : [];

      // Crash recovery: convert any active records to interrupted
      let changed = false;
      for (const r of records) {
        if (r && typeof r === "object" && r.status === "active") {
          r.status = "interrupted";
          r.interrupted = true;
          r.stoppedAt = r.lastCheckpointAt ?? r.stoppedAt ?? Date.now();
          r.durationMs = (r.stoppedAt) - (r.startedAt ?? r.stoppedAt);
          changed = true;
        }
      }

      // Write back if changed (atomic write with temp file)
      if (changed && records.length > 0) {
        const data = JSON.stringify({ schemaVersion: 2, records }, null, 2);
        const tmpPath = filePath + ".tmp";
        try {
          await fs.writeFile(tmpPath, data, "utf-8");
          const backupPath = filePath + ".bak";
          try { await fs.copyFile(filePath, backupPath); } catch { }
          await fs.rename(tmpPath, filePath);
        } catch (writeErr) {
          console.error("Failed to write recovered history:", writeErr);
        }
      }

      return records;
    } catch {
      return [];
    }
  });

  ipcMain.handle("save-stream-history", async (_event, records: unknown[]) => {
    const filePath = path.join(app.getPath("userData"), STREAM_HISTORY_FILE);
    const data = JSON.stringify({ schemaVersion: 2, records }, null, 2);
    try {
      const tmpPath = filePath + ".tmp";
      await fs.writeFile(tmpPath, data, "utf-8");
      const backupPath = filePath + ".bak";
      try { await fs.copyFile(filePath, backupPath); } catch { }
      await fs.rename(tmpPath, filePath);
    } catch {
      await fs.writeFile(filePath, data, "utf-8");
    }
  });

  /**
   * Upsert a single stream history record by historyId.
   * Replaces if exists, appends if new. Deduplicates as safety net.
   * Atomic write via temp + rename.
   */
  ipcMain.handle("upsert-stream-history", async (_event, record: unknown) => {
    const filePath = path.join(app.getPath("userData"), STREAM_HISTORY_FILE);
    try {
      let records: any[] = [];
      try {
        const raw = await fs.readFile(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.records)) records = parsed.records;
      } catch {
        // file doesn't exist yet — start fresh
      }

      // Validate record has historyId
      if (!record || typeof record !== "object" || !("historyId" in (record as any))) return;

      // Find and replace, or append
      const idx = records.findIndex(r => r && typeof r === "object" && r.historyId === (record as any).historyId);
      if (idx >= 0) records[idx] = record;
      else records.push(record);

      // Deduplicate by historyId (safety net)
      const seen = new Set<string>();
      records = records.filter(r => {
        if (!r || typeof r !== "object") return false;
        const id = r.historyId;
        if (!id || typeof id !== "string" || seen.has(id)) return false;
        seen.add(id);
        return true;
      });

      const data = JSON.stringify({ schemaVersion: 2, records }, null, 2);
      const tmpPath = filePath + ".tmp";
      await fs.writeFile(tmpPath, data, "utf-8");
      try { await fs.copyFile(filePath, filePath + ".bak"); } catch { }
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      console.error("Failed to upsert stream history:", err);
    }
  });

  /**
   * Delete a single stream history record by historyId.
   * Atomic write via temp + rename.
   */
  ipcMain.handle("delete-stream-history", async (_event, historyId: string) => {
    const filePath = path.join(app.getPath("userData"), STREAM_HISTORY_FILE);
    try {
      let records: any[] = [];
      try {
        const raw = await fs.readFile(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.records)) records = parsed.records;
      } catch {
        return; // no file, nothing to delete
      }

      const filtered = records.filter(r => {
        if (!r || typeof r !== "object") return false;
        return r.historyId !== historyId;
      });

      // Only write if something was actually removed
      if (filtered.length !== records.length) {
        const data = JSON.stringify({ schemaVersion: 2, records: filtered }, null, 2);
        const tmpPath = filePath + ".tmp";
        await fs.writeFile(tmpPath, data, "utf-8");
        try { await fs.copyFile(filePath, filePath + ".bak"); } catch { }
        await fs.rename(tmpPath, filePath);
      }
    } catch (err) {
      console.error("Failed to delete stream history:", err);
    }
  });

    ipcMain.on("tray-select-preset", (_event, presetId: string) => {
    window.webContents.send("select-preset", presetId);
  });

  // ── Shortcut simulation (Discord mute/deafen) ──────────────────────────────

  ipcMain.handle("send-shortcut", async (_event, binding: ShortcutBinding) => {
    try {
      return await sendShortcutWithFallback(binding, {
        currentHelper: currentAudioHelper,
        ensureHelper: ensureAudioHelper,
        directSend: sendShortcutViaPowerShellSendInput,
      });
    } catch (err) {
      console.error("[IPC] send-shortcut failed:", err);
      return { success: false, error: String(err) };
    }
  });

  // ── Fullscreen (native Electron) ──────────────────────────────────────────

  ipcMain.handle("toggle-fullscreen", () => {
    const newState = !window.isFullScreen();
    window.setFullScreen(newState);
    return newState;
  });

  window.on("enter-full-screen", () => {
    window.webContents.send("fullscreen-state-changed", true);
  });
  window.on("leave-full-screen", () => {
    window.webContents.send("fullscreen-state-changed", false);
  });
}

