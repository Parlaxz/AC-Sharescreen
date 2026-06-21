import React from "react";
import { useStore, type Page } from "../stores/main-store.js";

export function Viewers() {
  const { viewers, isSharing, viewerUrl, navigate } = useStore();

  const formatDuration = (connectedAt: number): string => {
    const ms = Date.now() - connectedAt;
    const totalSec = Math.floor(ms / 1000);
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  };

  const shortUuid = (uuid: string): string => uuid.slice(0, 8) + "\u2026";

  return (
    <div className="viewers">
      <div className="page-header">
        <h1>Viewers</h1>
        <button className="ghost" onClick={() => navigate("dashboard" as Page)}>
          &larr; Back
        </button>
      </div>

      {!isSharing ? (
        <div className="empty-state card">
          <p>Not currently sharing.</p>
          <p className="dim">Start a session to see connected viewers.</p>
          <button onClick={() => navigate("dashboard" as Page)}>
            Go to Dashboard
          </button>
        </div>
      ) : viewers.length === 0 ? (
        <div className="empty-state card">
          <p>No viewers connected yet.</p>
          {viewerUrl && (
            <>
              <p className="dim">Share the link below to invite viewers:</p>
              <input type="text" readOnly value={viewerUrl} className="mono" />
            </>
          )}
        </div>
      ) : (
        <div className="card">
          <table className="viewer-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Peer ID</th>
                <th>Duration</th>
                <th>Preset</th>
                <th>RTT</th>
                <th>Packet Loss</th>
                <th>Relay</th>
              </tr>
            </thead>
            <tbody>
              {viewers.map((v) => (
                <tr key={v.peerUuid}>
                  <td className="viewer-name">{v.displayName}</td>
                  <td className="mono dim">{shortUuid(v.peerUuid)}</td>
                  <td>{formatDuration(v.connectedAt)}</td>
                  <td>
                    <span className="tag">{v.presetId}</span>
                  </td>
                  <td className="dim">&mdash;</td>
                  <td className="dim">&mdash;</td>
                  <td className="dim">&mdash;</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
