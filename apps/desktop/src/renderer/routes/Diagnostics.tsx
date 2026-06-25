import { useEffect, useState } from "react";
import { useStore, type Page } from "../stores/main-store.js";
import type {
  ScreenLinkAPI,
  FilteredMonitorDiagnostics,
  PipelineSnapshotWithDiagnostics,
  ActiveSourceDiagnostics,
} from "../../preload/api-types.js";

interface AppInfo {
  version: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion?: string;
}

interface HelperProvenance {
  state: string;
  uptimeMs: number;
  generation: number;
  helperBinaryPath?: string;
  helperBinarySize?: number;
  helperBinaryMtime?: string;
}

export function Diagnostics() {
  const { navigate } = useStore();
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [audioDiag, setAudioDiag] = useState<unknown>(null);
  const [mixerDiag, setMixerDiag] = useState<FilteredMonitorDiagnostics | null>(null);
  const [pipelineSnapshot, setPipelineSnapshot] = useState<PipelineSnapshotWithDiagnostics | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const api = (
          window as unknown as { screenlink?: ScreenLinkAPI }
        ).screenlink;
        const info = await api?.getAppInfo();
        if (info) setAppInfo(info);
      } catch (err) {
        console.error("Failed to get app info:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const api = (
        window as unknown as { screenlink?: ScreenLinkAPI }
      ).screenlink;
      if (api) {
        api.getAudioState().then(state => setAudioDiag(state)).catch(() => {});
        api.getMixerDiagnostics().then(diag => setMixerDiag(diag as unknown as FilteredMonitorDiagnostics)).catch(() => {});
        api.getPipelineSnapshot().then(snap => setPipelineSnapshot(snap)).catch(() => {});
      }
    })();
  }, []);

  // Browser feature detection (renderer-side only)
  const [helperProvenance, setHelperProvenance] = useState<HelperProvenance | null>(null);

  useEffect(() => {
    // Read the audio-diag.log for helper provenance
    // (logged by AudioHelperManager at startup)
    const checkProvenance = async () => {
      const api = (window as unknown as { screenlink?: ScreenLinkAPI }).screenlink;
      if (api) {
        // getPipelineSnapshot includes helper uptime and state
        const snap = await api.getPipelineSnapshot().catch(() => null);
        if (snap) {
          setHelperProvenance({
            state: snap.helperState,
            uptimeMs: snap.helperUptimeMs,
            generation: snap.streamGeneration,
            helperBinaryPath: snap.helperBinaryPath,
            helperBinarySize: snap.helperBinarySize,
            helperBinaryMtime: snap.helperBinaryMtime,
          });
        }
      }
    };
    checkProvenance();
  }, []);

  const browserInfo = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: (navigator as unknown as { deviceMemory?: number }).deviceMemory,
    maxTouchPoints: navigator.maxTouchPoints,
  };

  const webrtcSupport = {
    rtcPeerConnection: typeof RTCPeerConnection !== "undefined",
    rtcDataChannel: typeof RTCDataChannel !== "undefined",
    getDisplayMedia: typeof navigator.mediaDevices?.getDisplayMedia !== "undefined",
    enumerateDevices: typeof navigator.mediaDevices?.enumerateDevices !== "undefined",
    canvasCapture: typeof HTMLCanvasElement.prototype.captureStream !== "undefined",
    webCodecs:
      typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined",
  };

  return (
    <div className="diagnostics">
      <div className="page-header">
        <h1>Diagnostics</h1>
        <button className="ghost" onClick={() => navigate("dashboard" as Page)}>
          &larr; Back
        </button>
      </div>

      {loading && <p className="dim">Loading diagnostics...</p>}

      {/* App versions */}
      <div className="card">
        <h3>Application Versions</h3>
        {appInfo ? (
          <table className="info-table">
            <tbody>
              <tr><td>ScreenLink</td><td className="mono">{appInfo.version}</td></tr>
              <tr><td>Electron</td><td className="mono">{appInfo.electronVersion}</td></tr>
              <tr><td>Chromium</td><td className="mono">{appInfo.chromeVersion}</td></tr>
              <tr><td>Node.js</td><td className="mono">{appInfo.nodeVersion}</td></tr>
            </tbody>
          </table>
        ) : (
          <p className="dim">Not available</p>
        )}
      </div>

      {/* Helper provenance */}
      {helperProvenance && (
        <div className="card">
          <h3>Audio Helper Provenance</h3>
          <table className="info-table">
            <tbody>
              <tr><td>Helper State</td><td className="mono">{helperProvenance.state}</td></tr>
              <tr><td>Uptime</td><td className="mono">{helperProvenance.uptimeMs ? `${(helperProvenance.uptimeMs / 1000).toFixed(1)}s` : '—'}</td></tr>
              <tr><td>Stream Generation</td><td className="mono">{helperProvenance.generation}</td></tr>
              <tr><td>Binary Path</td><td className="mono small">{helperProvenance.helperBinaryPath ?? '—'}</td></tr>
              <tr><td>Binary Size</td><td className="mono">{helperProvenance.helperBinarySize ? `${(helperProvenance.helperBinarySize / 1024).toFixed(0)} KB` : '—'}</td></tr>
              <tr><td>Binary Modified</td><td className="mono small">{helperProvenance.helperBinaryMtime ?? '—'}</td></tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Browser / Renderer info */}
      <div className="card">
        <h3>Renderer Environment</h3>
        <table className="info-table">
          <tbody>
            <tr><td>User Agent</td><td className="mono small">{browserInfo.userAgent}</td></tr>
            <tr><td>Platform</td><td className="mono">{browserInfo.platform}</td></tr>
            <tr><td>Language</td><td className="mono">{browserInfo.language}</td></tr>
            <tr><td>Logical cores</td><td className="mono">{browserInfo.hardwareConcurrency}</td></tr>
            <tr>
              <td>Device memory</td>
              <td className="mono">
                {browserInfo.deviceMemory
                  ? `${browserInfo.deviceMemory} GiB`
                  : "unknown"}
              </td>
            </tr>
            <tr><td>Max touch points</td><td className="mono">{browserInfo.maxTouchPoints}</td></tr>
          </tbody>
        </table>
      </div>

      {/* WebRTC / Media support */}
      <div className="card">
        <h3>WebRTC &amp; Media Support</h3>
        <table className="info-table">
          <tbody>
            {Object.entries(webrtcSupport).map(([key, supported]) => (
              <tr key={key}>
                <td>{key}</td>
                <td>
                  <span className={`tag ${supported ? "supported" : "unsupported"}`}>
                    {supported ? "Yes" : "No"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Audio Diagnostics */}
      <div className="card">
        <h3>Audio Diagnostics</h3>
        {audioDiag !== null ? (
          <table className="info-table">
            <tbody>
              <tr><td>Audio State</td><td className="mono">{String(audioDiag)}</td></tr>
            </tbody>
          </table>
        ) : (
          <p className="dim">Audio helper not active</p>
        )}
        {mixerDiag !== null && (
          <>
            <h4 style={{ marginTop: "0.5rem" }}>Mixer State</h4>
            <pre className="log-box" style={{ fontSize: "0.7rem" }}>{JSON.stringify(mixerDiag, null, 2)}</pre>
          </>
        )}
      </div>

      {/* System Audio Diagnostics (endpoint pipeline) */}
      {(pipelineSnapshot as unknown as { endpointPacketsCaptured?: number } | null)?.endpointPacketsCaptured !== undefined && pipelineSnapshot && (
        <div className="card">
          <h3>System Audio Diagnostics</h3>
          <table className="info-table">
            <tbody>
              <tr><td>Pipeline Type</td><td className="mono">Endpoint Direct</td></tr>
              <tr><td>Endpoint Active</td><td className="mono">{(pipelineSnapshot as unknown as { endpointDiagnostics?: { endpointActive?: boolean } }).endpointDiagnostics?.endpointActive === false ? 'No' : ((pipelineSnapshot as unknown as { endpointPacketsCaptured?: number }).endpointPacketsCaptured ?? 0) > 0 ? 'Yes' : 'Yes (starting)'}</td></tr>
              <tr><td>Packets Captured</td><td className="mono">{(pipelineSnapshot as unknown as { endpointPacketsCaptured?: number }).endpointPacketsCaptured?.toLocaleString() ?? '—'}</td></tr>
              <tr><td>Nonzero Packets</td><td className="mono">{(pipelineSnapshot as unknown as { endpointNonZeroPackets?: number }).endpointNonZeroPackets?.toLocaleString() ?? '—'}</td></tr>
              <tr><td>Silent Packets</td><td className="mono">{(pipelineSnapshot as unknown as { endpointSilentPackets?: number }).endpointSilentPackets?.toLocaleString() ?? '—'}</td></tr>
              <tr><td>Stream Generation</td><td className="mono">{pipelineSnapshot?.streamGeneration ?? '—'}</td></tr>
              <tr><td>Helper State</td><td className="mono">{pipelineSnapshot?.helperState ?? '—'}</td></tr>
              <tr><td>Helper Uptime</td><td className="mono">{pipelineSnapshot?.helperUptimeMs ? `${(pipelineSnapshot.helperUptimeMs / 1000).toFixed(1)}s` : '—'}</td></tr>
              <tr><td>Parser Invalid Headers</td><td className="mono">{(pipelineSnapshot as unknown as { parserInvalidHeaders?: number }).parserInvalidHeaders ?? '—'}</td></tr>
              <tr><td>Pipe Write Failures</td><td className="mono">{(pipelineSnapshot as unknown as { pcmPipeWriteFailures?: number }).pcmPipeWriteFailures ?? '—'}</td></tr>
              <tr><td>Bridge Dropped (wrong gen)</td><td className="mono">{(pipelineSnapshot as unknown as { bridge?: { droppedWrongGeneration?: number } }).bridge?.droppedWrongGeneration ?? '—'}</td></tr>
              <tr><td>Bridge Post Errors</td><td className="mono">{(pipelineSnapshot as unknown as { bridge?: { postErrors?: number } }).bridge?.postErrors ?? '—'}</td></tr>
              <tr><td>Bridge Last Error</td><td className="mono" style={{ fontSize: "0.7rem" }}>{(pipelineSnapshot as unknown as { bridge?: { lastError?: string } }).bridge?.lastError ?? 'none'}</td></tr>
            </tbody>
          </table>
          {Boolean((pipelineSnapshot as unknown as { endpointDiagnostics?: unknown }).endpointDiagnostics) && (
            <>
              <h4 style={{ marginTop: "0.5rem" }}>Endpoint Diagnostics</h4>
              <pre className="log-box" style={{ fontSize: "0.7rem" }}>{JSON.stringify((pipelineSnapshot as unknown as { endpointDiagnostics: unknown }).endpointDiagnostics, null, 2)}</pre>
            </>
          )}
        </div>
      )}

      {/* Filtered Monitor Diagnostics (dynamic-process-mix pipeline) */}
      {(pipelineSnapshot?.mixerFeedPackets !== undefined || pipelineSnapshot?.filteredMonitorDiagnostics !== undefined) && (
        <div className="card">
          <h3>Filtered Monitor Diagnostics</h3>
          <table className="info-table">
            <tbody>
              <tr><td>Pipeline Type</td><td className="mono">Dynamic Process Mix</td></tr>
              <tr><td>Stream Generation</td><td className="mono">{pipelineSnapshot.streamGeneration ?? '—'}</td></tr>
              <tr><td>Helper State</td><td className="mono">{pipelineSnapshot.helperState ?? '—'}</td></tr>
              <tr><td>Mixer Feed Packets</td><td className="mono">{(pipelineSnapshot as unknown as { mixerFeedPackets?: number }).mixerFeedPackets?.toLocaleString() ?? '—'}</td></tr>
              <tr><td>Mixer Output Packets</td><td className="mono">{(pipelineSnapshot as unknown as { mixerOutputPackets?: number }).mixerOutputPackets?.toLocaleString() ?? '—'}</td></tr>
              <tr><td>Mixer Nonzero Output</td><td className="mono">{(pipelineSnapshot as unknown as { mixerNonZeroOutputPackets?: number }).mixerNonZeroOutputPackets?.toLocaleString() ?? '—'}</td></tr>
              <tr><td>Capture Accepted</td><td className="mono">{(pipelineSnapshot as unknown as { onCaptureAccepted?: boolean }).onCaptureAccepted === undefined ? '—' : (pipelineSnapshot as unknown as { onCaptureAccepted?: boolean }).onCaptureAccepted ? 'Yes' : 'No'}</td></tr>
              <tr><td>Capture Rejected State</td><td className="mono">{(pipelineSnapshot as unknown as { onCaptureRejectedState?: string }).onCaptureRejectedState ?? '—'}</td></tr>
              <tr><td>Active Capture Sources</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.activeCaptureSources ?? '—'}</td></tr>
              <tr><td>Sessions (last scan)</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.totalSessionsLastScan ?? '—'}</td></tr>
              <tr><td>Desired Sources</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.desiredSourcesLastScan ?? '—'}</td></tr>
              <tr><td>Sources Added</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.sourcesAdded ?? '—'}</td></tr>
              <tr><td>Sources Removed</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.sourcesRemoved ?? '—'}</td></tr>
              <tr><td>Start Failures</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.sourceStartFailures ?? '—'}</td></tr>
              <tr><td>Retries</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.sourceRetries ?? '—'}</td></tr>
              <tr><td>Exclude Discord</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.discordExcludedLastScan === undefined ? '—' : pipelineSnapshot.filteredMonitorDiagnostics.discordExcludedLastScan > 0 ? 'Yes' : 'No'}</td></tr>
              <tr><td>Exclude ScreenLink</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.screenLinkExcludedLastScan === undefined ? '—' : pipelineSnapshot.filteredMonitorDiagnostics.screenLinkExcludedLastScan > 0 ? 'Yes' : 'No'}</td></tr>
              <tr><td>System Sounds Skipped</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.systemSoundsSkippedLastScan ?? '—'}</td></tr>
              <tr><td>Duplicate Roots</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.duplicateRootsLastScan ?? '—'}</td></tr>
            </tbody>
          </table>

          {/* Session Identity Diagnostics */}
          <h4 style={{ marginTop: "0.5rem" }}>Session Identity</h4>
          <table className="info-table">
            <tbody>
              <tr><td>Validated Live Sessions</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.validatedLiveSessionsLastScan ?? '—'}</td></tr>
              <tr><td>Identity Lookup Failures</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.identityLookupFailuresLastScan ?? '—'}</td></tr>
              <tr><td>Inconsistent Identity Sessions</td><td className="mono" style={pipelineSnapshot.filteredMonitorDiagnostics?.inconsistentIdentitySessionsLastScan != null && pipelineSnapshot.filteredMonitorDiagnostics.inconsistentIdentitySessionsLastScan > 0 ? { color: '#e74c3c', fontWeight: 'bold' } : undefined}>{pipelineSnapshot.filteredMonitorDiagnostics?.inconsistentIdentitySessionsLastScan ?? '—'}</td></tr>
              <tr><td>Expired Sessions</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.expiredSessionsLastScan ?? '—'}</td></tr>
              <tr><td>Invalid Sessions</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.invalidSessionsLastScan ?? '—'}</td></tr>
            </tbody>
          </table>

          {/* Active Sources PID tracking */}
          {pipelineSnapshot.filteredMonitorDiagnostics?.activeSources &&
           pipelineSnapshot.filteredMonitorDiagnostics.activeSources.length > 0 && (
            <>
              <h4 style={{ marginTop: "0.5rem" }}>Active Capture Sources</h4>
              {pipelineSnapshot.filteredMonitorDiagnostics.activeSources.map((src, i) => (
                <table key={i} className="info-table" style={{ marginBottom: "0.25rem" }}>
                  <tbody>
                    <tr><td>Source #{i + 1}</td><td className="mono">{src.executableName}</td></tr>
                    <tr><td>Logical Root PID</td><td className="mono">{src.logicalRootPid}</td></tr>
                    <tr><td>Physical Capture PID</td><td className="mono">{src.physicalCaptureTargetPid}</td></tr>
                    <tr><td>Session PID</td><td className="mono">{src.sessionPid}</td></tr>
                    <tr><td>Input Packets</td><td className="mono">{src.inputPackets.toLocaleString()}</td></tr>
                    <tr><td>Nonzero Packets</td><td className="mono">{src.inputNonZeroPackets.toLocaleString()}</td></tr>
                    <tr><td>Max Peak</td><td className="mono">{src.maximumInputPeak.toExponential(4)}</td></tr>
                  </tbody>
                </table>
              ))}
            </>
          )}

          {/* Input Energy Diagnostics */}
          {(pipelineSnapshot.filteredMonitorDiagnostics?.mixerInputPackets !== undefined ||
            pipelineSnapshot.filteredMonitorDiagnostics?.maximumInputPeak !== undefined) && (
            <>
              <h4 style={{ marginTop: "0.5rem" }}>Input Energy</h4>
              <table className="info-table">
                <tbody>
                  <tr><td>Input Packets</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.mixerInputPackets?.toLocaleString() ?? '—'}</td></tr>
                  <tr><td>Input Nonzero Packets</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.mixerInputNonZeroPackets?.toLocaleString() ?? '—'}</td></tr>
                  <tr><td>Input Zero Packets</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.mixerInputZeroPackets?.toLocaleString() ?? '—'}</td></tr>
                  <tr><td>Last Input Peak</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.lastInputPeak !== undefined ? pipelineSnapshot.filteredMonitorDiagnostics.lastInputPeak.toExponential(4) : '—'}</td></tr>
                  <tr><td>Maximum Input Peak</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.maximumInputPeak !== undefined ? pipelineSnapshot.filteredMonitorDiagnostics.maximumInputPeak.toExponential(4) : '—'}</td></tr>
                  <tr><td>Last Input RMS</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.lastInputRms !== undefined ? pipelineSnapshot.filteredMonitorDiagnostics.lastInputRms.toExponential(4) : '—'}</td></tr>
                  <tr><td>Maximum Input RMS</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.maximumInputRms !== undefined ? pipelineSnapshot.filteredMonitorDiagnostics.maximumInputRms.toExponential(4) : '—'}</td></tr>
                </tbody>
              </table>
            </>
          )}

          {/* Output Energy Diagnostics */}
          {(pipelineSnapshot.filteredMonitorDiagnostics?.mixerOutputPackets !== undefined ||
            pipelineSnapshot.filteredMonitorDiagnostics?.maximumOutputPeak !== undefined) && (
            <>
              <h4 style={{ marginTop: "0.5rem" }}>Output Energy</h4>
              <table className="info-table">
                <tbody>
                  <tr><td>Output Packets</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.mixerOutputPackets?.toLocaleString() ?? '—'}</td></tr>
                  <tr><td>Output Nonzero Packets</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.mixerOutputNonZeroPackets?.toLocaleString() ?? '—'}</td></tr>
                  <tr><td>Output Zero Packets</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.mixerOutputZeroPackets?.toLocaleString() ?? '—'}</td></tr>
                  <tr><td>Last Output Peak</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.lastOutputPeak !== undefined ? pipelineSnapshot.filteredMonitorDiagnostics.lastOutputPeak.toExponential(4) : '—'}</td></tr>
                  <tr><td>Maximum Output Peak</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.maximumOutputPeak !== undefined ? pipelineSnapshot.filteredMonitorDiagnostics.maximumOutputPeak.toExponential(4) : '—'}</td></tr>
                  <tr><td>Last Output RMS</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.lastOutputRms !== undefined ? pipelineSnapshot.filteredMonitorDiagnostics.lastOutputRms.toExponential(4) : '—'}</td></tr>
                  <tr><td>Maximum Output RMS</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.maximumOutputRms !== undefined ? pipelineSnapshot.filteredMonitorDiagnostics.maximumOutputRms.toExponential(4) : '—'}</td></tr>
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      {/* Log section */}
      <div className="card">
        <h3>Recent Logs</h3>
        <pre className="log-box">
          {`[${new Date().toISOString()}] App loaded
[${new Date().toISOString()}] Diagnostics page opened
`}
        </pre>
      </div>
    </div>
  );
}
