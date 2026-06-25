// @ts-nocheck — Legacy file, replaced by SettingsPage.tsx (Stage 3.7G)
import { useEffect, useState, useCallback, useRef } from "react";
import { useStore, type Page } from "../stores/main-store.js";
import type { PersistedSettings, UpdateStatusDTO } from "../../preload/api-types.js";
import { getRuntime } from "../services/phase3-runtime.js";

async function getApi() {
  return (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
}

// ─── Byte formatting utility ───────────────────────────────────────────────

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes === null || bytes < 0) return "0 B";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatSpeed(bytesPerSecond: number | undefined): string {
  if (!bytesPerSecond || bytesPerSecond < 0) return "";
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatTime(timestamp: number | undefined): string {
  if (!timestamp) return "";
  const d = new Date(timestamp);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

// ─── Initial update status for SSR / loading ───────────────────────────────

const INITIAL_UPDATE_STATUS: UpdateStatusDTO = {
  phase: "idle",
  currentVersion: "",
  userMessage: "Loading...",
  isPackaged: false,
  isPortable: false,
  updaterSupported: false,
};

// ─── UpdateSection component ───────────────────────────────────────────────

function UpdateSection() {
  const [status, setStatus] = useState<UpdateStatusDTO>(INITIAL_UPDATE_STATUS);
  const [loading, setLoading] = useState(true);
  const [actionInProgress, setActionInProgress] = useState(false);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Subscribe to status updates and load initial status
  useEffect(() => {
    let mounted = true;

    (async () => {
      const api = await getApi();
      if (!api) return;

      // Get initial status
      try {
        const initialStatus = await api.getUpdateStatus();
        if (mounted) {
          setStatus(initialStatus);
          setLoading(false);
        }
      } catch {
        if (mounted) setLoading(false);
      }

      // Subscribe to ongoing status changes
      const unsubscribe = api.onUpdateStatusChanged((newStatus) => {
        if (mounted) {
          setStatus(newStatus);
          setActionInProgress(false);
        }
      });
      unsubscribeRef.current = unsubscribe;
    })();

    return () => {
      mounted = false;
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, []);

  const handleCheck = useCallback(async () => {
    setActionInProgress(true);
    const api = await getApi();
    if (!api) return;
    try {
      const newStatus = await api.checkForUpdates();
      setStatus(newStatus);
    } catch {
      // Status update from event handler will handle this
    } finally {
      setActionInProgress(false);
    }
  }, []);

  const handleDownload = useCallback(async () => {
    setActionInProgress(true);
    const api = await getApi();
    if (!api) return;
    try {
      const newStatus = await api.downloadUpdate();
      setStatus(newStatus);
    } catch {
      // Status update from event handler will handle this
    } finally {
      setActionInProgress(false);
    }
  }, []);

  const handleInstall = useCallback(async () => {
    setActionInProgress(true);
    const api = await getApi();
    if (!api) return;
    try {
      const newStatus = await api.restartAndInstallUpdate();
      setStatus(newStatus);
    } catch {
      // Status update from event handler will handle this
    } finally {
      setActionInProgress(false);
    }
  }, []);

  if (loading) {
    return (
      <div className="card">
        <h3>Updates</h3>
        <p className="dim">Loading update status...</p>
      </div>
    );
  }

  const showProgress = status.phase === "downloading" && status.downloadPercent !== undefined;
  const canCheck = status.phase === "idle" || status.phase === "up-to-date" || status.phase === "error" || status.phase === "update-available";
  const canDownload = status.phase === "update-available";
  const canInstall = status.phase === "downloaded";
  const isChecking = status.phase === "checking";
  const isInstalling = status.phase === "installing";
  const isUnsupported = status.phase === "unsupported";
  const showTryAgain = status.phase === "error";
  const showCheckAgain = status.phase === "up-to-date";

  return (
    <div className="card">
      <h3>Updates</h3>

      {/* Current version */}
      <p className="dim" style={{ marginBottom: "0.75rem" }}>
        Version: <strong>{status.currentVersion || "Unknown"}</strong>
        {status.isPortable && <span style={{ marginLeft: "0.5rem", color: "var(--warning)" }}>Portable</span>}
      </p>

      {/* Unsupported: development build */}
      {isUnsupported && !status.isPortable && status.userMessage && (
        <p className="dim">{status.userMessage}</p>
      )}

      {/* Unsupported: portable build */}
      {isUnsupported && status.isPortable && (
        <div>
          <p className="dim" style={{ color: "var(--warning)" }}>
            Portable version cannot self-update. Download the ScreenLink Setup installer to receive automatic updates.
          </p>
          <p className="dim" style={{ marginTop: "0.5rem" }}>
            You can download the latest version from the GitHub releases page.
          </p>
        </div>
      )}

      {/* Supported update states */}
      {!isUnsupported && (
        <>
          {/* Status message */}
          <p className="dim" style={{ marginBottom: "0.75rem" }}>
            {status.userMessage}
            {status.phase === "update-available" && status.availableVersion && (
              <strong style={{ color: "var(--success)", marginLeft: "0.25rem" }}>
                {status.availableVersion}
              </strong>
            )}
            {status.phase === "downloaded" && status.downloadedVersion && (
              <strong style={{ color: "var(--accent)", marginLeft: "0.25rem" }}>
                {status.downloadedVersion}
              </strong>
            )}
          </p>

          {/* Last checked */}
          {status.lastCheckedAt && status.phase !== "checking" && status.phase !== "downloading" && (
            <p className="dim" style={{ fontSize: "0.7rem", marginBottom: "0.5rem" }}>
              Last checked: {formatTime(status.lastCheckedAt)}
            </p>
          )}

          {/* Download progress */}
          {showProgress && (
            <div className="progress-section" style={{ marginBottom: "0.75rem" }}>
              <div className="progress-bar-bg" style={{
                width: "100%",
                height: "8px",
                background: "var(--bg-tertiary)",
                borderRadius: "4px",
                overflow: "hidden",
              }}>
                <div className="progress-bar-fill" style={{
                  width: `${status.downloadPercent ?? 0}%`,
                  height: "100%",
                  background: "var(--accent)",
                  borderRadius: "4px",
                  transition: "width 0.3s ease",
                }} />
              </div>
              <div style={{
                display: "flex",
                justifyContent: "space-between",
                marginTop: "0.25rem",
                fontSize: "0.7rem",
                color: "var(--text-dim)",
              }}>
                <span>{status.downloadPercent?.toFixed(0) ?? 0}%</span>
                <span>{formatBytes(status.transferredBytes)} / {formatBytes(status.totalBytes)}</span>
                <span>{formatSpeed(status.bytesPerSecond)}</span>
              </div>
            </div>
          )}

          {/* Error message */}
          {status.phase === "error" && status.errorMessage && (
            <p className="dim" style={{
              color: "var(--danger)",
              marginBottom: "0.5rem",
              padding: "0.5rem",
              background: "var(--danger-bg)",
              borderRadius: "var(--radius-sm)",
              fontSize: "0.75rem",
            }}>
              {status.errorMessage}
            </p>
          )}

          {/* Action buttons */}
          <div className="update-actions" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
            {/* Check for updates */}
            {canCheck && !showCheckAgain && (
              <button onClick={handleCheck} disabled={actionInProgress}>
                {actionInProgress ? "Checking..." : "Check for Updates"}
              </button>
            )}

            {/* Check Again (when up-to-date) */}
            {showCheckAgain && (
              <button onClick={handleCheck} disabled={actionInProgress} className="ghost">
                {actionInProgress ? "Checking..." : "Check Again"}
              </button>
            )}

            {/* Checking state */}
            {isChecking && (
              <button disabled>Checking...</button>
            )}

            {/* Download Update */}
            {canDownload && (
              <button onClick={handleDownload} disabled={actionInProgress} style={{ background: "var(--success)" }}>
                {actionInProgress ? "Starting download..." : "Download Update"}
              </button>
            )}

            {/* Restart and Install */}
            {canInstall && (
              <button onClick={handleInstall} disabled={actionInProgress} style={{ background: "var(--accent)" }}>
                {actionInProgress ? "Restarting..." : "Restart and Install"}
              </button>
            )}

            {/* Installing state */}
            {isInstalling && (
              <button disabled>Restarting to install...</button>
            )}

            {/* Try Again after error */}
            {showTryAgain && (
              <button onClick={handleCheck} disabled={actionInProgress}>
                {actionInProgress ? "Checking..." : "Try Again"}
              </button>
            )}
          </div>

          {/* Install warning when sharing/viewing */}
          {canInstall && (
            <p className="dim" style={{ marginTop: "0.5rem", fontSize: "0.7rem", color: "var(--warning)" }}>
              Restarting will stop any active screen sharing or viewing sessions.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ─── Main Settings component ──────────────────────────────────────────────

/**
 * Render the Settings page (Phase 3).
 *
 * Stage 12: Removed all pairing/friend UI. Now includes:
 * - Profile (display name, propagates to all groups)
 * - Behavior (launch at login, auto-resume)
 * - Host Quality Limits (max bitrate, resolution, fps, viewer requests toggle)
 * - Local Transport (policy configuration)
 * - Developer Mode
 */
export function Settings() {
  const { navigate } = useStore();

  const [settings, setSettings] = useState<PersistedSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Form state
  const [displayName, setDisplayName] = useState("");
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [autoResume, setAutoResume] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);

  // Host quality limits
  const [hostMaxBitrate, setHostMaxBitrate] = useState(5000);
  const [hostMaxWidth, setHostMaxWidth] = useState(1920);
  const [hostMaxHeight, setHostMaxHeight] = useState(1080);
  const [hostMaxFps, setHostMaxFps] = useState(60);
  const [allowViewerRequests, setAllowViewerRequests] = useState(true);

  // Local transport policy (JSON blob)
  const [localTransportJson, setLocalTransportJson] = useState("{}");

  // Dirty marker — must exist before the clamp handlers reference it.
  const markDirty = useCallback(() => setDirty(true), []);

  // ── Clamp helpers — ensure invalid input (NaN, negative, out-of-range)
  //    does not silently become 0.
  const clampInt = useCallback((raw: string, min: number, max: number, fallback: number): number => {
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed) || !Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }, []);

  const handleMaxBitrateChange = useCallback((raw: string) => {
    setHostMaxBitrate(clampInt(raw, 100, 20000, 5000));
    markDirty();
  }, [clampInt, markDirty]);

  const handleMaxWidthChange = useCallback((raw: string) => {
    setHostMaxWidth(clampInt(raw, 320, 3840, 1920));
    markDirty();
  }, [clampInt, markDirty]);

  const handleMaxHeightChange = useCallback((raw: string) => {
    setHostMaxHeight(clampInt(raw, 180, 2160, 1080));
    markDirty();
  }, [clampInt, markDirty]);

  const handleMaxFpsChange = useCallback((raw: string) => {
    setHostMaxFps(clampInt(raw, 1, 60, 60));
    markDirty();
  }, [clampInt, markDirty]);

  const reloadSettings = useCallback(async () => {
    try {
      const api = await getApi();
      const s = await api?.getSettings();
      if (s) {
        setSettings(s);
        setDisplayName(s.hostDisplayName);
        setLaunchAtLogin(s.launchAtLogin);
        setAutoResume(s.autoResumeLastMonitor);
        setDeveloperMode(s.developerMode);
        setNotificationsEnabled(s.notificationsEnabled !== false);
        setHostMaxBitrate(s.hostQualityLimits.maxVideoBitrateKbps);
        setHostMaxWidth(s.hostQualityLimits.maxWidth);
        setHostMaxHeight(s.hostQualityLimits.maxHeight);
        setHostMaxFps(s.hostQualityLimits.maxFps);
        setAllowViewerRequests(s.hostQualityLimits.allowViewerQualityRequests);
        setLocalTransportJson(JSON.stringify(s.localTransportPolicy, null, 2));
      }
    } catch (err) {
      console.error("Failed to load settings:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load settings on mount
  useEffect(() => {
    void reloadSettings();
  }, [reloadSettings]);

  const handleSave = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const api = await getApi();
      const runtime = getRuntime();

      // Build the partial update
      const partial: Record<string, unknown> = {
        hostDisplayName: displayName,
        launchAtLogin,
        autoResumeLastMonitor: autoResume,
        developerMode,
        notificationsEnabled,
        hostQualityLimits: {
          maxVideoBitrateKbps: hostMaxBitrate,
          maxWidth: hostMaxWidth,
          maxHeight: hostMaxHeight,
          maxFps: hostMaxFps,
          allowViewerQualityRequests: allowViewerRequests,
        },
      };

      // Parse local transport policy JSON
      try {
        partial.localTransportPolicy = JSON.parse(localTransportJson);
      } catch {
        partial.localTransportPolicy = {};
      }

      await api?.updateSettings(partial);

      // Propagate display name through all groups if changed
      if (displayName !== settings.hostDisplayName && runtime) {
        await api?.updateDisplayName(displayName);
        const syncService = runtime.getSyncService();
        const store = useStore.getState();
        for (const groupId of store.groupOrder) {
          try {
            await syncService.updateDisplayName(groupId, displayName);
          } catch {
            // Best effort per group
          }
        }
      }

      setDirty(false);
    } catch (err) {
      console.error("Failed to save settings:", err);
    } finally {
      setSaving(false);
    }
  }, [settings, displayName, launchAtLogin, autoResume, developerMode, notificationsEnabled, hostMaxBitrate, hostMaxWidth, hostMaxHeight, hostMaxFps, allowViewerRequests, localTransportJson]);

  if (loading) {
    return (
      <div className="settings">
        <div className="page-header">
          <h1>Settings</h1>
          <button className="ghost" onClick={() => navigate("dashboard" as Page)}>&larr; Back</button>
        </div>
        <p className="dim">Loading settings...</p>
      </div>
    );
  }

  return (
    <div className="settings">
      <div className="page-header">
        <h1>Settings</h1>
        <button className="ghost" onClick={() => navigate("dashboard" as Page)}>&larr; Back</button>
      </div>

      {/* ── Profile ────────────────────────────────────────────────── */}
      <div className="card">
        <h3>Profile</h3>
        <label className="field">
          <span>Display Name</span>
          <input type="text" value={displayName}
            onChange={(e) => { setDisplayName(e.target.value); markDirty(); }}
            placeholder="Your name shown to viewers" />
        </label>
        <p className="dim" style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>
          Saved to all groups you belong to.
        </p>
      </div>

      {/* ── Behaviour ───────────────────────────────────────────────── */}
      <div className="card">
        <h3>Behaviour</h3>
        <label className="field toggle-row">
          <span>Launch at login</span>
          <input type="checkbox" checked={launchAtLogin}
            onChange={() => { setLaunchAtLogin(!launchAtLogin); markDirty(); }} />
        </label>
        <label className="field toggle-row">
          <span>Auto-resume last monitor on startup</span>
          <input type="checkbox" checked={autoResume}
            onChange={() => { setAutoResume(!autoResume); markDirty(); }} />
        </label>
        <label className="field toggle-row">
          <span>Desktop notifications</span>
          <input type="checkbox" checked={notificationsEnabled}
            onChange={() => { setNotificationsEnabled(!notificationsEnabled); markDirty(); }} />
        </label>
      </div>

      {/* ── Host Quality Limits ────────────────────────────────────── */}
      <div className="card">
        <h3>Host Quality Limits</h3>
        <p className="dim" style={{ fontSize: "0.8rem", marginBottom: "0.75rem" }}>
          Maximum quality values for your outgoing stream. Applied as a ceiling to preset and viewer requests.
        </p>
        <label className="field">
          <span>Max Video Bitrate (kbps)</span>
          <input type="number" value={hostMaxBitrate}
            onChange={(e) => handleMaxBitrateChange(e.target.value)}
            min={100} max={20000} />
        </label>
        <label className="field">
          <span>Max Width (px)</span>
          <input type="number" value={hostMaxWidth}
            onChange={(e) => handleMaxWidthChange(e.target.value)}
            min={320} max={3840} />
        </label>
        <label className="field">
          <span>Max Height (px)</span>
          <input type="number" value={hostMaxHeight}
            onChange={(e) => handleMaxHeightChange(e.target.value)}
            min={180} max={2160} />
        </label>
        <label className="field">
          <span>Max FPS</span>
          <input type="number" value={hostMaxFps}
            onChange={(e) => handleMaxFpsChange(e.target.value)}
            min={1} max={60} />
        </label>
        <label className="field toggle-row">
          <span>Allow viewer quality requests</span>
          <input type="checkbox" checked={allowViewerRequests}
            onChange={() => { setAllowViewerRequests(!allowViewerRequests); markDirty(); }} />
        </label>
      </div>

      {/* ── Developer Mode ─────────────────────────────────────────── */}
      <div className="card">
        <h3>Developer Mode</h3>
        <label className="field toggle-row">
          <span>Enable Developer Mode</span>
          <input type="checkbox" checked={developerMode}
            onChange={() => { setDeveloperMode(!developerMode); markDirty(); }} />
        </label>
        <p className="dim" style={{ fontSize: "0.75rem" }}>
          {developerMode
            ? "Developer Mode is active. Additional audio mode options and diagnostics are available."
            : "Developer Mode exposes additional audio controls and detailed diagnostics."}
        </p>
      </div>

      {/* ── Local Transport ────────────────────────────────────────── */}
      <div className="card">
        <h3>Local Transport</h3>
        <p className="dim" style={{ fontSize: "0.8rem", marginBottom: "0.5rem" }}>
          Local transport policy configuration (JSON). Used for advanced networking setup.
        </p>
        <textarea
          value={localTransportJson}
          onChange={(e) => { setLocalTransportJson(e.target.value); markDirty(); }}
          rows={4}
          style={{ width: "100%", fontFamily: "monospace", fontSize: "0.8rem" }}
        />
      </div>

      {/* ── Save ───────────────────────────────────────────────────── */}
      <div className="actions">
        <button onClick={handleSave} disabled={!dirty || saving}>
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>
    </div>
  );
}
