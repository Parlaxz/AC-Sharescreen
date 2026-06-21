import React, { useEffect, useState, useCallback } from "react";
import { useStore, type Page } from "../stores/main-store.js";
import type { PersistedSettings } from "../../preload/api-types.js";
import { restartControlConnection } from "../services/control-connection.js";

async function getApi() {
  return (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
}

/**
 * Render the Settings page with pairing lifecycle-driven UI.
 *
 * Key rules:
 * - Never check "does pairingConfig exist" as a proxy for "is paired".
 * - Instead, read `pairingConfig.pairingLifecycle` to determine what to show.
 * - "Paired with: Unknown" is never displayed.
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

  // Pairing state
  const [pairingConfig, setPairingConfig] = useState<Record<string, unknown> | null>(null);
  const [pairingStatus, setPairingStatus] = useState<string | null>(null);
  const [createdPairingCode, setCreatedPairingCode] = useState<string | null>(null);
  const [importLinkInput, setImportLinkInput] = useState("");

  // ── Derived lifecycle helpers ──────────────────────────────────────

  /** Get the pairing lifecycle, defaulting to "UNPAIRED" if no config. */
  function getLifecycle(): string {
    if (!pairingConfig) return "UNPAIRED";
    return (pairingConfig as Record<string, unknown>).pairingLifecycle as string || "UNPAIRED";
  }

  function isPairedLifecycle(): boolean {
    const lc = getLifecycle();
    return lc === "PAIRED_ONLINE" || lc === "PAIRED_OFFLINE";
  }

  function getPairedName(): string {
    if (!pairingConfig) return "";
    const name = (pairingConfig as Record<string, unknown>).remoteDisplayName as string | undefined;
    return name || "";
  }

  function getLocalName(): string {
    if (!pairingConfig) return "";
    return (pairingConfig as Record<string, unknown>).localDisplayName as string || "";
  }

  /** True if the creator still has a pending link (not yet confirmed by handshake). */
  function hasPendingLink(): boolean {
    if (!pairingConfig) return false;
    return !!(pairingConfig as Record<string, unknown>).pendingPairingLink;
  }

  const reloadPairingState = useCallback(async () => {
    const api = await getApi();
    const config = await api?.getPairingConfig();

    if (!config) {
      setPairingConfig(null);
      setCreatedPairingCode(null);
      return;
    }

    setPairingConfig(config as Record<string, unknown>);
    const lifecycle = (config as Record<string, unknown>).pairingLifecycle as string;
    const hasPending = !!(config as Record<string, unknown>).pendingPairingLink;
    if ((lifecycle === "PAIR_CREATED_WAITING_FOR_IMPORT" || lifecycle === "PAIR_CONNECTED_UNCONFIRMED") && hasPending) {
      const link = await api?.getPairingLink();
      setCreatedPairingCode(link ?? null);
    } else {
      setCreatedPairingCode(null);
    }
  }, []);

  // Load settings
  useEffect(() => {
    (async () => {
      try {
        const api = await getApi();
        const s = await api?.getSettings();
        if (s) {
          setSettings(s);
          setDisplayName(s.hostDisplayName);
          setLaunchAtLogin(s.launchAtLogin);
          setAutoResume(s.autoResumeLastMonitor);
        }
        await reloadPairingState();
      } catch (err) {
        console.error("Failed to load settings:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, [reloadPairingState]);

  useEffect(() => {
    const onPairingUpdated = () => {
      reloadPairingState().catch((err) => {
        console.warn("Failed to refresh pairing state:", err);
      });
    };

    window.addEventListener("screenlink:pairing-updated", onPairingUpdated);
    return () => {
      window.removeEventListener("screenlink:pairing-updated", onPairingUpdated);
    };
  }, [reloadPairingState]);

  const markDirty = useCallback(() => setDirty(true), []);

  const handleSave = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const api = await getApi();
      await api?.updateSettings({
        hostDisplayName: displayName,
        launchAtLogin,
        autoResumeLastMonitor: autoResume,
      });
      setDirty(false);
    } catch (err) {
      console.error("Failed to save settings:", err);
    } finally {
      setSaving(false);
    }
  }, [settings, displayName, launchAtLogin, autoResume]);

  // ── Pairing handlers ──────────────────────────────────────────────

  const handleCreatePairing = useCallback(async () => {
    try {
      const api = await getApi();
      const name = displayName.trim() || "ScreenLink User";
      const result = await api?.createPairing(name);
      if (result) {
        setCreatedPairingCode(result.pairingLink);
        setPairingStatus("Pairing link created! Share it with your friend.");
        // Reload full config from main process to get the lifecycle state
        const config = await api?.getPairingConfig();
        if (config) setPairingConfig(config as Record<string, unknown>);
        // Restart control connection so creator enters waiting/connected lifecycle
        await restartControlConnection();
      }
    } catch (err) {
      setPairingStatus(`Failed: ${(err as Error).message}`);
    }
  }, [displayName]);

  const handleImportPairing = useCallback(async () => {
    const raw = importLinkInput.trim();
    if (!raw) {
      setPairingStatus("Paste a pairing link or code first.");
      return;
    }
    try {
      const api = await getApi();
      // Support both screenlink://pair links and raw base64 codes
      let code = raw;
      if (raw.startsWith("screenlink://pair?")) {
        const url = new URL(raw);
        const data = url.searchParams.get("data");
        if (!data) { setPairingStatus("Invalid pairing link: missing data parameter."); return; }
        code = decodeURIComponent(data);
      }
      const result = await api?.importPairing(code.trim());
      if (result) {
        setPairingStatus(`Pairing imported. Connecting to ${result.remoteName}...`);
        setCreatedPairingCode(null);
        setImportLinkInput("");
        const config = await api?.getPairingConfig();
        if (config) setPairingConfig(config as Record<string, unknown>);
        // Restart control connection so importer connects immediately
        await restartControlConnection();
      }
    } catch (err) {
      setPairingStatus(`Import failed: ${(err as Error).message}`);
    }
  }, [importLinkInput]);

  const handleClearPairing = useCallback(async () => {
    try {
      const api = await getApi();
      await api?.clearPairing();
      setPairingConfig(null);
      setPairingStatus("Pairing reset.");
      setCreatedPairingCode(null);
      // Restart control connection to tear down stale SDK connections and state
      await restartControlConnection();
    } catch (err) {
      setPairingStatus(`Failed: ${(err as Error).message}`);
    }
  }, []);

  const handleRegenerateLink = useCallback(async () => {
    try {
      const api = await getApi();
      const name = displayName.trim() || "ScreenLink User";
      const result = await api?.createPairing(name);
      if (result) {
        setCreatedPairingCode(result.pairingLink);
        setPairingStatus("New pairing link generated!");
        const config = await api?.getPairingConfig();
        if (config) setPairingConfig(config as Record<string, unknown>);
        // Restart control connection with the regenerated credentials
        await restartControlConnection();
      }
    } catch (err) {
      setPairingStatus(`Failed: ${(err as Error).message}`);
    }
  }, [displayName]);

  const handleExportFile = useCallback(async () => {
    try {
      const api = await getApi();
      const exportData = await api?.exportCurrentPairing();
      if (exportData) {
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "screenlink-pairing.json"; a.click();
        URL.revokeObjectURL(url);
      }
    } catch { /* ignore */ }
  }, []);

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

  const lifecycle = getLifecycle();
  const pairedName = getPairedName();

  return (
    <div className="settings">
      <div className="page-header">
        <h1>Settings</h1>
        <button className="ghost" onClick={() => navigate("dashboard" as Page)}>&larr; Back</button>
      </div>

      {/* ── Pairing ──────────────────────────────────────────────── */}
      <div className="card">
        <h3>Pairing</h3>

        {/* ── PAIR_CREATED_WAITING_FOR_IMPORT: Show the link ───── */}
        {lifecycle === "PAIR_CREATED_WAITING_FOR_IMPORT" && (
          <>
            <p className="dim">Pairing link created. Share it with your friend to complete pairing.</p>

            {createdPairingCode && (
              <div style={{ marginTop: "0.75rem" }}>
                <label><span>Pairing Link:</span></label>
                <div className="link-row" style={{ display: "flex", gap: "0.5rem" }}>
                  <input type="text" readOnly value={createdPairingCode}
                    onClick={e => (e.target as HTMLInputElement).select()} style={{ flex: 1, fontSize: "0.75rem" }} />
                  <button onClick={() => { navigator.clipboard.writeText(createdPairingCode); setPairingStatus("Copied!"); }}>
                    Copy Pairing Link
                  </button>
                </div>
                <div className="action-row" style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
                  <button className="ghost" style={{ fontSize: "0.8rem" }} onClick={handleExportFile}>
                    Export Pairing File
                  </button>
                  <button className="ghost" style={{ fontSize: "0.8rem" }} onClick={handleRegenerateLink}>
                    Regenerate Pairing Link
                  </button>
                </div>
              </div>
            )}

            {!createdPairingCode && (
              <p className="dim" style={{ marginTop: "0.5rem" }}>
                Loading pairing link... <button className="ghost" style={{ fontSize: "0.8rem" }} onClick={async () => {
                  const api = await getApi();
                  const link = await api?.getPairingLink();
                  if (link) setCreatedPairingCode(link);
                }}>Show Link</button>
              </p>
            )}

            {pairingStatus && <p className="dim" style={{ marginTop: "0.5rem" }}>{pairingStatus}</p>}

            <hr style={{ margin: "1rem 0", border: "none", borderTop: "1px solid var(--border)" }} />

            <p className="dim">Instead have a pairing link from your friend?</p>
            <button className="ghost" style={{ marginTop: "0.25rem", fontSize: "0.8rem" }} onClick={() => {
              // Clear the current waiting state and show the create/import UI
              setPairingConfig(null);
              setCreatedPairingCode(null);
            }}>
              Start Over
            </button>
          </>
        )}

        {/* ── PAIR_IMPORTED_CONNECTING: Connecting status ──────── */}
        {lifecycle === "PAIR_IMPORTED_CONNECTING" && (
          <>
            <p className="dim">Pairing imported. Connecting to friend...</p>
            <p className="dim">Your device: <strong>{getLocalName()}</strong></p>
            <div className="actions" style={{ marginTop: "0.75rem" }}>
              <button className="danger" onClick={handleClearPairing}>Reset Pairing</button>
            </div>
            {pairingStatus && <p className="dim" style={{ marginTop: "0.5rem" }}>{pairingStatus}</p>}
          </>
        )}

        {/* ── PAIR_CONNECTED_UNCONFIRMED: Connected, waiting for hello ── */}
        {lifecycle === "PAIR_CONNECTED_UNCONFIRMED" && (
          <>
            {hasPendingLink() ? (
              <>
                <p className="dim">Signal connected — waiting for your friend to import the pairing link.</p>
                {/* Show the link so the creator can still copy/export/regenerate */}
                {createdPairingCode && (
                  <div style={{ marginTop: "0.75rem" }}>
                    <label><span>Pairing Link:</span></label>
                    <div className="link-row" style={{ display: "flex", gap: "0.5rem" }}>
                      <input type="text" readOnly value={createdPairingCode}
                        onClick={e => (e.target as HTMLInputElement).select()} style={{ flex: 1, fontSize: "0.75rem" }} />
                      <button onClick={() => { navigator.clipboard.writeText(createdPairingCode); setPairingStatus("Copied!"); }}>
                        Copy Pairing Link
                      </button>
                    </div>
                    <div className="action-row" style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
                      <button className="ghost" style={{ fontSize: "0.8rem" }} onClick={handleExportFile}>
                        Export Pairing File
                      </button>
                      <button className="ghost" style={{ fontSize: "0.8rem" }} onClick={handleRegenerateLink}>
                        Regenerate Pairing Link
                      </button>
                    </div>
                  </div>
                )}
                {!createdPairingCode && (
                  <p className="dim" style={{ marginTop: "0.5rem" }}>
                    Loading pairing link... <button className="ghost" style={{ fontSize: "0.8rem" }} onClick={async () => {
                      const api = await getApi();
                      const link = await api?.getPairingLink();
                      if (link) setCreatedPairingCode(link);
                    }}>Show Link</button>
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="dim">Connected — waiting for handshake...</p>
                <p className="dim">Your device: <strong>{getLocalName()}</strong></p>
              </>
            )}
            <div className="actions" style={{ marginTop: "0.75rem" }}>
              <button className="danger" onClick={handleClearPairing}>Reset Pairing</button>
            </div>
            {pairingStatus && <p className="dim" style={{ marginTop: "0.5rem" }}>{pairingStatus}</p>}
          </>
        )}

        {/* ── PAIRED_ONLINE / PAIRED_OFFLINE: Full pairing ────── */}
        {isPairedLifecycle() && (
          <>
            <p className="dim">Your device: <strong>{getLocalName()}</strong></p>
            {pairedName ? (
              <p className="dim">Paired with: <strong>{pairedName}</strong></p>
            ) : (
              <p className="dim">Paired with a friend</p>
            )}
            <p className="dim" style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>
              {lifecycle === "PAIRED_ONLINE" ? "Online" : "Offline"}
            </p>
            <div className="actions" style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button className="danger" onClick={handleClearPairing}>Forget Pairing</button>
              <button className="ghost" style={{ fontSize: "0.8rem" }} onClick={handleClearPairing}>Replace Pairing</button>
            </div>
            {pairingStatus && <p className="dim" style={{ marginTop: "0.5rem" }}>{pairingStatus}</p>}
          </>
        )}

        {/* ── UNPAIRED (or null config): Create/import UI ─────── */}
        {(lifecycle === "UNPAIRED" || !pairingConfig) && (
          <>
            <p className="dim">Pair two ScreenLink apps so they can find each other automatically.</p>
            <p className="dim" style={{ marginTop: "0.5rem" }}>One person creates a pairing and shares the link.</p>

            <div className="field" style={{ marginTop: "0.75rem" }}>
              <span>Your display name</span>
              <input type="text" value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="ScreenLink User" />
            </div>

            <div className="action-row" style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem", flexWrap: "wrap" }}>
              <button onClick={handleCreatePairing}>Create Pairing</button>
            </div>

            {pairingStatus && <p className="dim" style={{ marginTop: "0.5rem" }}>{pairingStatus}</p>}

            <hr style={{ margin: "1rem 0", border: "none", borderTop: "1px solid var(--border)" }} />

            <p className="dim">Already have a pairing link from your friend? Paste it here:</p>
            <div className="link-row" style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
              <input type="text" value={importLinkInput}
                onChange={e => setImportLinkInput(e.target.value)}
                placeholder="screenlink://pair?v=1&data=..."
                style={{ flex: 1, fontSize: "0.75rem" }} />
              <button onClick={handleImportPairing}>Import</button>
            </div>
          </>
        )}
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
      </div>

      {/* ── Behavior ───────────────────────────────────────────────── */}
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
