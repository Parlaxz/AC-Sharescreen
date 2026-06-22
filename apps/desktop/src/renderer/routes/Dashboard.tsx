import React, { useCallback, useEffect, useRef, useState } from "react";
import { useStore, type Page } from "../stores/main-store.js";
import { generateVdoStreamId, generateVdoPassword } from "@screenlink/shared";
import { ViewerClient } from "@screenlink/vdo-adapter";
import { PublisherManager } from "../services/publisher-manager.js";
import { MediaStatsPoller, type MediaStatsSnapshot } from "../services/media-stats-service.js";

export function Dashboard() {
  const {
    // State machine states
    localShareState, remoteShareState, pairingState,
    // Friend info
    friendDisplayName, friendIsSharing,
    // Media credentials
    localMediaSessionId, localStreamId, localMediaPassword,
    remoteStreamId, remoteMediaPassword, remoteMediaSessionId,
    // Settings
    autoWatchFriend, sourceId, sourceName,
    captureWidth, captureHeight, captureFps, captureBitrate,
    // Navigation
    navigate,
    // Actions
    setLocalShareState, setRemoteShareState,
    setLocalMediaCredentials, clearLocalMediaCredentials, clearRemoteMediaCredentials,
    setSource,
  } = useStore();

  const videoRef = useRef<HTMLVideoElement>(null);
  const viewerRef = useRef<ViewerClient | null>(null);
  const publisherManagerRef = useRef<PublisherManager | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const fullscreenContainerRef = useRef<HTMLDivElement>(null);
  const portPromiseRef = useRef<Promise<MessagePort>>();
  const autoplayTriedRef = useRef(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [mediaStats, setMediaStats] = useState<MediaStatsSnapshot | null>(null);
  const [localMediaStats, setLocalMediaStats] = useState<MediaStatsSnapshot | null>(null);
  const [showIncomingSharePrompt, setShowIncomingSharePrompt] = useState(false);
  const statsPollerRef = useRef<MediaStatsPoller | null>(null);
  // Audio state
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [remoteMuted, setRemoteMuted] = useState(false);
  const [remoteVolume, setRemoteVolume] = useState(1);
  const [showEnableAudioButton, setShowEnableAudioButton] = useState(false);
  // local stats now flow through PublisherManager events

  function formatBitsTransferred(bytes: number): string {
    const bits = Math.max(0, bytes) * 8;
    if (bits >= 1_000_000_000) return `${(bits / 1_000_000_000).toFixed(2)} Gb`;
    if (bits >= 1_000_000) return `${(bits / 1_000_000).toFixed(2)} Mb`;
    if (bits >= 1_000) return `${(bits / 1_000).toFixed(2)} Kb`;
    return `${bits.toFixed(0)} b`;
  }

  async function toggleFullscreen() {
    try {
      const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
      await api?.toggleFullscreen();
    } catch (err) {
      console.warn("Fullscreen toggle failed:", err);
    }
  }

  // Restore saved source from settings on mount
  useEffect(() => {
    (async () => {
      const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
      const s = await api?.getSettings();
      if (s && s.lastSourceId && s.lastSourceName) {
        setSource(s.lastSourceId, s.lastSourceName);
      }
    })();
  }, []);

  // Initialize port promise for audio pipeline
  useEffect(() => {
    portPromiseRef.current = new Promise<MessagePort>((resolve) => {
      const handler = (event: MessageEvent) => {
        if (event.data?.type === 'pcm:port' && event.ports?.length > 0) {
          resolve(event.ports[0]);
          window.removeEventListener('message', handler);
        }
      };
      window.addEventListener('message', handler);
    });
  }, []);

  // Cleanup viewer on unmount
  useEffect(() => {
    return () => { viewerRef.current?.disconnect(); };
  }, []);

  // Sync state to tray
  useEffect(() => {
    const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
    api?.traySetSharing(localShareState === "sharing");
    api?.traySetViewing(remoteShareState === "viewing");
    api?.traySetFriendName(friendDisplayName || "");
    api?.traySetFriendSharing(friendIsSharing);
  }, [localShareState, remoteShareState, friendDisplayName, friendIsSharing]);

  // Fullscreen change listener (native Electron)
  useEffect(() => {
    const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
    const cleanup = api?.onFullscreenChanged((isFull) => {
      setIsFullscreen(isFull);
    });
    return () => cleanup?.();
  }, []);

  // Escape key exits fullscreen
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isFullscreen) {
        const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
        api?.toggleFullscreen();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isFullscreen]);

  // Sync video volume state to element
  useEffect(() => {
    const el = videoRef.current;
    if (el) el.volume = remoteVolume;
  }, [remoteVolume]);

  // Start/poll WebRTC stats when viewing
  useEffect(() => {
    if (remoteShareState === "viewing") {
      const viewer = viewerRef.current;
      const sdk = viewer?.getSDK();
      if (sdk) {
        const poller = new MediaStatsPoller();
        statsPollerRef.current = poller;
        // Get the first peer UUID from the SDK's connections map
        let peerUuid: string | null = null;
        for (const [uuid] of sdk.connections) {
          peerUuid = uuid;
          break;
        }
        poller.start(sdk, peerUuid, (stats) => {
          setMediaStats(stats);
        });
      } else {
        // SDK not ready yet; show stub so the UI card renders
        setMediaStats({
          inboundBitrateKbps: 0,
          inboundBytes: 0,
          inboundFps: 0,
          inboundWidth: 0,
          inboundHeight: 0,
          packetsLost: 0,
          jitter: 0,
          roundTripTime: 0,
          framesDropped: 0,
          freezeCount: 0,
          outboundBitrateKbps: 0,
          outboundBytes: 0,
          outboundFps: 0,
          outboundWidth: 0,
          outboundHeight: 0,
          retransmittedBytes: 0,
          nackCount: 0,
          pliCount: 0,
          qualityLimitation: "",
          isRelay: false,
          relayProtocol: "",
          currentRtt: 0,
          availableOutgoingBitrate: 0,
          codecMimeType: "",
          audioOutboundBytes: 0,
          audioOutboundPackets: 0,
          audioOutboundBitrateKbps: 0,
          audioCodec: "",
          audioSsrc: 0,
          audioLevel: 0,
          totalAudioEnergy: 0,
          totalSamplesSent: 0,
          audioInboundBytes: 0,
          audioInboundPackets: 0,
          audioInboundBitrateKbps: 0,
          audioPacketsLost: 0,
          audioJitter: 0,
          audioJitterBufferDelay: 0,
          audioConcealedSamples: 0,
          audioConcealmentEvents: 0,
          audioTotalSamplesReceived: 0,
        });
      }
    } else {
      statsPollerRef.current?.stop();
      statsPollerRef.current = null;
      setMediaStats(null);
    }
    return () => {
      statsPollerRef.current?.stop();
      statsPollerRef.current = null;
    };
  }, [remoteShareState]);

  // Local publisher stats now flow through PublisherManager onStats callback

  // ── Remote viewing functions ──────────────────────────────

  async function startViewing() {
    setRemoteShareState("connecting");
    try {
      const viewer = new ViewerClient();
      viewerRef.current = viewer;

      // Create a persistent stream for this session
      const sessionStream = new MediaStream();
      remoteStreamRef.current = sessionStream;

      viewer.on("track", async (event: unknown) => {
        const payload = (event as CustomEvent).detail as { track?: MediaStreamTrack; streams?: MediaStream[] };
        if (!payload?.track) return;

        // Add track to persistent stream (don't replace)
        if (!sessionStream.getTracks().some(t => t.id === payload.track!.id)) {
          sessionStream.addTrack(payload.track);
        }

        // Attach to video element
        if (videoRef.current) {
          videoRef.current.srcObject = sessionStream;
        }

        setRemoteShareState("viewing");

        // Attempt play() on every track addition
        if (videoRef.current && !autoplayTriedRef.current) {
          autoplayTriedRef.current = true;
          try {
            await videoRef.current.play();
          } catch {
            setShowEnableAudioButton(true);
          }
        }
      });

      await viewer.createAndConnect(remoteMediaPassword);
      await viewer.view(remoteStreamId, "Desktop User");
    } catch (err) {
      console.error("Remote view failed:", err);
      setRemoteShareState("error");
    }
  }

  async function stopViewing() {
    await viewerRef.current?.stopViewing();
    await viewerRef.current?.disconnect();
    viewerRef.current = null;
    remoteStreamRef.current = null;
    autoplayTriedRef.current = false;
    if (videoRef.current) videoRef.current.srcObject = null;
    clearRemoteMediaCredentials();
    setRemoteShareState("remote-online-idle");
    setShowEnableAudioButton(false);
    setRemoteMuted(false);
    setRemoteVolume(1);
    setAudioEnabled(false);
  }

  // Show a prompt when remote share becomes available by default.
  useEffect(() => {
    if (remoteShareState === "remote-share-available" && remoteStreamId && remoteMediaPassword) {
      if (autoWatchFriend) {
        startViewing();
      } else {
        setShowIncomingSharePrompt(true);
      }
    }
    if (remoteShareState !== "remote-share-available") {
      setShowIncomingSharePrompt(false);
    }
  }, [remoteShareState, remoteStreamId, remoteMediaPassword, autoWatchFriend]);

  // ── Sharing handlers ──────────────────────────────────────

  const handleShareScreen = useCallback(async (withAudio?: boolean) => {
    setLocalShareState("selecting-source");
    try {
      if (!sourceId) {
        navigate("source-picker" as Page);
        return;
      }
      setLocalShareState("starting");

      const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
      await api?.setSource(sourceId);

      // Generate ephemeral credentials
      const sessionId = crypto.randomUUID();
      const streamId = generateVdoStreamId();
      const password = generateVdoPassword();
      setLocalMediaCredentials(sessionId, streamId, password);

      const mgr = new PublisherManager({
        onStateChange: (state) => setLocalShareState(state),
        onStats: (stats) => setLocalMediaStats(stats),
        onError: (err) => console.error("Publisher error:", err),
        onTrackEnded: () => handleStopSharing(),
      });
      publisherManagerRef.current = mgr;

      // If sharing with audio, set up audio pipeline before publishing
      if (withAudio) {
        setAudioEnabled(true);

        // Step 1: Request PCM port from main process
        await api?.requestAudioPort();

        // Step 2: Wait for the MessagePort from main process
        const port = await portPromiseRef.current!;

        // Step 3: Create AudioContext + worklet, wait for priming
        const { ProcessAudioController } = await import("../audio/ProcessAudioController.js");
        const controller = new ProcessAudioController();
        await controller.initialize(port);

        // Step 4: Now that renderer is ready, start native capture
        await api?.startSyntheticAudio(0);

        // Step 5: Set audio controller on publisher manager
        mgr.setAudioController(controller);
      }

      const stream = await mgr.startCapture({
        sourceId, password, streamId,
        videoBitrate: captureBitrate,
        videoWidth: captureWidth,
        videoHeight: captureHeight,
        videoFps: captureFps,
      });
      await mgr.startPublishing(stream, {
        sourceId, password, streamId,
        videoBitrate: captureBitrate,
        videoWidth: captureWidth,
        videoHeight: captureHeight,
        videoFps: captureFps,
      });

      // Notify remote peer
      const { getControlConnection } = await import("../services/control-connection.js");
      getControlConnection().sendShareStarted();
    } catch (err) {
      console.error("Share failed:", err);
      setLocalShareState("error");
      publisherManagerRef.current?.stopCapture().catch(() => {});
      publisherManagerRef.current = null;
      // Also stop audio if it was started
      const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
      api?.stopAudio().catch(() => {});
    }
  }, [sourceId, captureWidth, captureHeight, captureFps, captureBitrate, navigate, setLocalMediaCredentials]);

  const handleShareScreenWithAudio = useCallback(
    () => handleShareScreen(true),
    [handleShareScreen],
  );

  const handleShareWindow = useCallback(async () => {
    navigate("source-picker" as Page);
  }, [navigate]);

  const handleStopSharing = useCallback(async () => {
    setLocalShareState("stopping");
    const { getControlConnection } = await import("../services/control-connection.js");
    getControlConnection().sendShareStopped();
    await publisherManagerRef.current?.stopCapture();
    publisherManagerRef.current = null;
    clearLocalMediaCredentials();

    // Stop audio helper
    const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
    if (api) {
      try {
        await api.stopAudio();
      } catch { /* ignore */ }
    }

    setLocalShareState("idle");
  }, [clearLocalMediaCredentials]);

  async function handleEnableAudio() {
    if (!videoRef.current) return;
    try {
      await videoRef.current.play();
      setShowEnableAudioButton(false);
    } catch {
      // Still blocked
    }
  }

  // ── Render ────────────────────────────────────────────────

  return (
    <div className="dashboard">
      <h1>ScreenLink</h1>

      {/* Connection status */}
      <div className="card">
        <div className="status-bar">
          <div className={`status-indicator ${pairingState === "PAIRED_ONLINE" ? "sharing" : pairingState === "error" ? "error" : "idle"}`} />
          <span>{
            pairingState === "PAIRED_ONLINE" ? (friendDisplayName || "Online") :
            pairingState === "PAIRED_OFFLINE" ? (friendDisplayName || "Friend") + " (offline)" :
            pairingState === "PAIR_CREATED_WAITING_FOR_IMPORT" ? "Waiting for friend to import..." :
            pairingState === "PAIR_IMPORTED_CONNECTING" ? "Connecting..." :
            pairingState === "PAIR_CONNECTED_UNCONFIRMED" ? "Connected, handshaking..." :
            pairingState === "error" ? "Error" :
            "Not paired"
          }</span>
        </div>
        {(pairingState === "unpaired" || pairingState === "") && (
          <p className="dim" style={{ marginTop: "0.5rem" }}>Go to <a className="link" onClick={() => navigate("settings" as Page)}>Settings</a> to pair with a friend.</p>
        )}
      </div>

      {/* My Sharing */}
      <div className="card">
        <h3>My Sharing</h3>
        <div className="status-bar">
          <div className={`status-indicator ${localShareState === "sharing" ? "sharing" : localShareState === "error" ? "error" : "idle"}`} />
          <span>{localShareState === "sharing" ? "Sharing" : localShareState === "starting" ? "Starting..." : localShareState === "stopping" ? "Stopping..." : localShareState === "error" ? "Error" : "Not sharing"}</span>
        </div>
        {sourceName && <p className="dim">Source: {sourceName}</p>}
        <div className="actions" style={{ marginTop: "0.75rem" }}>
          {localShareState !== "sharing" ? (
            <>
              <button onClick={handleShareScreen}>Share Screen</button>
              <button onClick={handleShareWindow}>Share Window</button>
              <button onClick={handleShareScreenWithAudio} className="ghost">
                🎵 Share with Audio (Dev)
              </button>
            </>
          ) : (
            <button className="danger" onClick={handleStopSharing}>Stop Sharing</button>
          )}
        </div>
        {localShareState === "sharing" && localMediaStats && (
          <div className="stats-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.25rem", fontSize: "0.75rem", marginTop: "0.75rem" }}>
            <span>Bitrate: {(localMediaStats.outboundBitrateKbps || 0).toFixed(0)} kbps</span>
            <span>Resolution: {localMediaStats.outboundWidth}×{localMediaStats.outboundHeight}</span>
            <span>FPS: {localMediaStats.outboundFps}</span>
            <span>Total transferred: {formatBitsTransferred(localMediaStats.outboundBytes || 0)}</span>
          </div>
        )}
      </div>

      {/* Remote viewing */}
      <div className="card">
        <h3>Remote Stream {friendDisplayName ? `- ${friendDisplayName}` : ""}</h3>
        <div className="status-bar">
          <div className={`status-indicator ${remoteShareState === "viewing" ? "sharing" : remoteShareState === "remote-share-available" ? "degraded" : remoteShareState === "error" ? "error" : "idle"}`} />
          <span>{
            remoteShareState === "remote-offline" ? "Friend offline" :
            remoteShareState === "remote-online-idle" ? "Online, idle" :
            remoteShareState === "remote-share-available" ? "Share available" :
            remoteShareState === "connecting" ? "Connecting..." :
            remoteShareState === "viewing" ? "Viewing" :
            remoteShareState === "reconnecting" ? "Reconnecting..." :
            remoteShareState === "error" ? "Error" : "---"
          }</span>
        </div>
        <div className="actions" style={{ marginTop: "0.75rem" }}>
          {remoteShareState === "remote-share-available" && remoteShareState !== "viewing" && (
            <button onClick={startViewing}>Watch</button>
          )}
          {remoteShareState === "viewing" && (
            <button className="danger" onClick={stopViewing}>Stop Watching</button>
          )}
        </div>

        {showIncomingSharePrompt && remoteShareState === "remote-share-available" && (
          <div className="card" style={{ marginTop: "0.75rem", border: "1px solid var(--accent, #3b82f6)" }}>
            <h4>{friendDisplayName || "Your friend"} is streaming</h4>
            <p className="dim" style={{ marginTop: "0.25rem" }}>Choose whether to start watching.</p>
            <div className="actions" style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem" }}>
              <button onClick={() => { setShowIncomingSharePrompt(false); startViewing(); }}>Watch</button>
              <button className="ghost" onClick={() => setShowIncomingSharePrompt(false)}>Not now</button>
            </div>
          </div>
        )}

        {/* Video player */}
        <div ref={fullscreenContainerRef} className="card" style={{
          padding: 0, overflow: "hidden", position: isFullscreen ? "fixed" : "relative",
          top: isFullscreen ? 0 : undefined,
          left: isFullscreen ? 0 : undefined,
          width: isFullscreen ? "100vw" : undefined,
          height: isFullscreen ? "100vh" : undefined,
          zIndex: isFullscreen ? 9999 : undefined,
          background: "#000",
          display: "flex", alignItems: "center", justifyContent: "center",
          marginTop: isFullscreen ? 0 : "0.75rem",
          borderRadius: isFullscreen ? 0 : undefined,
          border: isFullscreen ? "none" : undefined,
        }}>
          <video ref={videoRef} autoPlay playsInline
            muted={remoteMuted}
            onDoubleClick={toggleFullscreen}
            style={{ width: "100%", height: "100%", display: remoteShareState === "viewing" ? "block" : "none", background: "#000", objectFit: "contain", cursor: "pointer" }} />
          {remoteShareState === "viewing" && (
            <button className="ghost" onClick={toggleFullscreen}
              style={{
                position: "absolute", top: "0.5rem", right: "0.5rem",
                background: "rgba(0,0,0,0.6)", color: "#fff",
                fontSize: "0.75rem", padding: "0.25rem 0.5rem",
                borderRadius: "4px", border: "none", cursor: "pointer",
                zIndex: 10,
              }}>
              {isFullscreen ? "✕ Exit Fullscreen" : "⛶ Fullscreen"}
            </button>
          )}
          {/* Audio controls (mute/volume) */}
          {remoteShareState === "viewing" && (
            <div className="audio-controls" style={{ position: "absolute", bottom: "0.5rem", left: "0.5rem", display: "flex", gap: "0.5rem", alignItems: "center", background: "rgba(0,0,0,0.6)", padding: "0.25rem 0.5rem", borderRadius: "4px", zIndex: 10 }}>
              <button onClick={() => setRemoteMuted(!remoteMuted)} className="ghost" style={{ color: "#fff", fontSize: "0.75rem", padding: "0.25rem 0.5rem", border: "none", cursor: "pointer" }}>
                {remoteMuted ? "🔇 Unmute" : "🔊 Mute"}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={remoteVolume}
                onChange={(e) => setRemoteVolume(parseFloat(e.target.value))}
                style={{ width: "80px" }}
                aria-label="Volume"
              />
              <span style={{ color: "#fff", fontSize: "0.7rem" }}>
                {Math.round(remoteVolume * 100)}%
              </span>
            </div>
          )}
          {/* Enable Audio button shown when autoplay is blocked */}
          {showEnableAudioButton && remoteShareState === "viewing" && (
            <button onClick={handleEnableAudio} className="ghost"
              style={{ position: "absolute", bottom: "0.5rem", right: "0.5rem", background: "rgba(0,0,0,0.6)", color: "#fff", fontSize: "0.75rem", padding: "0.25rem 0.5rem", borderRadius: "4px", border: "none", cursor: "pointer", zIndex: 10 }}>
              🔈 Enable Audio
            </button>
          )}
          {remoteShareState !== "viewing" && (
            <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-dim)" }}>
              <p>Remote stream will appear here when your friend shares.</p>
            </div>
          )}
        </div>

        {/* Stream Stats */}
        {remoteShareState === "viewing" && mediaStats && (
          <div className="card" style={{ marginTop: "0.75rem" }}>
            <h4>Stream Stats</h4>
            <div className="stats-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.25rem", fontSize: "0.75rem" }}>
              <span>Bitrate: {(mediaStats.inboundBitrateKbps || 0).toFixed(0)} kbps</span>
              <span>Resolution: {mediaStats.inboundWidth}×{mediaStats.inboundHeight}</span>
              <span>FPS: {mediaStats.inboundFps}</span>
              <span>RTT: {(mediaStats.roundTripTime * 1000 || 0).toFixed(0)} ms</span>
              <span>Packet loss: {mediaStats.packetsLost}</span>
              <span>Jitter: {(mediaStats.jitter || 0).toFixed(2)} ms</span>
              <span>Dropped frames: {mediaStats.framesDropped}</span>
              <span>Total transferred: {formatBitsTransferred(mediaStats.inboundBytes || 0)}</span>
              <span>Path: {mediaStats.isRelay ? `TURN Relay (${mediaStats.relayProtocol})` : "Direct P2P/STUN"}</span>
              <span>Codec: {mediaStats.codecMimeType.replace("video/", "")}</span>
              {/* Audio stats */}
              {(mediaStats.audioInboundBitrateKbps || 0) > 0 && (
                <>
                  <span>Audio Bitrate: {(mediaStats.audioInboundBitrateKbps || 0).toFixed(0)} kbps</span>
                  <span>Audio Codec: {(mediaStats.audioCodec || "N/A").replace("audio/", "")}</span>
                  <span>Audio Jitter: {((mediaStats.audioJitter || 0) * 1000).toFixed(0)} ms</span>
                  <span>Audio Loss: {mediaStats.audioPacketsLost || 0}</span>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
