import React, { useEffect, useState, useCallback } from "react";
import { useStore, type Page } from "../stores/main-store.js";
import type { PersistedSettings, ScreenLinkAPI } from "../../preload/api-types.js";
import type { Friend } from "@screenlink/shared";

export function Friends() {
  const { navigate } = useStore();
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const api = (
          window as unknown as { screenlink?: ScreenLinkAPI }
        ).screenlink;
        const s = await api?.getSettings();
        if (s) setFriends(s.friends);
      } catch {
        // Silently fail
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <div className="friends">
        <div className="page-header">
          <h1>Friends</h1>
          <button className="ghost" onClick={() => navigate("dashboard" as Page)}>
            &larr; Back
          </button>
        </div>
        <p className="dim">Loading...</p>
      </div>
    );
  }

  return (
    <div className="friends">
      <div className="page-header">
        <h1>Friends</h1>
        <button className="ghost" onClick={() => navigate("dashboard" as Page)}>
          &larr; Back
        </button>
      </div>

      {friends.length === 0 ? (
        <div className="empty-state card">
          <p>No friends yet.</p>
          <p className="dim">
            Friends can be assigned per-viewer quality presets and will appear
            here once they connect to your sessions.
          </p>
        </div>
      ) : (
        <div className="card">
          <table className="viewer-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Note</th>
                <th>Preferred Preset</th>
                <th>Added</th>
              </tr>
            </thead>
            <tbody>
              {friends.map((f) => (
                <tr key={f.id}>
                  <td className="viewer-name">{f.displayName}</td>
                  <td className="dim">{f.note || "\u2014"}</td>
                  <td>
                    <span className="tag">{f.preferredPresetId}</span>
                  </td>
                  <td className="dim">
                    {new Date(f.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
