import React, { useEffect, useState } from "react";
import { useStore, type Page } from "../stores/main-store.js";
import type { ScreenLinkAPI } from "../../preload/api-types.js";

interface AppInfo {
  version: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
}

export function Diagnostics() {
  const { navigate } = useStore();
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [audioDiag, setAudioDiag] = useState<any>(null);
  const [mixerDiag, setMixerDiag] = useState<any>(null);
  const [pipelineSnapshot, setPipelineSnapshot] = useState<any>(null);

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
        api.getMixerDiagnostics().then(diag => setMixerDiag(diag)).catch(() => {});
        api.getPipelineSnapshot().then(snap => setPipelineSnapshot(snap)).catch(() => {});
      }
    })();
  }, []);

  // Browser feature detection (renderer-side only)
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
      {pipelineSnapshot?.endpointPacketsCaptured !== undefined && (
        <div className="card">
          <h3>System Audio Diagnostics</h3>
          <table className="info-table">
            <tbody>
              <tr><td>Pipeline Type</td><td className="mono">Endpoint Direct</td></tr>
              <tr><td>Endpoint Active</td><td className="mono">{pipelineSnapshot.endpointDiagnostics?.endpointActive === false ? 'No' : (pipelineSnapshot.endpointPacketsCaptured ?? 0) > 0 ? 'Yes' : 'Yes (starting)'}</td></tr>
              <tr><td>Packets Captured</td><td className="mono">{pipelineSnapshot.endpointPacketsCaptured?.toLocaleString() ?? '—'}</td></tr>
              <tr><td>Nonzero Packets</td><td className="mono">{pipelineSnapshot.endpointNonZeroPackets?.toLocaleString() ?? '—'}</td></tr>
              <tr><td>Silent Packets</td><td className="mono">{pipelineSnapshot.endpointSilentPackets?.toLocaleString() ?? '—'}</td></tr>
              <tr><td>Stream Generation</td><td className="mono">{pipelineSnapshot.streamGeneration ?? '—'}</td></tr>
              <tr><td>Helper State</td><td className="mono">{pipelineSnapshot.helperState ?? '—'}</td></tr>
              <tr><td>Helper Uptime</td><td className="mono">{pipelineSnapshot.helperUptimeMs ? `${(pipelineSnapshot.helperUptimeMs / 1000).toFixed(1)}s` : '—'}</td></tr>
              <tr><td>Parser Invalid Headers</td><td className="mono">{pipelineSnapshot.parserInvalidHeaders ?? '—'}</td></tr>
              <tr><td>Pipe Write Failures</td><td className="mono">{pipelineSnapshot.pcmPipeWriteFailures ?? '—'}</td></tr>
              <tr><td>Bridge Dropped (wrong gen)</td><td className="mono">{pipelineSnapshot.bridge?.droppedWrongGeneration ?? '—'}</td></tr>
              <tr><td>Bridge Post Errors</td><td className="mono">{pipelineSnapshot.bridge?.postErrors ?? '—'}</td></tr>
              <tr><td>Bridge Last Error</td><td className="mono" style={{ fontSize: "0.7rem" }}>{pipelineSnapshot.bridge?.lastError ?? 'none'}</td></tr>
            </tbody>
          </table>
          {pipelineSnapshot.endpointDiagnostics && (
            <>
              <h4 style={{ marginTop: "0.5rem" }}>Endpoint Diagnostics</h4>
              <pre className="log-box" style={{ fontSize: "0.7rem" }}>{JSON.stringify(pipelineSnapshot.endpointDiagnostics, null, 2)}</pre>
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
              <tr><td>Mixer Feed Packets</td><td className="mono">{pipelineSnapshot.mixerFeedPackets?.toLocaleString() ?? '—'}</td></tr>
              <tr><td>Mixer Output Packets</td><td className="mono">{pipelineSnapshot.mixerOutputPackets?.toLocaleString() ?? '—'}</td></tr>
              <tr><td>Mixer Nonzero Output</td><td className="mono">{pipelineSnapshot.mixerNonZeroOutputPackets?.toLocaleString() ?? '—'}</td></tr>
              <tr><td>Capture Accepted</td><td className="mono">{pipelineSnapshot.onCaptureAccepted === undefined ? '—' : pipelineSnapshot.onCaptureAccepted ? 'Yes' : 'No'}</td></tr>
              <tr><td>Capture Rejected State</td><td className="mono">{pipelineSnapshot.onCaptureRejectedState ?? '—'}</td></tr>
              <tr><td>Active Capture Sources</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.activeCaptureSources ?? '—'}</td></tr>
              <tr><td>Sessions (last scan)</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.sessionsInLastScan ?? '—'}</td></tr>
              <tr><td>Desired Sources</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.desiredSources ?? '—'}</td></tr>
              <tr><td>Sources Added</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.sourcesAdded ?? '—'}</td></tr>
              <tr><td>Sources Removed</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.sourcesRemoved ?? '—'}</td></tr>
              <tr><td>Start Failures</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.startFailures ?? '—'}</td></tr>
              <tr><td>Retries</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.retryCount ?? '—'}</td></tr>
              <tr><td>Exclude Discord</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.excludeDiscord === undefined ? '—' : pipelineSnapshot.filteredMonitorDiagnostics.excludeDiscord ? 'Yes' : 'No'}</td></tr>
              <tr><td>Exclude ScreenLink</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.excludeScreenLink === undefined ? '—' : pipelineSnapshot.filteredMonitorDiagnostics.excludeScreenLink ? 'Yes' : 'No'}</td></tr>
              <tr><td>System Sounds Skipped</td><td className="mono">{pipelineSnapshot.filteredMonitorDiagnostics?.systemSoundsSkipped ?? '—'}</td></tr>
            </tbody>
          </table>

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
