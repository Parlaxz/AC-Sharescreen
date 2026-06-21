import React, { useEffect, useState } from "react";
import { useStore, type Page } from "../stores/main-store.js";
import type { ScreenLinkAPI } from "../../preload/api-types.js";

interface AppInfo {
  version: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
}

export function About() {
  const { navigate } = useStore();
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const api = (
          window as unknown as { screenlink?: ScreenLinkAPI }
        ).screenlink;
        const info = await api?.getAppInfo();
        if (info) setAppInfo(info);
      } catch {
        // Silently fail
      }
    })();
  }, []);

  return (
    <div className="about">
      <div className="page-header">
        <h1>About ScreenLink</h1>
        <button className="ghost" onClick={() => navigate("dashboard" as Page)}>
          &larr; Back
        </button>
      </div>

      {/* App info */}
      <div className="card about-hero">
        <div className="app-icon-large">
          <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
            <rect width="64" height="64" rx="14" fill="#0f3460" />
            <rect x="12" y="12" width="40" height="28" rx="4" fill="#1a5276" />
            <rect x="28" y="40" width="8" height="6" rx="1" fill="#1a5276" />
            <rect x="22" y="46" width="20" height="4" rx="2" fill="#1a5276" />
            <circle cx="32" cy="26" r="6" fill="#3498db" />
          </svg>
        </div>
        <h2>ScreenLink</h2>
        <p className="version mono">
          v{appInfo?.version ?? "?"}
        </p>
        <p className="dim">Private screen sharing with permanent links</p>
      </div>

      {/* Tech stack */}
      <div className="card">
        <h3>Technology Stack</h3>
        <table className="info-table">
          <tbody>
            <tr><td>Application</td><td className="mono">{appInfo?.version ?? "?"}</td></tr>
            <tr><td>Electron</td><td className="mono">{appInfo?.electronVersion ?? "?"}</td></tr>
            <tr><td>Chromium</td><td className="mono">{appInfo?.chromeVersion ?? "?"}</td></tr>
            <tr><td>Node.js</td><td className="mono">{appInfo?.nodeVersion ?? "?"}</td></tr>
            <tr><td>React</td><td className="mono">19</td></tr>
            <tr><td>Zustand</td><td className="mono">5</td></tr>
            <tr><td>Zod</td><td className="mono">3</td></tr>
          </tbody>
        </table>
      </div>

      {/* Licence */}
      <div className="card">
        <h3>License</h3>
        <p>
          ScreenLink is provided under the terms of the MIT License.
          See the LICENSE file in the repository for full details.
        </p>
      </div>

      {/* Third-party notices */}
      <div className="card">
        <h3>Third-Party Notices</h3>
        <p className="dim">
          This application uses the following open-source components:
        </p>
        <ul className="notice-list">
          <li>Electron &mdash; MIT License</li>
          <li>React &mdash; MIT License</li>
          <li>Zustand &mdash; MIT License</li>
          <li>Zod &mdash; MIT License</li>
          <li>Vite &mdash; MIT License</li>
          <li>vdo.ninja &mdash; Custom License</li>
        </ul>
      </div>
    </div>
  );
}
