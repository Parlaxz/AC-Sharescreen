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
  const [audioMode, setAudioMode] = useState<'none' | 'system' | 'application' | 'monitor' | 'test-tone'>('none');
  const [appliedAudioMode, setAppliedAudioMode] = useState<'none' | 'system' | 'application' | 'monitor' | 'test-tone'>('none');
  const [audioError, setAudioError] = useState<string | null>(null);
  const [audioIsSynthetic, setAudioIsSynthetic] = useState(false);
  const [capAudioModes, setCapAudioModes] = useState<Record<string, boolean> | null>(null);
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
          console.warn("[Audio] Setup failed, continuing video-only:", err);
          // Emit pipeline snapshot for diagnostics
          try {
            const snapshot = await api?.getPipelineSnapshot?.();
            console.warn("[Audio-Pipeline] Full snapshot:", JSON.stringify(snapshot));
          } catch { /* best effort */ }
          setAudioEnabled(false);
          try { api?.stopAudio(); } catch { /* ignore */ }
        }
  }

  // Restore saved source and audio mode from settings on mount; load capabilities
  useEffect(() => {
    (async () => {
      const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
      const s = await api?.getSettings();
      if (s && s.lastSourceId && s.lastSourceName) {
        setSource(s.lastSourceId, s.lastSourceName);
      }
      let resolvedMode: 'none' | 'system' | 'application' | 'monitor' | 'test-tone' = 'none';
      if (s && s.lastAudioMode) {
        resolvedMode = s.lastAudioMode;
        setAudioMode(resolvedMode);
      }

      // Load capability model to drive UI mode availability
      try {
        const capsResp = await api?.getAudioCapabilities();
        if (capsResp?.success && capsResp.data) {
          const { getAudioModeInfo } = await import("@screenlink/shared");
          const modes = getAudioModeInfo(capsResp.data);
          const modeMap: Record<string, boolean> = {};
          for (const m of modes) {
            modeMap[m.mode] = m.supported;
          }
          setCapAudioModes(modeMap);

          // If the persisted mode is unsupported on this build, override to 'none'
          if (modeMap[resolvedMode] === false) {
            resolvedMode = 'none';
            setAudioMode('none');
          }
        }
      } catch { /* best effort */ }
    })();
  }, []);

  // Cleanup viewer on unmount
  useEffect(() => {
    return () => { viewerRef.current?.disconnect(); };
  }, []);

  // ── Audio port promise (fresh listener per share attempt) ──

  function waitForNextAudioPort(): Promise<MessagePort> {
    return new Promise<MessagePort>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        window.removeEventListener('message', handler);
        reject(new Error('Audio port timeout'));
      }, 5000);

      const handler = (event: MessageEvent) => {
        if (event.data?.type !== 'pcm:port' || !event.ports?.[0]) return;
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        resolve(event.ports[0]);
      };

      window.addEventListener('message', handler);
    });
  }

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

  /**
   * Development-only synthetic audio fallback.
   * Only activates when all conditions are met:
   * - Running in dev mode (import.meta.env.DEV)
   * - The user has explicitly enabled useSyntheticAudioFallback in settings
   * - Real capture just failed
   * Never activates in production.
   * Returns 'synthetic' on success, 'none' if fallback not applicable or failed.
   */
  async function attemptDevSyntheticFallback(
    api: import("../../preload/api-types.js").ScreenLinkAPI | undefined | null,
    captureError: string | undefined,
  ): Promise<'synthetic' | 'none'> {
    // Production: never auto-substitute
    if (!import.meta.env.DEV) return 'none';

    try {
      const settings = await api?.getSettings();
      if (!settings || !('useSyntheticAudioFallback' in settings) || !(settings as any).useSyntheticAudioFallback) {
        return 'none';
      }
    } catch {
      return 'none';
    }

    console.warn("[Audio] Real capture failed, attempting dev fallback to synthetic:", captureError);
    const result = await api?.startSyntheticAudio();
    if (!result || !result.success) {
      console.warn("[Audio] Dev synthetic fallback also failed:", result?.error);
      return 'none';
    }
    return 'synthetic';
  }

  const handleShareScreen = useCallback(async () => {
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

      // Source validation and capability check for audio mode
      let effectiveAudioMode = audioMode;
      if (audioMode === 'application' && sourceId && !sourceId.startsWith('window:')) {
        console.warn("[Audio] Application audio requires a window source, not a screen");
        effectiveAudioMode = 'none';
        setAudioMode('none');
      } else if (audioMode === 'application' && !sourceId) {
        effectiveAudioMode = 'none';
        setAudioMode('none');
      } else if (capAudioModes && capAudioModes[audioMode] === false) {
        // Capability check: if the selected mode is unsupported on this build, fall back
        console.warn(`[Audio] Mode "${audioMode}" is unsupported on this build, falling back to none`);
        effectiveAudioMode = 'none';
        setAudioMode('none');
      }

      // Audio setup (best-effort, failure does not block video-only sharing)
      let audioConfigured = false;
      setAudioError(null);
      setAppliedAudioMode('none');
      setAudioIsSynthetic(false);

      // ── Test Tone mode: explicit synthetic, no fallback ──────────────
      // Uses a provisional controller: created, validated, and only attached
      // to the publisher after priming AND rendering (nonzero output) succeed.
      if (effectiveAudioMode === 'test-tone') {
        let provisionalController: ProcessAudioController | null = null;
        setAudioEnabled(true);

        try {
          const portPromise = waitForNextAudioPort();
          const portResult = await api?.requestAudioPort();
          if (!portResult || !portResult.success) {
            throw new Error(portResult?.error || 'Audio helper unavailable');
          }
          const port = await portPromise;

          const { ProcessAudioController } = await import("../audio/ProcessAudioController.js");
          provisionalController = new ProcessAudioController();
          await provisionalController.initialize(port);

          const result = await api?.startSyntheticAudio();
          if (!result || !result.success) {
            throw new Error(result?.error ?? 'Test tone could not start');
          }

          setAudioIsSynthetic(true);
          setAppliedAudioMode('test-tone');

          // Wait for ring buffer to fill (primed)
          await provisionalController.waitUntilPrimed();
          console.log('[Audio] Test tone primed');

          // Wait for nonzero output (rendering) — confirms worklet output path works
          await provisionalController.waitUntilRendering();
          console.log('[Audio] Test tone rendering confirmed');

          // Sample analyser to verify nonzero audio in the graph
          const analyserReading = provisionalController.sampleAnalyser('pre-publish');
          if (!analyserReading || analyserReading.peak === 0) {
            console.warn('[Audio] Analyser shows zero peak before publish — Test Tone may be silent');
          } else {
            console.log('[Audio] Analyser OK — peak:', analyserReading.peak, 'rms:', analyserReading.rms);
          }

          // All validation passed — attach controller to publisher
          const testToneTrack = provisionalController.getTrack();
          if (!testToneTrack || testToneTrack.readyState !== 'live') {
            throw new Error('test-tone-output-track-not-live');
          }
          console.log('[Audio] transferring controller', {
            controllerId: provisionalController.getInstanceId(),
            trackId: testToneTrack.id,
            trackKind: testToneTrack.kind,
            trackReadyState: testToneTrack.readyState,
          });
          mgr.setAudioController(provisionalController, 'test-tone');
          provisionalController = null; // ownership transferred
          console.log('[Audio] provisionalControllerReleased=true');
          audioConfigured = true;
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          setAudioError(errorMsg);
          console.warn("[Audio] Test tone setup failed:", err);

          // Full cleanup of provisional controller
          if (provisionalController) {
            try { await provisionalController.close(); } catch { /* ignore */ }
            provisionalController = null;
            mgr.clearAudioController();
            try { await api?.stopAudio(); } catch { /* ignore */ }
          }
          setAudioEnabled(false);
        }
      }

      // ── Real capture modes: system audio, application, or filtered monitor ──
      if (effectiveAudioMode !== 'none' && effectiveAudioMode !== 'test-tone') {
        let provisionalController: ProcessAudioController | null = null;
        setAudioEnabled(true);

        try {
          const portPromise = waitForNextAudioPort();
          const portResult = await api?.requestAudioPort();
          if (!portResult || !portResult.success) {
            throw new Error(portResult?.error || 'Audio helper unavailable');
          }
          const port = await portPromise;

          const { ProcessAudioController } = await import("../audio/ProcessAudioController.js");
          provisionalController = new ProcessAudioController();
          await provisionalController.initialize(port);

          // Start capture — check result BEFORE priming
          console.log(`[Audio] requestedMode=${effectiveAudioMode}`);
          let captureResult: { success: boolean; error?: string; streamGeneration?: number } | undefined;

          // Explicit switch: every audio mode must have its own branch.
          // NEVER fall through to a default that aliases one mode to another.
          switch (effectiveAudioMode) {
            case 'system': {
              console.log('[Audio] ipcCommand=audio:start-system');
              captureResult = await api?.startSystemAudio() as { success: boolean; error?: string; streamGeneration?: number } | undefined;
              console.log(`[Audio] captureResult=`, JSON.stringify(captureResult));
              break;
            }
            case 'application': {
              captureResult = await api?.startApplicationAudio({ sourceId }) as { success: boolean; error?: string; streamGeneration?: number } | undefined;
              break;
            }
            case 'monitor': {
              captureResult = await api?.startFilteredMonitorAudio({
                excludeDiscord: true,
                excludeScreenLink: true,
              }) as { success: boolean; error?: string; streamGeneration?: number } | undefined;
              break;
            }
            default:
              throw new Error(`Unsupported audio mode: ${effectiveAudioMode}`);
          }

          if (!captureResult || !captureResult.success) {
            // Real capture failed — development-only synthetic fallback
            const fallbackResult = await attemptDevSyntheticFallback(api, captureResult?.error);
            if (fallbackResult === 'synthetic') {
              setAudioIsSynthetic(true);
              await provisionalController.waitUntilPrimed();
              // Real audio does not require waitUntilRendering (source may be legitimately silent)
              mgr.setAudioController(provisionalController, 'test-tone');
              provisionalController = null;
              audioConfigured = true;
              console.log('[Audio] Using synthetic fallback audio');
            } else {
              // Real audio failure with no synthetic fallback — continue video-only
              console.warn('[Audio] Real audio capture failed, continuing video-only:', captureResult?.error ?? 'unknown');
              setAppliedAudioMode('none');
              if (provisionalController) {
                try { await provisionalController.close(); } catch { /* ignore */ }
                provisionalController = null;
              }
              mgr.clearAudioController();
              try { await api?.stopAudio(); } catch { /* ignore */ }
              setAudioEnabled(false);
              captureResult = undefined;
            }
          } else {
            // Real capture succeeded
            console.log(`[Audio] appliedMode=${effectiveAudioMode} streamGeneration=${captureResult.streamGeneration ?? '(not set)'}`);
            setAppliedAudioMode(effectiveAudioMode);

            if (typeof captureResult.streamGeneration === 'number' && Number.isSafeInteger(captureResult.streamGeneration)) {
              provisionalController.setStreamGeneration(captureResult.streamGeneration);
            }

            if (effectiveAudioMode === 'test-tone') {
              setAudioIsSynthetic(true);
              // Test Tone requires nonzero rendering before publication
              await provisionalController.waitUntilRendering();
            } else {
              setAudioIsSynthetic(false);
              // Real audio (system/application/monitor) does not require waitUntilRendering
              // because the source may be legitimately silent
              await provisionalController.waitUntilPrimed();
            }

            console.log(`[Publisher] audioTracks=${mgr.getAudioTrack() ? 1 : 0}`);
            const outputTrack = provisionalController.getTrack();
            if (!outputTrack) {
              throw new Error('system-audio-output-track-missing');
            }
            if (outputTrack.kind !== 'audio') {
              throw new Error('system-audio-output-track-wrong-kind');
            }
            if (outputTrack.readyState !== 'live') {
              throw new Error(`system-audio-output-track-${outputTrack.readyState}`);
            }
            console.log('[Audio] transferring controller', {
              controllerId: provisionalController.getInstanceId?.() ?? 'unknown',
              trackId: outputTrack.id,
              trackKind: outputTrack.kind,
              trackReadyState: outputTrack.readyState,
            });
            mgr.setAudioController(provisionalController, effectiveAudioMode);
            provisionalController = null;
            console.log('[Audio] provisionalControllerReleased=true');
            audioConfigured = true;
          }

        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          setAudioError(errorMsg);
          console.warn("[Audio] Setup failed, continuing video-only:", err);

          if (provisionalController) {
            try { await provisionalController.close(); } catch { /* ignore */ }
            provisionalController = null;
            mgr.clearAudioController();
            try { await api?.stopAudio(); } catch { /* ignore */ }
          }
          setAudioEnabled(false);
        }
      }

      // ── Video capture + publishing (regardless of audio success) ────
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

      // Persist audio mode preference (user's intent, not applied mode)
      try {
        const settings = await api?.getSettings();
        if (settings && settings.lastAudioMode !== audioMode) {
          await api?.updateSettings({ lastAudioMode: audioMode });
        }
      } catch { /* ignore */ }
    } catch (err) {
      console.error("Share failed:", err);
      setLocalShareState("error");
      publisherManagerRef.current?.stopCapture().catch(() => {});
      publisherManagerRef.current = null;
      // Also stop audio if it was started
      const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
      api?.stopAudio().catch(() => {});
    }
  }, [sourceId, captureWidth, captureHeight, captureFps, captureBitrate, navigate, setLocalMediaCredentials, audioMode, setAudioError, setAppliedAudioMode, setAudioIsSynthetic]);

  const handleShareScreenWithAudio = useCallback(
    () => handleShareScreen(),
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
    setAudioError(null);
    setAppliedAudioMode('none');
    setAudioIsSynthetic(false);
  }, [clearLocalMediaCredentials, setAudioError, setAppliedAudioMode, setAudioIsSynthetic]);

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
                <div className="card" style={{ marginTop: "0.5rem", padding: "0.5rem" }}>
                <h4>Audio</h4>
                <label>
                  <input type="radio" name="audioMode" value="none" checked={audioMode === 'none'}
                    onChange={() => setAudioMode('none')} /> No Audio
                </label>
                <label style={{ marginLeft: "1rem" }}>
                  <input type="radio" name="audioMode" value="system" checked={audioMode === 'system'}
                    disabled={capAudioModes?.['system'] === false}
                    onChange={() => setAudioMode('system')} /> System Audio
                </label>
                <label style={{ marginLeft: "1rem" }}>
                  <input type="radio" name="audioMode" value="application" checked={audioMode === 'application'}
                    disabled={capAudioModes?.['application'] === false}
                    onChange={() => setAudioMode('application')} /> App Audio (window only)
                </label>
                <label style={{ marginLeft: "1rem" }}>
                  <input type="radio" name="audioMode" value="monitor" checked={audioMode === 'monitor'}
                    disabled={capAudioModes?.['monitor'] === false}
                    onChange={() => setAudioMode('monitor')} /> Filtered Monitor Audio
                </label>
                <label style={{ marginLeft: "1rem" }}>
                  <input type="radio" name="audioMode" value="test-tone" checked={audioMode === 'test-tone'}
                    disabled={capAudioModes?.['test-tone'] === false}
                    onChange={() => setAudioMode('test-tone')} /> Test Tone
                </label>
                {audioMode === 'system' && (
                  <p className="dim" style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>
                    Shares all sound played through your default Windows output device. Works on all Windows 10+ builds.
                  </p>
                )}
                {audioMode === 'application' && (
                  <p className="dim" style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>
                    {capAudioModes?.['application'] === false
                      ? 'Requires Windows build 20348 or newer.'
                      : 'Captures audio from the selected application process tree only.'}
                  </p>
                )}
                {audioMode === 'monitor' && (
                  <p className="dim" style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>
                    {capAudioModes?.['monitor'] === false
                      ? 'Filtered Monitor requires Windows build 20348 or newer because it uses process-specific loopback capture.'
                      : 'Captures audio from active applications. Discord and ScreenLink playback are excluded.'}
                  </p>
                )}
                {audioMode === 'test-tone' && (
                  <p className="dim" style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>
                    Diagnostic 440 Hz sine wave. Does not capture real system audio.
                  </p>
                )}
              </div>
            </>
          ) : (
            <>
              <button className="danger" onClick={handleStopSharing}>Stop Sharing</button>
              {audioIsSynthetic && (
                <p className="dim" style={{ fontSize: "0.7rem", fontStyle: "italic", marginTop: "0.25rem" }}>
                  Audio: test tone (real capture unavailable on this system)
                </p>
              )}
              {audioError && (
                <p className="dim" style={{ fontSize: "0.7rem", color: "var(--warning, #f59e0b)", marginTop: "0.25rem" }}>
                  Audio: {audioError}
                </p>
              )}
            </>
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
