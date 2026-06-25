import React, { useEffect, useState, useCallback, useRef } from "react";
import { useStore, type Page } from "../stores/main-store.js";
import {
  generateVdoStreamId,
  generateVdoPassword,
  getAudioModeInfo,
  normalizeAudioMode,
  type AudioMode,
} from "@screenlink/shared";
import {
  buildAvailabilityMap,
  resolveInitialAudioMode,
  type AudioAvailabilityMap,
} from "../audio/audio-hydration-helper.js";
import { getRuntime } from "../services/phase3-runtime.js";
import { PublisherManager } from "../services/publisher-manager.js";

export function Dashboard() {
  const {
    // Source
    sourceId, sourceName, sourceKind,
    // Group selection
    selectedGroupId, groupsById, groupOrder,
    // Active streams
    activeStreamsByGroup,
    // Watched streams
    watchedStreamsBySessionId,
    // Local streaming state
    localShareState, localStreamSession,
    isSharing, isDegraded,
    // Viewers
    viewerCount, viewers,
    // Capture settings
    captureWidth, captureHeight, captureFps, captureBitrate,
    // Navigation
    navigate,
    // Actions
    setLocalShareState, setLocalStreamSession,
    setSelectedGroupId, setIsSharing, setIsDegraded,
  } = useStore();

  // ── Audio derived mode display (text only, no radio buttons) ──
  const [audioMode, setAudioMode] = useState<AudioMode>('none');
  const [audioOptionsReady, setAudioOptionsReady] = useState(false);
  const [audioInitError, setAudioInitError] = useState<string | null>(null);

  // Publisher manager ref (stream lifecycle)
  const publisherManagerRef = useRef<PublisherManager | null>(null);

  // Load settings + capabilities, derive audio mode
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
      const [settingsResult, capsResult] = await Promise.all([
        api?.getSettings().catch(() => null) ?? Promise.resolve(null),
        api?.getAudioCapabilities().catch(() => null) ?? Promise.resolve(null),
      ]);
      if (cancelled) return;
      let availability: AudioAvailabilityMap = {
        none: true, system: true, application: true, monitor: true, 'test-tone': true,
      };
      try {
        if (capsResult?.success && capsResult.data) {
          const modes = getAudioModeInfo(capsResult.data);
          availability = buildAvailabilityMap(modes);
        }
      } catch { /* best effort */ }
      const persisted = settingsResult?.lastAudioMode ?? null;
      const { resolved, wasDowngraded } = resolveInitialAudioMode(persisted, availability);
      if (!cancelled) {
        setAudioMode(resolved);
        setAudioOptionsReady(true);
        if (wasDowngraded) {
          setAudioInitError(`Saved audio mode "${persisted}" is not available on this system`);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Derived data ────────────────────────────────────────────────

  const groupList = groupOrder
    .map((id) => groupsById[id])
    .filter((g): g is { id: string; name: string; members: Record<string, { deviceId: string; displayName: string }> } => !!g);

  const selectedGroupName = selectedGroupId ? groupsById[selectedGroupId]?.name ?? "Unknown Group" : null;

  const availableGroupStreams = Object.entries(activeStreamsByGroup).filter(
    ([, streams]) => streams.length > 0,
  );

  const watchedEntries = Object.entries(watchedStreamsBySessionId);

  const canStartStream = !!(
    sourceId &&
    selectedGroupId &&
    localShareState === "idle" &&
    audioOptionsReady
  );

  const isStreamActive = localShareState === "sharing";

  // ── Start Stream ─────────────────────────────────────────────────

  const handleStartStream = useCallback(async () => {
    if (!sourceId || !selectedGroupId) return;
    if (localShareState !== "idle") return;
    setLocalShareState("starting");
    try {
      const runtime = getRuntime();
      if (!runtime) {
        console.error("Phase3Runtime not initialized");
        setLocalShareState("error");
        return;
      }

      // 1. Generate VDO credentials
      const vdoStreamId = generateVdoStreamId();
      const vdoPassword = generateVdoPassword();
      const sessionId = crypto.randomUUID();

      // 2. Create PublisherManager
      const mgr = new PublisherManager({
        onStateChange: () => { /* state sync via store */ },
        onStats: () => { /* stats flow through store in future */ },
        onError: (err) => console.error("Publisher error:", err),
        onTrackEnded: () => { handleStopStream(); },
      });
      publisherManagerRef.current = mgr;

      // 3. Capture and publish via PublisherManager
      const stream = await mgr.startCapture({
        sourceId,
        password: vdoPassword,
        streamId: vdoStreamId,
        videoBitrate: captureBitrate,
        videoWidth: captureWidth,
        videoHeight: captureHeight,
        videoFps: captureFps,
      });
      await mgr.startPublishing(stream, {
        sourceId,
        password: vdoPassword,
        streamId: vdoStreamId,
        videoBitrate: captureBitrate,
        videoWidth: captureWidth,
        videoHeight: captureHeight,
        videoFps: captureFps,
      });

      const videoTrack = stream.getVideoTracks()[0]!;

      // 4. Start StreamSessionManager (control plane)
      await runtime.getStreamSessionManager().startStream({
        groupId: selectedGroupId,
        sourceId,
        sourceName: sourceName || "Screen",
        sourceKind: sourceKind ?? "screen",
        track: videoTrack,
      });

      // 5. Store local session credentials
      setLocalStreamSession({ sessionId, streamId: vdoStreamId, password: vdoPassword });
      setLocalShareState("sharing");
      setIsSharing(true);
    } catch (err) {
      console.error("Start stream failed:", err);
      setLocalShareState("error");
      publisherManagerRef.current?.stopCapture().catch(() => {});
      publisherManagerRef.current = null;
    }
  }, [sourceId, sourceName, sourceKind, selectedGroupId, localShareState, captureWidth, captureHeight, captureFps, captureBitrate, setLocalShareState, setLocalStreamSession, setIsSharing]);

  // ── Stop Stream ──────────────────────────────────────────────────

  const handleStopStream = useCallback(async () => {
    setLocalShareState("stopping");
    try {
      const runtime = getRuntime();
      if (runtime) {
        await runtime.getStreamSessionManager().stopStream();
      }
      await publisherManagerRef.current?.stopCapture();
      publisherManagerRef.current = null;

      // Stop audio helper if active
      const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
      if (api) {
        try { await api.stopAudio(); } catch { /* ignore */ }
      }

      setLocalStreamSession(null);
      setLocalShareState("idle");
      setIsSharing(false);
      setIsDegraded(false);
    } catch (err) {
      console.error("Stop stream failed:", err);
      setLocalShareState("idle");
      setIsSharing(false);
    }
  }, [setLocalShareState, setLocalStreamSession, setIsSharing, setIsDegraded]);

  // ── Watch Stream (placeholder — join flow not fully wired) ───────

  const handleWatchStream = useCallback(async (
    _groupId: string,
    _hostDeviceId: string,
    _logicalStreamId: string,
    _mediaSessionId: string,
    _hostName: string,
  ) => {
    console.log("[Dashboard] Watch stream:", { _groupId, _hostDeviceId, _logicalStreamId, _mediaSessionId, _hostName });
    // TODO Phase 3.5: Full join flow
    // 1. Send stream.join.request via group control
    // 2. Receive token from host
    // 3. Create ViewerClient and call view() with credentials
    alert(`Watching stream from ${_hostName} is not yet implemented in this build.`);
  }, []);

  // ── Format helpers ───────────────────────────────────────────────

  const lifecycleLabel: Record<string, string> = {
    idle: "Not streaming",
    "selecting-source": "Selecting source...",
    starting: "Starting...",
    sharing: "Streaming",
    stopping: "Stopping...",
    error: "Error",
  };

  const lifecycleClass: Record<string, string> = {
    idle: "idle",
    "selecting-source": "degraded",
    starting: "degraded",
    sharing: "sharing",
    stopping: "degraded",
    error: "error",
  };

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="dashboard">
      <h1>ScreenLink</h1>

      {/* 1. Selected Source Card */}
      <div className="card">
        <h3>Selected Source</h3>
        {sourceName ? (
          <>
            <p className="detail-row">
              <span className="label">Name:</span> {sourceName}
            </p>
            <p className="detail-row">
              <span className="label">Kind:</span> {sourceKind === "screen" ? "Screen" : "Window"}
            </p>
            <p className="detail-row">
              <span className="label">Audio:</span> {audioOptionsReady ? audioMode : "Loading..."}
            </p>
            {audioInitError && (
              <p className="dim" style={{ fontSize: "0.75rem", color: "var(--warning, #f59e0b)" }}>
                {audioInitError}
              </p>
            )}
            <div className="actions" style={{ marginTop: "0.5rem" }}>
              <button onClick={() => navigate("source-picker" as Page)}>Change Source</button>
            </div>
          </>
        ) : (
          <>
            <p className="dim">No source selected.</p>
            <div className="actions" style={{ marginTop: "0.5rem" }}>
              <button onClick={() => navigate("source-picker" as Page)}>Select Source</button>
            </div>
          </>
        )}
      </div>

      {/* 2. Group Selector */}
      <div className="card">
        <h3>Stream Target Group</h3>
        {groupList.length > 0 ? (
          <select
            value={selectedGroupId ?? ""}
            onChange={(e) => setSelectedGroupId(e.target.value || null)}
            style={{ width: "100%", marginTop: "0.25rem" }}
          >
            <option value="">-- Select a group --</option>
            {groupList.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="dim">
            No groups available.{" "}
            <a className="link" onClick={() => navigate("groups" as Page)}>
              Create or join a group
            </a>{" "}
            to start streaming.
          </p>
        )}
      </div>

      {/* 3. Start/Stop Stream */}
      <div className="card">
        <h3>Stream Control</h3>
        <div className="status-bar">
          <div className={`status-indicator ${lifecycleClass[localShareState] || "idle"}`} />
          <span>{lifecycleLabel[localShareState] || localShareState}</span>
        </div>
        <div className="actions" style={{ marginTop: "0.75rem" }}>
          {!isStreamActive && localShareState !== "stopping" ? (
            <button onClick={handleStartStream} disabled={!canStartStream}>
              {localShareState === "starting" ? "Starting..." : "Start Stream"}
            </button>
          ) : (
            <button className="danger" onClick={handleStopStream} disabled={localShareState === "stopping" || localShareState === "idle"}>
              {localShareState === "stopping" ? "Stopping..." : "Stop Stream"}
            </button>
          )}
        </div>
        {!canStartStream && localShareState === "idle" && (
          <p className="dim" style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>
            {!sourceId
              ? "Select a source first."
              : !selectedGroupId
                ? "Select a target group."
                : !audioOptionsReady
                  ? "Audio options loading..."
                  : ""}
          </p>
        )}
      </div>

      {/* 4. Local Stream Card */}
      {isStreamActive && (
        <div className="card">
          <h3>Local Stream</h3>
          <div className="detail-row">
            <span className="label">Group:</span> {selectedGroupName ?? selectedGroupId ?? "N/A"}
          </div>
          <div className="detail-row">
            <span className="label">Source:</span> {sourceName || "Unknown"}
          </div>
          <div className="detail-row">
            <span className="label">State:</span>{" "}
            <span className={`status-indicator ${isDegraded ? "degraded" : "sharing"}`} />{" "}
            {isDegraded ? "Degraded" : "Active"}
          </div>
          {localStreamSession && (
            <div className="detail-row">
              <span className="label">Session ID:</span>{" "}
              <code style={{ fontSize: "0.7rem" }}>{localStreamSession.sessionId.slice(0, 8)}...</code>
            </div>
          )}
          {viewerCount > 0 && (
            <div className="detail-row">
              <span className="label">Viewers:</span> {viewerCount}
            </div>
          )}
          <div className="actions" style={{ marginTop: "0.75rem" }}>
            <button className="danger" onClick={handleStopStream}>Stop Stream</button>
          </div>
        </div>
      )}

      {/* 5. Available Group Streams */}
      {availableGroupStreams.length > 0 && (
        <div className="card">
          <h3>Available Group Streams</h3>
          {availableGroupStreams.map(([groupId, streams]) => {
            const groupName = groupsById[groupId]?.name ?? groupId;
            return (
              <div key={groupId} style={{ marginBottom: "0.75rem" }}>
                <h4 style={{ fontSize: "0.9rem", marginBottom: "0.25rem" }}>{groupName}</h4>
                {streams.map((s) => (
                  <div
                    key={s.logicalStreamId}
                    className="card"
                    style={{ padding: "0.5rem", marginBottom: "0.25rem" }}
                  >
                    <div className="detail-row">
                      <span className="label">Host:</span> {s.hostDisplayName || s.hostDeviceId}
                    </div>
                    <div className="detail-row">
                      <span className="label">Source:</span> {s.sourceName || s.sourceKind}
                    </div>
                    <div className="detail-row">
                      <span className="label">Kind:</span> {s.sourceKind}
                    </div>
                    {watchedStreamsBySessionId[s.mediaSessionId] ? (
                      <p className="dim" style={{ fontSize: "0.75rem" }}>Already watching</p>
                    ) : (
                      <div className="actions" style={{ marginTop: "0.25rem" }}>
                        <button onClick={() => handleWatchStream(groupId, s.hostDeviceId, s.logicalStreamId, s.mediaSessionId, s.hostDisplayName || s.hostDeviceId)}>
                          Watch
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {/* 6. Watched Streams */}
      {watchedEntries.length > 0 && (
        <div className="card">
          <h3>Watched Streams</h3>
          {watchedEntries.map(([sessionId, w]) => (
            <div key={sessionId} className="card" style={{ padding: "0.5rem", marginBottom: "0.25rem" }}>
              <div className="detail-row">
                <span className="label">Host:</span> {w.hostName || w.hostDeviceId}
              </div>
              <div className="detail-row">
                <span className="label">Started:</span> {new Date(w.startedAt).toLocaleTimeString()}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 7. Connected Viewers */}
      {viewerCount > 0 && (
        <div className="card">
          <h3>Connected Viewers ({viewerCount})</h3>
          {viewers.map((v) => (
            <div key={v.peerUuid} className="detail-row" style={{ marginBottom: "0.25rem" }}>
              <span>{v.displayName || v.viewerDeviceId}</span>
              <span className="dim" style={{ marginLeft: "0.5rem", fontSize: "0.75rem" }}>
                {new Date(v.connectedAt).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Diagnostics link */}
      <div className="card" style={{ textAlign: "center" }}>
        <a className="link" onClick={() => navigate("diagnostics" as Page)}>
          Diagnostics
        </a>
      </div>
    </div>
  );
}
