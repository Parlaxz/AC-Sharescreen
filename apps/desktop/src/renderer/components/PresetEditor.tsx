import React, { useState, useId, useRef, useEffect } from "react";
import type { GroupQualitySettings } from "@screenlink/shared";
import {
  createDefaultVideoQualitySettings,
  createDefaultAudioEncodingSettings,
} from "@screenlink/shared";
import { SettingHelp } from "./SettingHelp.js";
import { HELP_ENTRIES } from "../quality-setting-help.js";

interface Props {
  preset?: GroupQualitySettings;
  presetName?: string;
  onSave: (name: string, settings: GroupQualitySettings) => void;
  onCancel: () => void;
}

const ESSENTIAL_FIELDS: Array<{ key: string; label: string; type: "number" | "select" | "text"; options?: string[]; section: "video" | "audio" }> = [
  { key: "videoBitrateKbps", label: "Video Bitrate (kB/s)", type: "number", section: "video" },
  { key: "sendWidth", label: "Send Width (px)", type: "number", section: "video" },
  { key: "sendHeight", label: "Send Height (px)", type: "number", section: "video" },
  { key: "sendFps", label: "Send FPS", type: "number", section: "video" },
  { key: "codec", label: "Codec", type: "select", options: ["auto", "vp9", "av1", "h264", "vp8"], section: "video" },
  { key: "contentHint", label: "Content Hint", type: "select", options: ["auto", "text", "detail", "motion"], section: "video" },
  { key: "degradationPreference", label: "Degradation Preference", type: "select", options: ["balanced", "maintain-resolution", "maintain-framerate"], section: "video" },
];

const ADVANCED_FIELDS: Array<{ key: string; label: string; type: "number" | "select" | "text"; options?: string[]; section: "video" | "audio" }> = [
  { key: "captureWidth", label: "Capture Width (px)", type: "number", section: "video" },
  { key: "captureHeight", label: "Capture Height (px)", type: "number", section: "video" },
  { key: "captureFps", label: "Capture FPS", type: "number", section: "video" },
  { key: "preserveAspectRatio", label: "Preserve Aspect Ratio", type: "select", options: ["true", "false"], section: "video" },
  { key: "preventUpscale", label: "Prevent Upscale", type: "select", options: ["true", "false"], section: "video" },
  { key: "resolutionMode", label: "Resolution Mode", type: "select", options: ["target-dimensions", "scale-factor"], section: "video" },
  { key: "scaleResolutionDownBy", label: "Scale Resolution Down By", type: "number", section: "video" },
  { key: "h264Profile", label: "H264 Profile", type: "select", options: ["auto", "baseline", "main", "high"], section: "video" },
  { key: "scalabilityMode", label: "Scalability Mode", type: "text", section: "video" },
  { key: "cursorMode", label: "Cursor Mode", type: "select", options: ["always", "motion", "never"], section: "video" },
  { key: "rtpPriority", label: "RTP Priority", type: "select", options: ["very-low", "low", "medium", "high"], section: "video" },
];

const AUDIO_FIELDS: Array<{ key: string; label: string; type: "number" | "select"; options?: string[] }> = [
  { key: "bitrateKbps", label: "Audio Bitrate (kB/s)", type: "number" },
  { key: "channels", label: "Channels", type: "select", options: ["mono", "stereo"] },
  { key: "bitrateMode", label: "Bitrate Mode", type: "select", options: ["vbr", "cbr"] },
  { key: "dtx", label: "DTX (Discontinuous Transmission)", type: "select", options: ["true", "false"] },
  { key: "fec", label: "FEC (Forward Error Correction)", type: "select", options: ["true", "false"] },
  { key: "packetDurationMs", label: "Packet Duration (ms)", type: "select", options: ["10", "20", "40", "60"] },
  { key: "redundantAudio", label: "Redundant Audio", type: "select", options: ["true", "false"] },
];

