import React, { useEffect, useState, useCallback } from "react";
import { useStore, type Page } from "../stores/main-store.js";
import type { PersistedSettings } from "../../preload/api-types.js";
import { getRuntime } from "../services/phase3-runtime.js";

async function getApi() {
  return (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
}

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

  const markDirty = useCallback(() => setDirty(true), []);

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
