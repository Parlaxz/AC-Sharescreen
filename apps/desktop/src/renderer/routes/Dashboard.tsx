import { useEffect, useState, useCallback, useRef } from "react";
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
import { ViewerClient } from "@screenlink/vdo-adapter";

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
    // View mode
    isViewing, viewStatus,
    // Navigation
    navigate,
    // Actions
    setLocalShareState, setLocalStreamSession,
    setSelectedGroupId, setIsSharing, setIsDegraded,
    setIsViewing, setViewStatus,
    setWatchedStreams,
  } = useStore();

  // Refs for media rendering
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // ── Audio derived mode display ──────────────────────────────
  const [audioMode, setAudioMode] = useState<AudioMode>('none');
  const [audioOptionsReady, setAudioOptionsReady] = useState(false);
  const [audioInitError, setAudioInitError] = useState<string | null>(null);

  // Viewer client ref for active watch session
  const viewerClientRef = useRef<ViewerClient | null>(null);

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

  // ── Start Stream (Stage 4: via StreamSessionManager) ───────────

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

      const ssm = runtime.getStreamSessionManager();

      // 1. Start stream via StreamSessionManager (handles capture, publish, register, heartbeat)
      await ssm.startStream({
        groupId: selectedGroupId,
        source: {
          id: sourceId,
          name: sourceName || "Screen",
          kind: sourceKind ?? "screen",
          displayId: null,
          fingerprint: null,
        },
      });

      // 2. Store local session credentials from SSM
      const vdoConfig = ssm.getCurrentVdoConfig();
      if (vdoConfig) {
        setLocalStreamSession({
          sessionId: crypto.randomUUID(),
          streamId: vdoConfig.streamId,
          password: vdoConfig.password,
        });
      }

      // 3. Audio setup (if audio mode is active)
      // Audio controller is set via ssm.setAudioController() if available
      // This is handled separately via IPC calls to the audio helper.
      // For now, audio is optional and can be set after stream starts.

      setLocalShareState("sharing");
      setIsSharing(true);
    } catch (err) {
      console.error("Start stream failed:", err);
      setLocalShareState("error");
    }
  }, [sourceId, sourceName, sourceKind, selectedGroupId, localShareState, captureWidth, captureHeight, captureFps, captureBitrate, setLocalShareState, setLocalStreamSession, setIsSharing]);

  // ── Stop Stream (Stage 4: via StreamSessionManager) ────────────

  const handleStopStream = useCallback(async () => {
    setLocalShareState("stopping");
    try {
      const runtime = getRuntime();
      if (runtime) {
        await runtime.getStreamSessionManager().stopStream();
      }

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

  // ── Watch Stream (Stage 5: real join flow) ─────────────────────

  const handleWatchStream = useCallback(async (
    groupId: string,
    hostDeviceId: string,
    logicalStreamId: string,
    mediaSessionId: string,
    hostName: string,
  ) => {
    if (isViewing) return;
    setIsViewing(true);
    setViewStatus("requesting join...");

    try {
      const runtime = getRuntime();
      if (!runtime) {
        setViewStatus("error: runtime not initialized");
        setIsViewing(false);
        return;
      }

      const connManager = runtime.getConnectionManager();
      const conn = connManager.getConnection(groupId);
      if (!conn) {
        setViewStatus("error: not connected to group");
        setIsViewing(false);
        return;
      }

      // 1. Send stream.join.request via group control with requestId
      const peerUuid = conn.peerForDevice(hostDeviceId);
      if (!peerUuid) {
        setViewStatus("error: host not connected");
        setIsViewing(false);
        return;
      }

      const requestId = crypto.randomUUID();
      await conn.sendToPeer(peerUuid, {
        type: "stream.join.request",
        logicalStreamId,
        viewerDeviceId: runtime.deviceId ?? "unknown",
        viewerDisplayName: runtime.displayName ?? "Viewer",
        requestId,
      });

      // 2. Wait for stream.join.response via the message router
      setViewStatus("waiting for host response...");
      const response = await runtime.waitForJoinResponse(requestId, 30_000);

      if (!response.accepted) {
        setViewStatus(`join rejected: ${response.reason ?? "unknown reason"}`);
        setIsViewing(false);
        return;
      }

      // 3. Response accepted — extract media credentials from response
      const joinToken = response.mediaJoinMetadata;
      const responseMediaSessionId = response.mediaSessionId ?? mediaSessionId;
      if (!joinToken) {
        setViewStatus("error: no join token in response");
        setIsViewing(false);
        return;
      }

      setViewStatus("connecting to media...");

      // 4. Create ViewerClient and connect to media stream
      // The viewer connects to the VDO stream using the host's VDO credentials
      // returned in the join response (streamId for view(), password for createAndConnect()).
      const viewerClient = new ViewerClient();

      // Register event handler for receiving media tracks
      (viewerClient as unknown as { on: (event: string, listener: (...args: unknown[]) => void) => void }).on("remoteAdded", () => {
        // Media has been received — update UI state
        setWatchedStreams((prev) => ({
          ...prev,
          [responseMediaSessionId]: {
            hostDeviceId,
            hostName,
            startedAt: Date.now(),
          },
        }));
        setViewStatus("watching");
      });

      // Register track event to attach received media to video element
      (viewerClient as unknown as { on: (event: string, listener: (...args: unknown[]) => void) => void }).on("track", (...args: unknown[]) => {
        const [track, stream] = args as [MediaStreamTrack, MediaStream];
        if (track?.kind === "video" && videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      });

      // Connect to VDO using the VDO password from the join response.
      // Fall back to mediaSessionId only if password was not provided
      // (backward compat with older hosts not yet sending credentials).
      const vdoPassword = response.password ?? responseMediaSessionId;
      await viewerClient.createAndConnect(vdoPassword);

      // View the stream using the VDO stream ID from the join response.
      // Fall back to logicalStreamId only if streamId was not provided.
      const vdoStreamId = response.streamId ?? logicalStreamId;
      await viewerClient.view(vdoStreamId, runtime.displayName ?? "Viewer");

      // 5. Send media.bind via the media SDK data channel so the host
      // receives it with the actual media peer UUID
      const sdk = viewerClient.getSDK();
      if (sdk && joinToken) {
        // Find the publisher's peer UUID in the SDK connections
        for (const [publisherUuid] of sdk.connections) {
          try {
            await viewerClient.sendMediaBind(publisherUuid, joinToken, responseMediaSessionId);
          } catch { /* one will succeed */ }
        }
      }

      // Store the viewer client for cleanup
      viewerClientRef.current = viewerClient;

      // If media already arrived before we finished setup, update state
      if (sdk) {
        setWatchedStreams((prev: Record<string, { hostDeviceId: string; hostName: string; startedAt: number }>) => {
          if (prev[responseMediaSessionId]) return prev; // already set by event handler
          return {
            ...prev,
            [responseMediaSessionId]: {
              hostDeviceId,
              hostName,
              startedAt: Date.now(),
            },
          };
        });
        setViewStatus("watching");
      }
    } catch (err) {
      console.error("[Dashboard] Watch stream failed:", err);
      setViewStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
      setIsViewing(false);
      // Clean up viewer client if created
      if (viewerClientRef.current) {
        try {
          viewerClientRef.current.stopViewing().catch(() => {});
          viewerClientRef.current.disconnect().catch(() => {});
        } catch { /* ignore */ }
        viewerClientRef.current = null;
      }
    }
  }, [isViewing, setIsViewing, setViewStatus, setWatchedStreams]);

  // ── Stop Watching ──────────────────────────────────────────────

  const handleStopWatching = useCallback(async (sessionId: string) => {
    // Disconnect ViewerClient if active
    if (viewerClientRef.current) {
      try {
        await viewerClientRef.current.stopViewing();
        await viewerClientRef.current.disconnect();
      } catch (err) {
        console.warn("[Dashboard] ViewerClient disconnect error:", err);
      }
      viewerClientRef.current = null;
    }

    // Clean up video element
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }

    // Clean up watched state
    const updated = { ...watchedStreamsBySessionId };
    delete updated[sessionId];
    setWatchedStreams(updated);

    setIsViewing(false);
    setViewStatus("");
  }, [watchedStreamsBySessionId, setWatchedStreams, setIsViewing, setViewStatus]);

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
              <button onClick={() => navigate("share-setup")}>Change Source</button>
            </div>
          </>
        ) : (
          <>
            <p className="dim">No source selected.</p>
            <div className="actions" style={{ marginTop: "0.5rem" }}>
              <button onClick={() => navigate("share-setup")}>Select Source</button>
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
            <a className="link" onClick={() => navigate("home")}>
              Create or join a group
            </a>{" "}
            to start streaming.
          </p>
        )}
      </div>
    </div>
  );
}
