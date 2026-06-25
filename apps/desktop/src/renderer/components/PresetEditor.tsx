import React, { useState } from "react";
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

const ESSENTIAL_FIELDS = [
  "videoBitrateKbps",
  "sendWidth",
  "sendHeight",
  "sendFps",
  "codec",
  "contentHint",
  "degradationPreference",
] as const;

export function PresetEditor({
  preset,
  presetName: initialName,
  onSave,
  onCancel,
}: Props) {
  const defaults = preset ?? {
    schemaVersion: 1 as const,
    video: createDefaultVideoQualitySettings(),
    audio: createDefaultAudioEncodingSettings(),
  };

  const [name, setName] = useState(initialName ?? "New Preset");
  const [settings, setSettings] = useState<GroupQualitySettings>(defaults);

  const updateVideo = (field: string, value: number | string) => {
    setSettings(prev => ({
      ...prev,
      video: { ...prev.video, [field]: value },
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(name, settings);
  };

  return (
    <div className="preset-editor-overlay">
      <div className="preset-editor">
        <h2>{preset ? "Edit Preset" : "New Preset"}</h2>
        <form onSubmit={handleSubmit}>
          <div className="field-row">
            <label htmlFor="preset-name">Preset Name</label>
            <input
              id="preset-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              required
            />
          </div>

          <fieldset>
            <legend>Essential</legend>
            {ESSENTIAL_FIELDS.map(field => {
              const help = HELP_ENTRIES[field];
              const value =
                field === "videoBitrateKbps"
                  ? settings.video.videoBitrateKbps
                  : field === "sendWidth"
                    ? settings.video.sendWidth
                    : field === "sendHeight"
                      ? settings.video.sendHeight
                      : field === "sendFps"
                        ? settings.video.sendFps
                        : field === "codec"
                          ? settings.video.codec
                          : field === "contentHint"
                            ? settings.video.contentHint
                            : field === "degradationPreference"
                              ? settings.video.degradationPreference
                              : "";

              return (
                <div className="field-row" key={field}>
                  <label htmlFor={`field-${field}`}>{field}</label>
                  {typeof value === "string" ? (
                    <input
                      id={`field-${field}`}
                      type="text"
                      value={value}
                      onChange={e => updateVideo(field, e.target.value)}
                    />
                  ) : (
                    <input
                      id={`field-${field}`}
                      type="number"
                      value={value}
                      onChange={e =>
                        updateVideo(field, parseInt(e.target.value, 10) || 0)
                      }
                    />
                  )}
                  {help && <SettingHelp help={help} />}
                </div>
              );
            })}
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
