import React, { useState, useCallback, useEffect } from "react";
import { useStore, type Page } from "../stores/main-store.js";
import { PRESETS, CUSTOM_RANGE, getPreset, type Preset } from "@screenlink/shared";

export function Quality() {
  const { captureWidth, captureHeight, captureFps, captureBitrate, setCaptureInfo, setCaptureBitrate, navigate } =
    useStore();

  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [useCustom, setUseCustom] = useState(false);

  // Custom values (initialised to current)
  const [customWidth, setCustomWidth] = useState(captureWidth);
  const [customHeight, setCustomHeight] = useState(captureHeight);
  const [customFps, setCustomFps] = useState(captureFps);
  const [customBitrate, setCustomBitrate] = useState(captureBitrate);

  const applyPreset = useCallback(
    (preset: Preset) => {
      setSelectedPresetId(preset.id);
      setUseCustom(false);
      setCaptureInfo(preset.width, preset.height, preset.captureFps);
      setCaptureBitrate(preset.videoCeilingKbps);
    },
    [setCaptureInfo, setCaptureBitrate],
  );

  const applyCustom = useCallback(() => {
    setSelectedPresetId(null);
    setUseCustom(true);
    setCaptureInfo(customWidth, customHeight, customFps);
    setCaptureBitrate(customBitrate);
  }, [customWidth, customHeight, customFps, customBitrate, setCaptureInfo, setCaptureBitrate]);

  // Persist preset selection to settings whenever it changes
  useEffect(() => {
    if (selectedPresetId) {
      (async () => {
        try {
          const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
          await api?.updateSettings({ lastPresetId: selectedPresetId } as Record<string, unknown>);
        } catch {
          // persist is best-effort
        }
      })();
    }
  }, [selectedPresetId]);

  // Restore previously selected preset on mount
  useEffect(() => {
    (async () => {
      try {
        const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
        const settings = await api?.getSettings() as Record<string, unknown> | undefined;
        const lastPresetId = settings?.lastPresetId as string | undefined;
        if (lastPresetId) {
          setSelectedPresetId(lastPresetId);
          const preset = getPreset(lastPresetId);
          if (preset) {
            setCaptureInfo(preset.width, preset.height, preset.captureFps);
            setCaptureBitrate(preset.videoCeilingKbps);
          }
        }
      } catch {
        // restore is best-effort
      }
    })();
  }, []);

  const labelForPreset = (preset: Preset): string => {
    const names: Record<string, string> = {
      "egypt-ultra-saver": "Ultra Saver",
      "egypt-data-saver": "Data Saver",
      "text-and-coding": "Text & Coding",
      balanced: "Balanced",
      "smooth-motion": "Smooth Motion",
    };
    return names[preset.id] ?? preset.id;
  };

  return (
    <div className="quality">
      <div className="page-header">
        <h1>Quality Settings</h1>
        <button className="ghost" onClick={() => navigate("dashboard" as Page)}>
          &larr; Back
        </button>
      </div>

      {/* Preset selector */}
      <section className="preset-grid">
        {PRESETS.map((preset) => {
          const selected = selectedPresetId === preset.id;
          return (
            <div
              key={preset.id}
              className={`preset-card ${selected ? "selected" : ""}`}
              onClick={() => applyPreset(preset)}
            >
              <h3>{labelForPreset(preset)}</h3>
              <p className="mono">
                {preset.width}&times;{preset.height} @ {preset.captureFps} FPS
              </p>
              <p className="dim">{preset.videoCeilingKbps} kbps ceiling</p>
              <div className="preset-tags">
                <span className="tag">{preset.contentHint}</span>
                <span className="tag">{preset.audio ? "Audio" : "No audio"}</span>
                {preset.default && <span className="tag default">Default</span>}
              </div>
            </div>
          );
        })}
      </section>

      {/* Custom settings */}
      <section className="card custom-section">
        <h2>Custom</h2>
        <div className="slider-group">
          <label>
            Width ({customWidth}px)
            <input
              type="range"
              min={CUSTOM_RANGE.width.min}
              max={CUSTOM_RANGE.width.max}
              step={2}
              value={customWidth}
              onChange={(e) => setCustomWidth(Number(e.target.value))}
            />
          </label>
          <label>
            Height ({customHeight}px)
            <input
              type="range"
              min={CUSTOM_RANGE.height.min}
              max={CUSTOM_RANGE.height.max}
              step={2}
              value={customHeight}
              onChange={(e) => setCustomHeight(Number(e.target.value))}
            />
          </label>
          <label>
            FPS ({customFps})
            <input
              type="range"
              min={CUSTOM_RANGE.captureFps.min}
              max={CUSTOM_RANGE.captureFps.max}
              step={1}
              value={customFps}
              onChange={(e) => setCustomFps(Number(e.target.value))}
            />
          </label>
          <label>
            Bitrate ({customBitrate} kbps)
            <input
              type="range"
              min={CUSTOM_RANGE.videoCeilingKbps.min}
              max={CUSTOM_RANGE.videoCeilingKbps.max}
              step={50}
              value={customBitrate}
              onChange={(e) => setCustomBitrate(Number(e.target.value))}
            />
          </label>
        </div>
        <button onClick={applyCustom}>Apply Custom</button>
      </section>

      {/* Current summary */}
      <div className="card current-summary">
        <h3>Current Settings</h3>
        <p className="mono">
          {captureWidth}&times;{captureHeight} @ {captureFps} FPS &mdash;{" "}
          {captureBitrate} kbps
        </p>
      </div>
    </div>
  );
}
