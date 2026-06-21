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
