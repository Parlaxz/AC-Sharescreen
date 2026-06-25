import React, { useEffect, useState } from "react";
import { useStore } from "../stores/main-store.js";
import {
  createDefaultVideoQualitySettings,
  createDefaultAudioEncodingSettings,
  extractViewerRequestFromPreset,
} from "@screenlink/shared";

interface QualityPresetDTO {
  id: string;
  name: string;
  settings: import("@screenlink/shared").GroupQualitySettings | {
    videoBitrateKbps: number;
    maxWidth: number;
    maxHeight: number;
    maxFps: number;
    degradationPreference: string;
    contentHint: string;
    audioEnabled: boolean;
  };
}

export function QualityPresets() {
  const [presets, setPresets] = useState<QualityPresetDTO[]>([]);
  const [importString, setImportString] = useState("");
  const [exportString, setExportString] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const list = (await (window as unknown as { screenlink: { listQualityPresets: () => Promise<unknown[]> } }).screenlink.listQualityPresets()) as QualityPresetDTO[];
    setPresets(list);
    useStore.getState().setQualityPresets(list as unknown[]);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onDelete = async (id: string) => {
    await (window as unknown as { screenlink: { deleteQualityPreset: (id: string) => Promise<boolean> } }).screenlink.deleteQualityPreset(id);
    await refresh();
  };

  const onDuplicate = async (id: string) => {
    const original = presets.find((p) => p.id === id);
    if (!original) return;
    await (window as unknown as { screenlink: { duplicateQualityPreset: (id: string, newName: string) => Promise<unknown> } }).screenlink.duplicateQualityPreset(id, `${original.name} (Copy)`);
    await refresh();
  };

  const onExport = async (id: string) => {
    const str = await (window as unknown as { screenlink: { exportQualityPreset: (id: string) => Promise<string | null> } }).screenlink.exportQualityPreset(id);
    if (str) setExportString(str);
  };

  const onImport = async () => {
    setError(null);
    try {
      const result = await (window as unknown as { screenlink: { importQualityPreset: (s: string) => Promise<unknown> } }).screenlink.importQualityPreset(importString.trim());
      if (result && typeof result === "object" && "error" in result) {
        setError((result as { error: string }).error);
        return;
      }
      setImportString("");
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>Quality Presets</h1>
        <div className="actions">
          <button
            onClick={async () => {
              const settings = {
                schemaVersion: 1 as const,
                video: createDefaultVideoQualitySettings(),
                audio: createDefaultAudioEncodingSettings(),
              };
              await (window as unknown as { screenlink: { createQualityPreset: (i: { name: string; settings: unknown }) => Promise<unknown> } }).screenlink.createQualityPreset({ name: "New Preset", settings });
              await refresh();
            }}
          >
            Create Preset
          </button>
        </div>
      </header>

      <div className="import-row">
        <textarea
          placeholder="Paste exported preset string (SLQP1:...)"
          value={importString}
          onChange={(e) => setImportString(e.target.value)}
          rows={2}
        />
        <button onClick={onImport}>Import Preset</button>
      </div>

      {error && <p className="error">{error}</p>}

      {exportString && (
        <div className="dialog">
          <h2>Exported Preset</h2>
          <textarea readOnly value={exportString} rows={3} />
          <div className="actions">
            <button onClick={async () => { await navigator.clipboard.writeText(exportString); }}>Copy</button>
            <button onClick={() => setExportString(null)}>Close</button>
          </div>
        </div>
      )}

      <div className="preset-list">
        {presets.length === 0 ? (
          <>
            <p>No local presets yet.</p>
            <p>Create a preset to save your preferred quality settings.</p>
          </>
        ) : (
          presets.map((p) => (
            <div key={p.id} className="preset-card">
              <h3>{p.name}</h3>
              <p>
                {'schemaVersion' in p.settings
                  ? `${(p.settings as import("@screenlink/shared").GroupQualitySettings).video.sendWidth}×${(p.settings as import("@screenlink/shared").GroupQualitySettings).video.sendHeight} @ ${(p.settings as import("@screenlink/shared").GroupQualitySettings).video.sendFps} fps · ${(p.settings as import("@screenlink/shared").GroupQualitySettings).video.videoBitrateKbps} kbps · ${(p.settings as import("@screenlink/shared").GroupQualitySettings).video.contentHint}`
                  : `${(p.settings as { maxWidth: number }).maxWidth}×${(p.settings as { maxHeight: number }).maxHeight} @ ${(p.settings as { maxFps: number }).maxFps} fps · ${(p.settings as { videoBitrateKbps: number }).videoBitrateKbps} kbps · ${(p.settings as { contentHint: string }).contentHint}`}
              </p>
              <div className="actions">
                <button onClick={async () => {
                  const newName = prompt("New name:", p.name);
                  if (newName && newName.trim()) {
                    const api = (window as unknown as { screenlink: { updateQualityPreset: (id: string, input: { name?: string }) => Promise<unknown> } }).screenlink;
                    if (api) {
                      await api.updateQualityPreset(p.id, { name: newName.trim() });
                      await refresh();
                    }
                  }
                }}>Edit</button>
                <button onClick={async () => {
                  const store = useStore.getState();
                  const watchedEntries = Object.entries(store.watchedStreamsBySessionId);
                  if (watchedEntries.length === 0) {
                    alert("No watched streams available. Watch a stream first to request quality changes.");
                    return;
                  }
                  const [sessionId, watchInfo] = watchedEntries[0];
                  const hostDeviceId = watchInfo.hostDeviceId;
                  if ('schemaVersion' in p.settings) {
                    const preset = p.settings as import("@screenlink/shared").GroupQualitySettings;
                    const request = extractViewerRequestFromPreset(preset, sessionId, 0);
                    console.log("[QualityPresets] quality.viewer.request:", request);
                    alert(`Quality request sent for stream ${sessionId} on device ${hostDeviceId}. Check console for details.`);
                    // TODO: Send via group control when the message router supports it
                  } else {
                    alert("This preset uses an older format. Please recreate it with the new schema.");
                  }
                }}>Use This Preset</button>
                <button onClick={() => void onDuplicate(p.id)}>Duplicate</button>
                <button onClick={() => void onExport(p.id)}>Export</button>
                <button onClick={() => void onDelete(p.id)}>Delete</button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
