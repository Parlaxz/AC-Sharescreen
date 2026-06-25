import React, { useState, useEffect, useRef, useCallback } from "react";
import { useStore } from "../stores/main-store.js";
import { getRuntime } from "../services/phase3-runtime.js";
import { createDefaultGroupQualitySettings } from "@screenlink/shared";
import type { GroupQualitySettings } from "@screenlink/shared";

interface Props {
  groupId: string;
  onClose: () => void;
}

/**
 * GroupSettingsDialog (Stage 11)
 *
 * Replaces prompt()-based Group Settings with a proper dialog.
 * - Reads group state from store (reactive)
 * - Saves via runtime.getSyncService().performLocalEdit(), not direct persistence
 * - Shows conflict banner if dirty form receives newer remote state
 * - Accessible: role="dialog", aria-modal, initial focus, focus trap, focus restore
 */
export function GroupSettingsDialog({ groupId, onClose }: Props) {
  const groupsById = useStore((s) => s.groupsById);
  const group = groupsById[groupId];

  // Read initial quality settings from sync service (Stage 15)
  const initialQuality: GroupQualitySettings = React.useMemo(() => {
    try {
      const runtime = getRuntime();
      if (!runtime) return createDefaultGroupQualitySettings();
      const syncState = runtime.getSyncService().getSyncState(groupId);
      return syncState?.state?.defaultQuality?.value ?? createDefaultGroupQualitySettings();
    } catch {
      return createDefaultGroupQualitySettings();
    }
  }, [groupId]);

  const [name, setName] = useState(group?.name ?? "");
  const [videoBitrateKbps, setVideoBitrateKbps] = useState(initialQuality.video.videoBitrateKbps);
  const [sendWidth, setSendWidth] = useState(initialQuality.video.sendWidth);
  const [sendHeight, setSendHeight] = useState(initialQuality.video.sendHeight);
  const [sendFps, setSendFps] = useState(initialQuality.video.sendFps);
  const [captureWidth, setCaptureWidth] = useState(initialQuality.video.captureWidth);
  const [captureHeight, setCaptureHeight] = useState(initialQuality.video.captureHeight);
  const [captureFps, setCaptureFps] = useState(initialQuality.video.captureFps);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const initialNameRef = useRef(group?.name ?? "");
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFocusableRef = useRef<HTMLInputElement>(null);
  const previousActiveElement = useRef<Element | null>(null);

  // Save previous focus and restore on unmount
  useEffect(() => {
    previousActiveElement.current = document.activeElement;
    // Focus the first focusable element after mount
    const timer = setTimeout(() => {
      firstFocusableRef.current?.focus();
    }, 0);
    return () => {
      clearTimeout(timer);
      // Restore focus to the element that opened the dialog
      if (previousActiveElement.current instanceof HTMLElement) {
        previousActiveElement.current.focus();
      }
    };
  }, []);

  // Track remote state changes to detect conflicts
  useEffect(() => {
    const unsub = useStore.subscribe((state, prevState) => {
      if (!dirty) return;
      const newGroup = (state as unknown as Record<string, unknown>).groupsById as Record<string, { name: string }> | undefined;
      const oldGroup = (prevState as unknown as Record<string, unknown>).groupsById as Record<string, { name: string }> | undefined;
      const newName = newGroup?.[groupId]?.name;
      const oldName = oldGroup?.[groupId]?.name;
      if (newName && newName !== oldName && newName !== name) {
        setConflict(true);
      }
    });
    return unsub;
  }, [groupId, dirty, name]);

  // Focus trap: close on Escape, trap Tab cycling
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  const markDirty = useCallback(() => setDirty(true), []);

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      setError("Group name cannot be empty");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const runtime = getRuntime();
      if (!runtime) {
        setError("Runtime not initialized");
        setSaving(false);
        return;
      }

      // Build the quality settings object from form fields
      const updatedQuality: GroupQualitySettings = {
        schemaVersion: 1,
        video: {
          videoBitrateKbps,
          sendWidth,
          sendHeight,
          sendFps,
          captureWidth,
          captureHeight,
          captureFps,
          preserveAspectRatio: initialQuality.video.preserveAspectRatio,
          preventUpscale: initialQuality.video.preventUpscale,
          resolutionMode: initialQuality.video.resolutionMode,
          scaleResolutionDownBy: initialQuality.video.scaleResolutionDownBy,
          codec: initialQuality.video.codec,
          h264Profile: initialQuality.video.h264Profile,
          contentHint: initialQuality.video.contentHint,
          degradationPreference: initialQuality.video.degradationPreference,
          scalabilityMode: initialQuality.video.scalabilityMode,
          cursorMode: initialQuality.video.cursorMode,
          rtpPriority: initialQuality.video.rtpPriority,
        },
        audio: { ...initialQuality.audio },
      };

      await runtime.getSyncService().performLocalEdit(groupId, (state) => ({
        name: { value: name.trim() },
        defaultQuality: { value: updatedQuality },
      }));

      setDirty(false);
      setConflict(false);
      initialNameRef.current = name.trim();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [groupId, name, videoBitrateKbps, sendWidth, sendHeight, sendFps, captureWidth, captureHeight, captureFps, initialQuality]);

  return (
    <div
      className="dialog-overlay"
      role="presentation"
    >
      <div
        className="dialog card group-settings-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-settings-title"
      >
        <div className="dialog-header">
          <h2 id="group-settings-title">Group Settings</h2>
          <button className="ghost" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        {conflict && (
          <div className="conflict-banner" style={{
            background: "var(--warning-bg, #fff3cd)",
            border: "1px solid var(--warning-border, #ffc107)",
            padding: "0.5rem",
            borderRadius: "4px",
            marginBottom: "0.75rem",
            fontSize: "0.85rem",
          }}>
            <strong>Conflict detected:</strong> The group state has changed remotely while you were editing. Saving will overwrite the remote change.
          </div>
        )}

        <div className="field-row">
          <label htmlFor="group-settings-name">Group Name</label>
          <input
            id="group-settings-name"
            ref={firstFocusableRef}
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); markDirty(); }}
            maxLength={100}
          />
        </div>

        <fieldset style={{ marginTop: "0.75rem", border: "1px solid var(--border-color, #ccc)", borderRadius: "4px", padding: "0.5rem" }}>
          <legend style={{ fontWeight: 600, fontSize: "0.9rem" }}>Default Stream Quality</legend>

          <div className="field-row">
            <label htmlFor="settings-bitrate">Video Bitrate (kbps)</label>
            <input
              id="settings-bitrate"
              type="number"
              min={100}
              max={20000}
              value={videoBitrateKbps}
              onChange={(e) => { setVideoBitrateKbps(Number(e.target.value)); markDirty(); }}
            />
          </div>

          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <div className="field-row" style={{ flex: 1, minWidth: 0 }}>
              <label htmlFor="settings-send-width">Send Width</label>
              <input
                id="settings-send-width"
                type="number"
                min={320}
                max={3840}
                value={sendWidth}
                onChange={(e) => { setSendWidth(Number(e.target.value)); markDirty(); }}
              />
            </div>
            <div className="field-row" style={{ flex: 1, minWidth: 0 }}>
              <label htmlFor="settings-send-height">Send Height</label>
              <input
                id="settings-send-height"
                type="number"
                min={180}
                max={2160}
                value={sendHeight}
                onChange={(e) => { setSendHeight(Number(e.target.value)); markDirty(); }}
              />
            </div>
            <div className="field-row" style={{ flex: 1, minWidth: 0 }}>
              <label htmlFor="settings-send-fps">Send FPS</label>
              <input
                id="settings-send-fps"
                type="number"
                min={1}
                max={60}
                value={sendFps}
                onChange={(e) => { setSendFps(Number(e.target.value)); markDirty(); }}
              />
            </div>
          </div>

          <details style={{ marginTop: "0.5rem" }}>
            <summary style={{ cursor: "pointer", fontSize: "0.85rem", fontWeight: 500 }}>Capture Settings</summary>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
              <div className="field-row" style={{ flex: 1, minWidth: 0 }}>
                <label htmlFor="settings-capture-width">Capture Width</label>
                <input
                  id="settings-capture-width"
                  type="number"
                  min={320}
                  max={3840}
                  value={captureWidth}
                  onChange={(e) => { setCaptureWidth(Number(e.target.value)); markDirty(); }}
                />
              </div>
              <div className="field-row" style={{ flex: 1, minWidth: 0 }}>
                <label htmlFor="settings-capture-height">Capture Height</label>
                <input
                  id="settings-capture-height"
                  type="number"
                  min={180}
                  max={2160}
                  value={captureHeight}
                  onChange={(e) => { setCaptureHeight(Number(e.target.value)); markDirty(); }}
                />
              </div>
              <div className="field-row" style={{ flex: 1, minWidth: 0 }}>
                <label htmlFor="settings-capture-fps">Capture FPS</label>
                <input
                  id="settings-capture-fps"
                  type="number"
                  min={1}
                  max={60}
                  value={captureFps}
                  onChange={(e) => { setCaptureFps(Number(e.target.value)); markDirty(); }}
                />
              </div>
            </div>
          </details>
        </fieldset>

        {error && <p className="error">{error}</p>}

        <div className="actions" style={{ marginTop: "0.75rem" }}>
          <button onClick={handleSave} disabled={!dirty || saving}>
            {saving ? "Saving..." : "Save"}
          </button>
          <button className="ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
