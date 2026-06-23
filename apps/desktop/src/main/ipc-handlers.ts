import { ipcMain, app, BrowserWindow } from "electron";
import { enumerateSources, getSourceFingerprint } from "./capture-source-manager.js";
import { setApprovedSource } from "./display-media-handler.js";
import { getAudioCapabilities, getHelperPath } from "./audio-capability-service.js";
import { AudioHelperManager } from "./AudioHelperManager.js";
import { generateVdoStreamId, generateVdoPassword } from "@screenlink/shared";
import type { SettingsStore } from "./settings-store.js";
import type { SecureStore } from "./secure-store.js";
import type { TrayManager } from "./tray-manager.js";


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

/**
 * Register all IPC handlers that bridge renderer requests to main process
 * capabilities.
 */
export function registerIpcHandlers(
  window: BrowserWindow,
  settings: SettingsStore,
  secureStore: SecureStore,
  trayManager: TrayManager,
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

  ipcMain.handle("set-source", async (_event, sourceId: string) => {
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
      settings.update(partial);
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

  // ── Pairing ─────────────────────────────────────────────────────

  ipcMain.handle("safe-storage-available", () => {
    return secureStore.isEncryptionAvailable();
  });

  ipcMain.handle("create-pairing", async (_event, displayName: string) => {
    const {
      generatePairId,
      generatePairSecret,
      generateDeviceId,
      createCreatorConfig,
    } = await import("@screenlink/shared");
    const pairId = generatePairId();
    const pairSecret = generatePairSecret();
    const deviceId = generateDeviceId();
    const name = displayName || "ScreenLink User";

    // Encrypt pair secret for storage
    const encrypted = secureStore.encrypt(pairSecret);
    if (!encrypted) {
      throw new Error("Secure storage unavailable — cannot store pair secret");
    }

    const result = createCreatorConfig({
      pairId,
      pairSecret,
      localDeviceId: deviceId,
      localDisplayName: name,
    });

    // Persist to settings with lifecycle
    settings.update({
      pairingConfig: JSON.stringify(result.config),
      encryptedPairSecret: encrypted.toString("base64"),
    } as Record<string, unknown>);

    return {
      pairingCode: result.pairingLink,
      pairingLink: result.pairingLink,
      pairId,
      deviceId,
      displayName: name,
      exportData: result.exportData as unknown as Record<string, unknown>,
    };
  });

  ipcMain.handle("get-pairing-link", () => {
    const s = settings.get();
    const raw = (s as unknown as Record<string, unknown>).pairingConfig;
    if (typeof raw !== "string") return null;
    try {
      const config = JSON.parse(raw);
      if ((config as Record<string, unknown>).pendingPairingLink) {
        return (config as Record<string, unknown>).pendingPairingLink as string;
      }
      // If no pending link stored, try to reconstruct from stored export data
      // (fallback for legacy configs)
      return null;
    } catch {
      return null;
    }
  });

  ipcMain.handle("import-pairing", async (_event, pairingCode: string) => {
    const {
      parsePairingCode,
      generateDeviceId,
      createImporterConfig,
      getImporterDisplayName,
    } = await import("@screenlink/shared");
    const exportData = parsePairingCode(pairingCode);
    if (!exportData) {
      throw new Error("Invalid pairing code format");
    }

    const localDeviceId = generateDeviceId();

    // Use the current saved display name (with dev profile defaults) instead
    // of hardcoding "ScreenLink User"
    const currentSavedName = settings.get().hostDisplayName;
    const devProfile = (process.argv as string[]).includes("--dev-profile")
      ? ((): string | undefined => {
          const idx = (process.argv as string[]).indexOf("--dev-profile");
          return idx !== -1 && idx + 1 < (process.argv as string[]).length
            ? (process.argv as string[])[idx + 1]
            : undefined;
        })()
      : undefined;
    const localDisplayName = getImporterDisplayName(currentSavedName, devProfile);

    const config = createImporterConfig({
      exportData,
      localDeviceId,
      localDisplayName,
    });

    // Encrypt the shared pair secret
    const encrypted = secureStore.encrypt(exportData.pairSecret);
    if (!encrypted) {
      throw new Error("Secure storage unavailable — cannot store pair secret");
    }

    settings.update({
      pairingConfig: JSON.stringify(config),
      encryptedPairSecret: encrypted.toString("base64"),
    } as Record<string, unknown>);

    return { deviceId: localDeviceId, remoteName: exportData.creatorDisplayName };
  });

  ipcMain.handle("get-pairing-config", () => {
    const s = settings.get();
    const raw = (s as unknown as Record<string, unknown>).pairingConfig;
    if (typeof raw !== "string") return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });

  ipcMain.handle("get-pair-secret", () => {
    const s = settings.get();
    const encryptedB64 = (s as unknown as Record<string, unknown>).encryptedPairSecret;
    if (typeof encryptedB64 !== "string") return null;
    const buf = Buffer.from(encryptedB64, "base64");
    return secureStore.decrypt(buf);
  });

  ipcMain.handle("update-pairing-config", (_event, partial: Record<string, unknown>) => {
    const s = settings.get();
    const raw = (s as unknown as Record<string, unknown>).pairingConfig;
    if (typeof raw !== "string") return;
    const config = JSON.parse(raw);
    Object.assign(config, partial);
    settings.update({ pairingConfig: JSON.stringify(config) } as Record<string, unknown>);
  });

  ipcMain.handle("update-remote-identity", async (_event, remoteDeviceId: string, remoteDisplayName: string) => {
    try {
      const { applyPeerHello } = await import("@screenlink/shared");
      const s = settings.get();
      const raw = (s as unknown as Record<string, unknown>).pairingConfig;
      if (typeof raw !== "string") return { accepted: false, reason: "No pairing config" };
      const config = JSON.parse(raw);
      const result = applyPeerHello(config, remoteDeviceId, remoteDisplayName);
      if (result.accepted && result.config) {
        settings.update({ pairingConfig: JSON.stringify(result.config) } as Record<string, unknown>);
        // Return authoritative result so caller can observe the transition
        return {
          accepted: true,
          pairingLifecycle: result.config.pairingLifecycle,
          remoteDeviceId: result.config.remoteDeviceId,
          remoteDisplayName: result.config.remoteDisplayName,
        };
      }
      console.warn("[IPC] update-remote-identity rejected:", result.reason);
      return { accepted: false, reason: result.reason };
    } catch (err) {
      return { accepted: false, reason: String(err) };
    }
  });

  ipcMain.handle("clear-pairing", () => {
    settings.clearPairing();
  });

  /** Persist a lifecycle transition (e.g. PAIRED_ONLINE → PAIRED_OFFLINE). */
  ipcMain.handle("set-pairing-lifecycle", (_event, lifecycle: string) => {
    const s = settings.get();
    const raw = (s as unknown as Record<string, unknown>).pairingConfig;
    if (typeof raw !== "string") return;
    try {
      const config = JSON.parse(raw);
      config.pairingLifecycle = lifecycle;
      settings.update({ pairingConfig: JSON.stringify(config) } as Record<string, unknown>);
    } catch {
      // ignore parse errors
    }
  });

  ipcMain.handle("export-current-pairing", () => {
    const s = settings.get();
    const raw = (s as unknown as Record<string, unknown>).pairingConfig;
    const encryptedB64 = (s as unknown as Record<string, unknown>).encryptedPairSecret;
    if (typeof raw !== "string" || typeof encryptedB64 !== "string") return null;
    try {
      const config = JSON.parse(raw);
      const buf = Buffer.from(encryptedB64, "base64");
      const pairSecret = secureStore.decrypt(buf);
      if (!pairSecret) return null;
      const exportData = {
        version: 1 as const,
        pairId: config.pairId as string,
        pairSecret,
        creatorDeviceId: config.localDeviceId as string,
        creatorDisplayName: config.localDisplayName as string,
      };
      return exportData;
    } catch {
      return null;
    }
  });

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

  // ── Phase 2E: Audio sessions ───────────────────────────────────────────

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
    sourceId: string;  // desktopCapturer source ID like "window:0x1234"
  }) => {
    if (!currentAudioHelper) {
      return { success: false, error: 'no-audio-helper' };
    }
    try {
      // Step 1: Resolve the source through the native helper
      const resolveResult = await currentAudioHelper.resolveSource(options.sourceId);
      if (!resolveResult.found) {
        return { success: false, error: `Source not found: ${resolveResult.error}` };
      }

      // Step 2: Start application capture with validated source identity
      return await currentAudioHelper.startApplicationCapture({
        targetPid: resolveResult.source.pid,
        expectedCreationTimeUtc100ns: resolveResult.source.processCreationTimeUtc100ns,
      });
    } catch (err) {
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
      return await currentAudioHelper.startFilteredMonitorCapture(options);
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle("start-system-audio", async () => {
    try {
      const helper = await ensureAudioHelper();
      const streamGen = await helper.startEndpointLoopback();
      return { success: true, streamGeneration: streamGen };
    } catch (err) {
      console.error("[IPC] start-system-audio failed:", err);
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

  ipcMain.on("tray-set-friend-name", (_event, name: string) => {
    trayManager.setFriendName(name);
  });

  ipcMain.on("tray-set-friend-sharing", (_event, sharing: boolean) => {
    trayManager.setFriendSharing(sharing);
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

  // Forward native fullscreen changes to the renderer so it can update state
  window.on("enter-full-screen", () => {
    window.webContents.send("fullscreen-state-changed", true);
  });
  window.on("leave-full-screen", () => {
    window.webContents.send("fullscreen-state-changed", false);
  });
}
