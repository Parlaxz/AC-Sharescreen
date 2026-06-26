import { ipcMain, app, BrowserWindow, clipboard } from "electron";
import { enumerateSources, getSourceFingerprint } from "./capture-source-manager.js";
import { setApprovedSource } from "./display-media-handler.js";
import { getAudioCapabilities, getHelperPath } from "./audio-capability-service.js";
import { AudioHelperManager } from "./AudioHelperManager.js";
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

export function registerIpcHandlers(
  window: BrowserWindow,
  settings: SettingsStore,
  secureStore: SecureStore,
  trayManager: TrayManager,
  groupStore?: GroupStore,
  presetStore?: QualityPresetStore,
  onQuickShareConfigUpdated?: (enabled: boolean, accelerator: string) => void,
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
      groupStore.leave(groupId);
    });

    ipcMain.handle("get-group-connection-config", (_event, groupId: string) => {
      const identity = settings.get().deviceIdentity;
      return groupStore.getConnectionConfig(groupId, identity.deviceId);
    });
  }

  // ── Quality presets ─────────────────────────────────────────────────────

  if (presetStore) {
    ipcMain.handle("list-quality-presets", () => presetStore.list());
    ipcMain.handle("get-quality-preset", (_event, id: string) => presetStore.get(id));
    ipcMain.handle(
      "create-quality-preset",
      (_event, input: { name: string; settings: import("@screenlink/shared").QualityPreset["settings"] }) => {
        return presetStore.create({ name: input.name, settings: input.settings });
      },
    );
    ipcMain.handle(
      "update-quality-preset",
      (_event, id: string, input: { name?: string; settings?: import("@screenlink/shared").QualityPreset["settings"] }) => {
        return presetStore.update(id, { name: input.name, settings: input.settings });
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
      shortcutAccelerator: s.quickShareShortcutAccelerator ?? "Alt+Shift+S",
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
      if ("shortcutAccelerator" in partial) mapped.quickShareShortcutAccelerator = partial.shortcutAccelerator;
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

  ipcMain.on("tray-select-preset", (_event, presetId: string) => {
    window.webContents.send("select-preset", presetId);
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
