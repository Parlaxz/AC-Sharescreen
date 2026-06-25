import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useStore } from "../stores/main-store.js";
import {
  createDefaultGroupQualitySettings,
  extractViewerRequestFromPreset,
  type QualityPreset,
} from "@screenlink/shared";
import { PresetEditor } from "../components/PresetEditor.js";
import { getRuntime } from "../services/phase3-runtime.js";

// ─── Quality Status Display (Stage 17) ─────────────────────────────────────

interface QualityStatusProps {
  groupId: string;
  sessionId: string;
  hostDeviceId: string;
  hostName: string;
}

/**
 * Display requested/effective/observed quality status for the selected
 * watched target. Reads data from the runtime's QualityCoordinator and
 * MediaStatsPoller where available.
 */
function QualityStatusDisplay({ groupId, sessionId, hostDeviceId, hostName }: QualityStatusProps) {
  const [observedStats, setObservedStats] = useState<{
    videoBitrateKbps?: number;
    codec?: string;
    fps?: number;
    width?: number;
    height?: number;
    rtt?: number;
    packetLoss?: number;
    qualityLimitationReason?: string | null;
  } | null>(null);

  // Attempt to read per-viewer stats from the runtime
  useEffect(() => {
    const runtime = getRuntime();
    if (!runtime) return;

    const mss = runtime.getMediaStatsService();
    if (!mss || !mss.getViewerStats) return;

    // The viewer's own device ID is the runtime's deviceId
    const viewerDeviceId = runtime.deviceId ?? "unknown";

    // Try to find stats for this viewer+target combo.
    // For the viewer side, getViewerStats uses viewerDeviceId::mediaPeerUuid key.
    // We iterate known stats by querying the poller's internal map.
    // If we can resolve the mediaPeerUuid for this target, use it.
    const viewerBinding = runtime.getViewerMediaBinding();
    const hostMediaPeerUuid = viewerBinding?.getViewerMediaPeer(hostDeviceId);
    if (hostMediaPeerUuid) {
      const stats = mss.getViewerStats(groupId, sessionId, viewerDeviceId, hostMediaPeerUuid);
      if (stats) {
        setObservedStats({
          videoBitrateKbps: stats.videoBitrateKbps,
          codec: stats.codec,
          fps: stats.fps,
          width: stats.width,
          height: stats.height,
          rtt: stats.rtt,
          packetLoss: stats.packetLoss,
          qualityLimitationReason: stats.qualityLimitationReason,
        });
        return;
      }
    }

    // Fallback: try without mediaPeerUuid (viewer side — poller uses own deviceId)
    // The per-viewer poller on the viewer side stores stats keyed by viewerDeviceId::mediaPeerUuid
    // where viewerDeviceId = hostDeviceId (the host being watched) minus the mediaPeerUuid.
    // On the viewer side, the stats service was started with the host's media peer UUID.
    // Try by convention: the viewer's own stats are keyed by runtime.deviceId.
    const selfDeviceId = runtime.deviceId ?? "unknown";
    // Try the viewer's own accumulated stats (from legacy poller)
    const viewerStats = (mss as any).viewerStats as Map<string, unknown> | undefined;
    if (viewerStats) {
      // Look for any entry matching this session
      for (const [, entry] of viewerStats.entries()) {
        const s = entry as Record<string, unknown>;
        if (s.viewerDeviceId === selfDeviceId || s.viewerDeviceId === hostDeviceId) {
          setObservedStats({
            videoBitrateKbps: s.videoBitrateKbps as number,
            codec: s.codec as string,
            fps: s.fps as number,
            width: s.width as number,
            height: s.height as number,
            rtt: s.rtt as number,
            packetLoss: s.packetLoss as number,
            qualityLimitationReason: s.qualityLimitationReason as string | null,
          });
          return;
        }
      }
    }
  }, [groupId, sessionId, hostDeviceId]);

  /**
   * Resolve effective quality from the runtime's QualityCoordinator.
   * On the viewer side, the coordinator stores requests we've sent
   * (as seen via group message routing). For our own device, we can
   * read back the last request sent for this target stream.
   */
  const effectiveInfo = useMemo(() => {
    const runtime = getRuntime();
    if (!runtime) return null;
    const qc = runtime.getQualityCoordinator();
    if (!qc) return null;
    const viewerDeviceId = runtime.deviceId ?? "unknown";
    // The coordinator stores requests by groupId, logicalStreamId, viewerDeviceId
    // On the viewer side, logicalStreamId = sessionId for the watched stream.
    const request = qc.getViewerRequest(groupId, sessionId, viewerDeviceId);
    if (!request) return null;
    return {
      requestedBitrate: request.videoBitrateKbps,
      requestedWidth: request.maxWidth,
      requestedHeight: request.maxHeight,
      requestedFps: request.maxFps,
      requestedDegradation: request.degradationPreference,
      revision: request.revision,
      requestedAt: request.requestedAt,
    };
  }, [groupId, sessionId]);

  return (
    <div className="quality-status" style={{ marginTop: "0.5rem", fontSize: "0.85rem" }}>
      <p className="dim" style={{ marginBottom: "0.25rem" }}>
        <strong>Target:</strong> {hostName} &middot; <span style={{ fontSize: "0.8rem" }}>Session: {sessionId.slice(0, 8)}</span>
      </p>

      {/* Requested quality (from stored request) */}
      {effectiveInfo ? (
        <div className="quality-info-block" style={{ marginTop: "0.25rem" }}>
          <p style={{ fontSize: "0.8rem", fontWeight: 600, marginBottom: "0.15rem" }}>Requested</p>
          <p className="dim" style={{ fontSize: "0.75rem", lineHeight: 1.4 }}>
            {effectiveInfo.requestedBitrate} kbps &middot; {effectiveInfo.requestedWidth}&times;{effectiveInfo.requestedHeight} @ {effectiveInfo.requestedFps} fps
            &middot; {effectiveInfo.requestedDegradation}
          </p>
        </div>
      ) : (
        <div className="quality-info-block" style={{ marginTop: "0.25rem" }}>
          <p className="dim" style={{ fontSize: "0.75rem", fontStyle: "italic" }}>
            No quality request data available for this target.
          </p>
        </div>
      )}

      {/* Observed stats (from RTC stats pipeline) */}
      {observedStats ? (
        <div className="quality-info-block" style={{ marginTop: "0.25rem" }}>
          <p style={{ fontSize: "0.8rem", fontWeight: 600, marginBottom: "0.15rem" }}>Observed</p>
          <p className="dim" style={{ fontSize: "0.75rem", lineHeight: 1.4 }}>
            {observedStats.videoBitrateKbps ?? "?"} kbps &middot; {observedStats.width ?? "?"}&times;{observedStats.height ?? "?"} @ {observedStats.fps ?? "?"} fps
            &middot; {observedStats.codec ?? "?"}
            {observedStats.qualityLimitationReason ? ` &middot; Limited: ${observedStats.qualityLimitationReason}` : ""}
            {observedStats.rtt !== undefined ? ` &middot; RTT: ${observedStats.rtt}ms` : ""}
          </p>
        </div>
      ) : (
        <div className="quality-info-block" style={{ marginTop: "0.25rem" }}>
          <p className="dim" style={{ fontSize: "0.75rem", fontStyle: "italic" }}>
            No observed stats yet. Stats appear after the stream is connected.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────

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
  // Stage 17: Selected watched target for quality requests
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);

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

  /** Subscribe to store for reactive watched hosts */
  const watchedStreamsBySessionId = useStore((s) => s.watchedStreamsBySessionId);
  const activeStreamsByGroup = useStore((s) => s.activeStreamsByGroup);
  /** Stage 17: All available watched hosts (computed reactively from store) */
  const watchedHosts = useMemo<Array<{ id: string; groupId: string; sessionId: string; hostDeviceId: string; hostName: string }>>(() => {
    const result: Array<{ id: string; groupId: string; sessionId: string; hostDeviceId: string; hostName: string }> = [];
    for (const [sessionId, w] of Object.entries(watchedStreamsBySessionId)) {
      for (const [gid, streams] of Object.entries(activeStreamsByGroup)) {
        for (const stream of streams) {
          if (stream.mediaSessionId === sessionId) {
            result.push({
              id: `${gid}::${sessionId}`,
              groupId: gid,
              sessionId,
              hostDeviceId: w.hostDeviceId,
              hostName: w.hostName,
            });
          }
        }
      }
    }
    return result;
  }, [watchedStreamsBySessionId, activeStreamsByGroup]);

  /** Resolve the currently selected target object from selectedTargetId */
  const selectedTarget = useMemo(() => {
    if (!selectedTargetId) return null;
    return watchedHosts.find(t => t.id === selectedTargetId) ?? null;
  }, [selectedTargetId, watchedHosts]);

  /**
   * Production path: dispatch quality.viewer.request over the group control channel.
   * Uses the runtime connection manager to send the message to the selected target.
   * Stage 17: Uses selectedTarget instead of resolveFirstWatchedHost.
   */
  const onUseThisPreset = async (preset: QualityPreset) => {
    setStatusMessage(null);
    if (!selectedTarget) {
      setStatusMessage("Select a watched stream target first.");
      return;
    }

    const { groupId, sessionId, hostDeviceId } = selectedTarget;
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
   * Stage 17: Uses selectedTarget instead of resolveFirstWatchedHost.
   */
  const onUseGroupDefault = async () => {
    setStatusMessage(null);
    if (!selectedTarget) {
      setStatusMessage("Select a watched stream target first.");
      return;
    }

    const { groupId, sessionId, hostDeviceId } = selectedTarget;
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

      {/* Target selector — Stage 17: Explicit watched stream selection */}
      {watchedHosts.length > 0 && (
        <div className="card" style={{ marginBottom: "0.75rem" }}>
          <div className="field-row" style={{ alignItems: "center" }}>
            <label htmlFor="target-select" style={{ marginBottom: 0, whiteSpace: "nowrap" }}>
              Target Stream:
            </label>
            <select
              id="target-select"
              value={selectedTargetId ?? ""}
              onChange={(e) => setSelectedTargetId(e.target.value || null)}
              style={{ flex: 1 }}
            >
              <option value="">-- Select a stream --</option>
              {watchedHosts.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.hostName} ({t.sessionId.slice(0, 8)})
                </option>
              ))}
            </select>
          </div>
          {/* Stage 17: Quality status display for selected target */}
          {selectedTarget && (
            <QualityStatusDisplay
              groupId={selectedTarget.groupId}
              sessionId={selectedTarget.sessionId}
              hostDeviceId={selectedTarget.hostDeviceId}
              hostName={selectedTarget.hostName}
            />
          )}
        </div>
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
