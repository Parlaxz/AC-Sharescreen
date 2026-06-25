import React, { useEffect, useState, useCallback } from "react";
import { useStore } from "../stores/main-store.js";
import {
  createDefaultGroupQualitySettings,
  extractViewerRequestFromPreset,
  type QualityPreset,
} from "@screenlink/shared";
import { PresetEditor } from "../components/PresetEditor.js";
import { getRuntime } from "../services/phase3-runtime.js";

export function QualityPresets() {
  const [presets, setPresets] = useState<QualityPreset[]>([]);
  const [importString, setImportString] = useState("");
  const [exportString, setExportString] = useState<string | null>(null);
  const [exportName, setExportName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [showNewEditor, setShowNewEditor] = useState(false);
  const [renamingPresetId, setRenamingPresetId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const getApi = (): import("../../preload/api-types.js").ScreenLinkAPI | undefined => {
    return (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
  };

  const refresh = useCallback(async () => {
    const api = getApi();
    if (!api) return;
    const list = (await api.listQualityPresets()) as QualityPreset[];
    setPresets(list);
    useStore.getState().setQualityPresets(list as unknown[]);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onCreate = async (name: string, settings: import("@screenlink/shared").GroupQualitySettings) => {
    const api = getApi();
    if (!api) return;
    await api.createQualityPreset({ name, settings });
    setShowNewEditor(false);
    await refresh();
  };

  const onUpdate = async (id: string, name: string, settings: import("@screenlink/shared").GroupQualitySettings) => {
    const api = getApi();
    if (!api) return;
    await api.updateQualityPreset(id, { name, settings });
    setEditingPresetId(null);
    await refresh();
  };

  const onDelete = async (id: string) => {
    const api = getApi();
    if (!api) return;
    await api.deleteQualityPreset(id);
    await refresh();
  };

  const onDuplicate = async (id: string) => {
    const api = getApi();
    if (!api) return;
    const original = presets.find((p) => p.id === id);
    if (!original) return;
    await api.duplicateQualityPreset(id, `${original.name} (Copy)`);
    await refresh();
  };

  const onExport = async (id: string) => {
    const api = getApi();
    if (!api) return;
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    const str = await api.exportQualityPreset(id);
    if (str) {
      setExportString(str);
      setExportName(preset.name);
    }
  };

  const onImport = async () => {
    setError(null);
    const api = getApi();
    if (!api) return;
    try {
      const result = await api.importQualityPreset(importString.trim());
      if (result && typeof result === "object" && "error" in result) {
        setError((result as { error: string }).error);
        return;
      }
      setImportString("");
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  /** Get the first watched host in the first group the viewer belongs to. */
  const resolveFirstWatchedHost = ():
    | { groupId: string; sessionId: string; hostDeviceId: string; hostName: string }
    | null =>
  {
    const store = useStore.getState();
    for (const [sessionId, w] of Object.entries(store.watchedStreamsBySessionId)) {
      // Find the group that has this stream
      for (const [gid, streams] of Object.entries(store.activeStreamsByGroup)) {
        for (const s of streams) {
          if (s.mediaSessionId === sessionId) {
            return { groupId: gid, sessionId, hostDeviceId: w.hostDeviceId, hostName: w.hostName };
          }
        }
      }
    }
    return null;
  };

  /**
   * Production path: dispatch quality.viewer.request over the group control channel.
   * Uses the runtime connection manager to send the message to every peer in the group
   * that matches the target host. The remote QualityCoordinator handles the request.
   */
  const onUseThisPreset = async (preset: QualityPreset) => {
    setStatusMessage(null);
    const target = resolveFirstWatchedHost();
    if (!target) {
      setStatusMessage("No watched streams available. Watch a stream first to request quality changes.");
      return;
    }

    const { groupId, sessionId, hostDeviceId } = target;
    const runtime = getRuntime();
    if (!runtime) {
      setStatusMessage("Runtime not initialized.");
      return;
    }

    const connManager = runtime.getConnectionManager();
    const conn = connManager.getConnection(groupId);
    if (!conn) {
      setStatusMessage("Not connected to the target group.");
      return;
    }

    const request = extractViewerRequestFromPreset(preset.settings, sessionId, 0);

    // Send to the specific host via peer lookup
    const peerUuid = conn.peerForDevice(hostDeviceId);
    if (peerUuid) {
      await conn.sendToPeer(peerUuid, {
        type: "quality.viewer.request",
        ...request,
      });
      setStatusMessage(`Quality request sent to ${hostDeviceId} for stream ${sessionId.slice(0, 8)}.`);
    } else {
      // Fall back to broadcast if peer not found directly
      await conn.broadcast({
        type: "quality.viewer.request",
        ...request,
      });
      setStatusMessage(`Quality request broadcast in group for stream ${sessionId.slice(0, 8)}.`);
    }
  };

  /**
   * Production path: dispatch quality.viewer.clear over the group control channel.
   * This tells the host to stop using viewer-specific overrides and revert to
   * the group's default quality settings.
   */
  const onUseGroupDefault = async () => {
    setStatusMessage(null);
    const target = resolveFirstWatchedHost();
    if (!target) {
      setStatusMessage("No watched streams available. Watch a stream first to clear quality override.");
      return;
    }

    const { groupId, sessionId, hostDeviceId } = target;
    const runtime = getRuntime();
    if (!runtime) {
      setStatusMessage("Runtime not initialized.");
      return;
    }

    const connManager = runtime.getConnectionManager();
    const conn = connManager.getConnection(groupId);
    if (!conn) {
      setStatusMessage("Not connected to the target group.");
      return;
    }

    const viewerDeviceId = runtime.deviceId ?? "unknown";

    const peerUuid = conn.peerForDevice(hostDeviceId);
    const clearPayload = {
      type: "quality.viewer.clear" as const,
      streamSessionId: sessionId,
      viewerDeviceId,
    };

    if (peerUuid) {
      await conn.sendToPeer(peerUuid, clearPayload);
      setStatusMessage(`Quality override cleared for stream ${sessionId.slice(0, 8)}. Group default will be used.`);
    } else {
      await conn.broadcast(clearPayload);
      setStatusMessage(`Quality override cleared for stream ${sessionId.slice(0, 8)} (broadcast).`);
    }
  };

  const onStartRename = (preset: QualityPreset) => {
    setRenamingPresetId(preset.id);
    setRenameValue(preset.name);
  };

  const onCommitRename = async (id: string) => {
    const api = getApi();
    if (!api) return;
    if (renameValue.trim()) {
      await api.updateQualityPreset(id, { name: renameValue.trim() });
      await refresh();
    }
    setRenamingPresetId(null);
  };

  const editingPreset = editingPresetId
    ? presets.find((p) => p.id === editingPresetId)
    : undefined;

  return (
    <div className="page">
      <header className="page-header">
        <h1>Quality Presets</h1>
        <div className="actions">
          <button onClick={() => setShowNewEditor(true)} disabled={showNewEditor}>
            Create Preset
          </button>
        </div>
      </header>

      {/* Import/Export */}
      <div className="card">
        <h3>Import/Export</h3>
        <div className="import-row">
          <textarea
            placeholder="Paste exported preset string (SLQP1:...)"
            value={importString}
            onChange={(e) => setImportString(e.target.value)}
            rows={2}
          />
          <button onClick={onImport}>Import Preset</button>
        </div>

        {error && <p className="error">{error}</p>}

        {exportString && (
          <div className="export-dialog" style={{ marginTop: "0.75rem" }}>
            <p className="dim">Export: {exportName}</p>
            <textarea readOnly value={exportString} rows={3} style={{ width: "100%" }} />
            <div className="actions" style={{ marginTop: "0.5rem" }}>
              <button onClick={async () => { await navigator.clipboard.writeText(exportString); }}>Copy</button>
              <button onClick={() => { setExportString(null); setExportName(""); }}>Close</button>
            </div>
          </div>
        )}
      </div>

      {/* Preset Editor: New */}
      {showNewEditor && (
        <PresetEditor
          onSave={onCreate}
          onCancel={() => setShowNewEditor(false)}
        />
      )}

      {/* Preset Editor: Edit */}
      {editingPreset && (
        <PresetEditor
          preset={editingPreset.settings}
          presetName={editingPreset.name}
          onSave={(name, settings) => onUpdate(editingPreset.id, name, settings)}
          onCancel={() => setEditingPresetId(null)}
        />
      )}

      {/* Status message */}
      {statusMessage && (
        <div className="status-banner" style={{
          background: "var(--info-bg, #d1ecf1)",
          border: "1px solid var(--info-border, #17a2b8)",
          padding: "0.5rem 0.75rem",
          borderRadius: "4px",
          marginBottom: "0.75rem",
          fontSize: "0.85rem",
        }}>
          {statusMessage}
          <button
            className="ghost"
            style={{ marginLeft: "0.5rem", fontSize: "0.8rem" }}
            onClick={() => setStatusMessage(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Preset List */}
      <div className="preset-list">
        {presets.length === 0 && !showNewEditor ? (
          <>
            <p>No local presets yet.</p>
            <p>Create a preset to save your preferred quality settings.</p>
          </>
        ) : (
          presets.map((p) => (
            <div key={p.id} className="preset-card card">
              <div className="preset-header">
                {renamingPresetId === p.id ? (
                  <div className="rename-row" style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    <input
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void onCommitRename(p.id); if (e.key === "Escape") setRenamingPresetId(null); }}
                      autoFocus
                      style={{ flex: 1 }}
                    />
                    <button onClick={() => void onCommitRename(p.id)}>Save</button>
                    <button className="ghost" onClick={() => setRenamingPresetId(null)}>Cancel</button>
                  </div>
                ) : (
                  <h3 style={{ cursor: "pointer" }} onClick={() => onStartRename(p)} title="Click to rename">
                    {p.name}
                  </h3>
                )}
                <span className="dim" style={{ fontSize: "0.75rem" }}>
                  Updated {new Date(p.updatedAt).toLocaleDateString()}
                </span>
              </div>

              <div className="preset-details" style={{ fontSize: "0.85rem", margin: "0.5rem 0" }}>
                <p>
                  <strong>Video:</strong> {p.settings.video.sendWidth}&times;{p.settings.video.sendHeight} @ {p.settings.video.sendFps} fps &middot; {p.settings.video.videoBitrateKbps} kbps &middot; {p.settings.video.codec}
                </p>
                <p>
                  <strong>Audio:</strong> {p.settings.audio.bitrateKbps} kbps &middot; {p.settings.audio.channels} &middot; FEC: {p.settings.audio.fec ? "ON" : "OFF"} &middot; DTX: {p.settings.audio.dtx ? "ON" : "OFF"}
                </p>
                <p className="dim" style={{ fontSize: "0.8rem" }}>
                  Content: {p.settings.video.contentHint} &middot; Degradation: {p.settings.video.degradationPreference} &middot; Codec: {p.settings.video.codec} &middot; H264: {p.settings.video.h264Profile}
                </p>
              </div>

              <div className="actions" style={{ flexWrap: "wrap" }}>
                <button onClick={() => setEditingPresetId(p.id)}>Edit</button>
                <button onClick={() => void onUseThisPreset(p)}>Use This Preset</button>
                <button onClick={() => void onUseGroupDefault()}>Use Group Default</button>
                <button className="ghost" onClick={() => void onDuplicate(p.id)}>Duplicate</button>
                <button className="ghost" onClick={() => void onExport(p.id)}>Export</button>
                <button className="danger" onClick={() => void onDelete(p.id)}>Delete</button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