export function PresetEditor({
  preset,
  presetName: initialName,
  onSave,
  onCancel,
}: Props) {
  const formId = useId();
  const titleId = `${formId}-title`;
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFocusableRef = useRef<HTMLInputElement>(null);
  const previousActiveElement = useRef<Element | null>(null);

  const defaults = preset ?? {
    schemaVersion: 1 as const,
    video: createDefaultVideoQualitySettings(),
    audio: createDefaultAudioEncodingSettings(),
  };

  const [name, setName] = useState(initialName ?? "New Preset");
  const [settings, setSettings] = useState<GroupQualitySettings>(defaults);

  // Save previous focus and restore on unmount
  useEffect(() => {
    previousActiveElement.current = document.activeElement;
    const timer = setTimeout(() => {
      firstFocusableRef.current?.focus();
    }, 0);
    return () => {
      clearTimeout(timer);
      if (previousActiveElement.current instanceof HTMLElement) {
        previousActiveElement.current.focus();
      }
    };
  }, []);

  // Focus trap: Tab cycling within dialog, Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
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
  }, [onCancel]);

  const updateVideo = (field: string, value: number | string | boolean) => {
    setSettings(prev => ({
      ...prev,
      video: { ...prev.video, [field]: value },
    }));
  };

  const updateAudio = (field: string, value: number | string | boolean) => {
    setSettings(prev => ({
      ...prev,
      audio: { ...prev.audio, [field]: value },
    }));
  };

  const getVideoValue = (field: string): number | string => {
    const v = settings.video as unknown as Record<string, unknown>;
    const val = v[field];
    if (typeof val === "boolean") return val ? "true" : "false";
    if (val === null || val === undefined) return "";
    return String(val);
  };

  const getAudioValue = (field: string): number | string => {
    const a = settings.audio as unknown as Record<string, unknown>;
    const val = a[field];
    if (typeof val === "boolean") return val ? "true" : "false";
    return String(val);
  };

  const handleVideoChange = (field: string, rawValue: string, type: string) => {
    if (type === "number") {
      updateVideo(field, parseInt(rawValue, 10) || 0);
    } else if (field === "preserveAspectRatio" || field === "preventUpscale") {
      updateVideo(field, rawValue === "true");
    } else if (field === "scalabilityMode") {
      updateVideo(field, rawValue || (null as unknown as string));
    } else {
      updateVideo(field, rawValue);
    }
  };

  const handleAudioChange = (field: string, rawValue: string, type: string) => {
    if (type === "number") {
      updateAudio(field, parseInt(rawValue, 10) || 0);
    } else if (field === "dtx" || field === "fec" || field === "redundantAudio") {
      updateAudio(field, rawValue === "true");
    } else if (field === "packetDurationMs") {
      updateAudio(field, parseInt(rawValue, 10) as 10 | 20 | 40 | 60);
    } else {
      updateAudio(field, rawValue);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(name, settings);
  };

  const renderFieldRow = (
    fieldDef: { key: string; label: string; type: string; options?: string[] },
    value: string | number,
    onChange: (val: string) => void,
    helpKey?: string,
  ) => {
    const inputId = `${formId}-field-${fieldDef.key}`;
    return (
      <div className="field-row" key={fieldDef.key}>
        <label htmlFor={inputId}>{fieldDef.label}</label>
        {fieldDef.type === "select" && fieldDef.options ? (
          <select
            id={inputId}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          >
            {fieldDef.options.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        ) : (
          <input
            id={inputId}
            type={fieldDef.type === "number" ? "number" : "text"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        {helpKey && HELP_ENTRIES[helpKey] && <SettingHelp help={HELP_ENTRIES[helpKey]} />}
      </div>
    );
  };

  return (
    <div className="preset-editor-overlay" role="presentation">
      <div
        className="preset-editor"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId}>{preset ? "Edit Preset" : "New Preset"}</h2>
        <form onSubmit={handleSubmit}>
          <div className="field-row">
            <label htmlFor={`${formId}-preset-name`}>Preset Name</label>
            <input
              id={`${formId}-preset-name`}
              ref={firstFocusableRef}
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              required
            />
          </div>

          {/* Essential Fields */}
          <fieldset>
            <legend>Essential</legend>
            {ESSENTIAL_FIELDS.map((fieldDef) =>
              renderFieldRow(
                fieldDef,
                getVideoValue(fieldDef.key),
                (val) => handleVideoChange(fieldDef.key, val, fieldDef.type),
                fieldDef.key,
              )
            )}
          </fieldset>

          {/* Advanced Fields */}
          <fieldset>
            <legend>Advanced</legend>
            {ADVANCED_FIELDS.map((fieldDef) =>
              renderFieldRow(
                fieldDef,
                getVideoValue(fieldDef.key),
                (val) => handleVideoChange(fieldDef.key, val, fieldDef.type),
                fieldDef.key,
              )
            )}
          </fieldset>

          {/* Audio Fields */}
          <fieldset>
            <legend>Audio</legend>
            {AUDIO_FIELDS.map((fieldDef) =>
              renderFieldRow(
                fieldDef,
                getAudioValue(fieldDef.key),
                (val) => handleAudioChange(fieldDef.key, val, fieldDef.type),
                `audio${fieldDef.key.charAt(0).toUpperCase() + fieldDef.key.slice(1)}`,
              )
            )}
          </fieldset>

          <div className="actions">
            <button type="submit">Save</button>
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

