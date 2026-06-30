import { useMemo } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Shared quality-editor composition used by:
 *   - New / Edit personal preset
 *   - Share Setup Custom panel
 *   - Quick Share Custom
 *
 * Exposes the six user-facing quality knobs (Resolution, FPS, Bitrate,
 * Codec, Content hint, Degradation behavior) plus Custom width/height
 * fields when "Custom…" is selected.
 *
 * All controls use individual Watermelon primitives — no full dashboard
 * blocks.
 */

export const RESOLUTION_OPTIONS: Array<{ value: string; label: string; width: number; height: number }> = [
  { value: "3840x2160", label: "3840×2160 (4K)", width: 3840, height: 2160 },
  { value: "2560x1440", label: "2560×1440 (1440p)", width: 2560, height: 1440 },
  { value: "1920x1080", label: "1920×1080 (1080p)", width: 1920, height: 1080 },
  { value: "1280x720", label: "1280×720 (720p)", width: 1280, height: 720 },
  { value: "854x480", label: "854×480 (480p)", width: 854, height: 480 },
  { value: "640x360", label: "640×360 (360p)", width: 640, height: 360 },
  { value: "256x144", label: "+020p (144p)", width: 256, height: 144 },
  { value: "custom", label: "Custom…", width: 0, height: 0 },
];

export const CODEC_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "vp9", label: "VP9" },
  { value: "av1", label: "AV1" },
  { value: "h264", label: "H.264" },
  { value: "vp8", label: "VP8" },
];

export const CONTENT_HINT_OPTIONS: Array<{ value: string; label: string; description: string }> = [
  {
    value: "auto",
    label: "Auto",
    description: "Let the browser choose the optimization. Normalized to an empty/omitted track content hint.",
  },
  {
    value: "text",
    label: "Text",
    description: "Best for code, documents, terminals, and UI text. Prioritizes text readability.",
  },
  {
    value: "detail",
    label: "Detail",
    description: "Best for mostly static images and fine visual detail. Prioritizes sharpness.",
  },
  {
    value: "motion",
    label: "Motion",
    description: "Best for games, video, scrolling, and frequent movement. Prioritizes smooth motion.",
  },
];

export const DEGRADATION_OPTIONS: Array<{ value: string; label: string; description: string }> = [
  {
    value: "balanced",
    label: "Balanced",
    description: "Allows the browser to balance resolution and frame-rate reductions.",
  },
  {
    value: "maintain-resolution",
    label: "Maintain resolution",
    description: "Prefer reducing frame rate before reducing resolution.",
  },
  {
    value: "maintain-framerate",
    label: "Maintain frame rate",
    description: "Prefer reducing resolution before reducing frame rate.",
  },
];

export const FPS_MIN = 1;
export const FPS_MAX = 60;
export const BITRATE_MIN = 100;
export const BITRATE_MAX = 20_000;
export const WIDTH_MIN = 256;
export const WIDTH_MAX = 3840;
export const HEIGHT_MIN = 144;
export const HEIGHT_MAX = 2160;

export interface QualityEditorFieldsValue {
  resolutionValue: string;
  customWidth: number;
  customHeight: number;
  fps: number;
  bitrate: number;
  codec: string;
  contentHint: string;
  degradationPreference: string;
}

export interface QualityEditorFieldsProps {
  value: QualityEditorFieldsValue;
  onChange: (next: QualityEditorFieldsValue) => void;
  /** Disable all inputs (e.g., when a personal preset is selected). */
  disabled?: boolean;
  /** Show the codec selector. Defaults to true. */
  showCodec?: boolean;
  /** Show the content hint and degradation selectors. Defaults to true. */
  showAdvanced?: boolean;
  /** Title rendered above the editor. */
  title?: string;
}

export function resolveResolution(value: QualityEditorFieldsValue): { width: number; height: number } {
  if (value.resolutionValue === "custom") {
    return { width: value.customWidth, height: value.customHeight };
  }
  const opt = RESOLUTION_OPTIONS.find((o) => o.value === value.resolutionValue);
  if (!opt) return { width: value.customWidth, height: value.customHeight };
  return { width: opt.width, height: opt.height };
}

export function qualityEditorFieldsValid(value: QualityEditorFieldsValue): string | null {
  const { width, height } = resolveResolution(value);
  if (!Number.isInteger(width) || width < WIDTH_MIN || width > WIDTH_MAX) {
    return `Width must be an integer between ${WIDTH_MIN} and ${WIDTH_MAX}`;
  }
  if (!Number.isInteger(height) || height < HEIGHT_MIN || height > HEIGHT_MAX) {
    return `Height must be an integer between ${HEIGHT_MIN} and ${HEIGHT_MAX}`;
  }
  if (!Number.isInteger(value.fps) || value.fps < FPS_MIN || value.fps > FPS_MAX) {
    return `Frame rate must be an integer between ${FPS_MIN} and ${FPS_MAX}`;
  }
  if (
    !Number.isInteger(value.bitrate) ||
    value.bitrate < BITRATE_MIN ||
    value.bitrate > BITRATE_MAX
  ) {
    return `Bitrate must be between ${BITRATE_MIN} and ${BITRATE_MAX} kbps (≈${(BITRATE_MIN * 125 / 1000).toFixed(1)} kB/s–${(BITRATE_MAX * 125 / 1000).toFixed(0)} kB/s)`;
  }
  return null;
}

export function QualityEditorFields({
  value,
  onChange,
  disabled = false,
  showCodec = true,
  showAdvanced = true,
  title,
}: QualityEditorFieldsProps) {
  const { width, height } = useMemo(() => resolveResolution(value), [value]);
  const isCustom = value.resolutionValue === "custom";

  const update = (patch: Partial<QualityEditorFieldsValue>) => {
    onChange({ ...value, ...patch });
  };

  return (
    <Card className={cn(disabled && "opacity-50 pointer-events-none")}>
      {title ? (
        <CardContent className="pt-4">
          <h4 className="text-sm font-medium text-text-primary">{title}</h4>
        </CardContent>
      ) : null}
      <CardContent className="space-y-4">
        {/* Resolution */}
        <div className="space-y-2">
          <Label htmlFor="quality-resolution">Resolution</Label>
          <Select
            value={value.resolutionValue}
            onValueChange={(v) => update({ resolutionValue: v })}
            disabled={disabled}
          >
            <SelectTrigger id="quality-resolution">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RESOLUTION_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Custom width/height fields when Custom is selected */}
        {isCustom ? (
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="quality-width">Width</Label>
                <span className="text-xs font-mono tabular-nums text-text-primary">
                  {value.customWidth}px
                </span>
              </div>
              <Slider
                value={[value.customWidth]}
                onValueChange={([v]) => update({ customWidth: v ?? WIDTH_MIN })}
                min={WIDTH_MIN}
                max={WIDTH_MAX}
                step={8}
                disabled={disabled}
              />
              <Input
                id="quality-width"
                type="number"
                value={value.customWidth}
                min={WIDTH_MIN}
                max={WIDTH_MAX}
                step={8}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (Number.isFinite(v)) update({ customWidth: v });
                }}
                disabled={disabled}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="quality-height">Height</Label>
                <span className="text-xs font-mono tabular-nums text-text-primary">
                  {value.customHeight}px
                </span>
              </div>
              <Slider
                value={[value.customHeight]}
                onValueChange={([v]) => update({ customHeight: v ?? HEIGHT_MIN })}
                min={HEIGHT_MIN}
                max={HEIGHT_MAX}
                step={8}
                disabled={disabled}
              />
              <Input
                id="quality-height"
                type="number"
                value={value.customHeight}
                min={HEIGHT_MIN}
                max={HEIGHT_MAX}
                step={8}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (Number.isFinite(v)) update({ customHeight: v });
                }}
                disabled={disabled}
              />
            </div>
          </div>
        ) : (
          <p className="text-xs text-text-muted">
            Effective: {width}×{height}
          </p>
        )}

        {/* FPS */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="quality-fps">Frame rate</Label>
            <span className="text-xs font-mono tabular-nums text-text-primary">
              {value.fps} fps
            </span>
          </div>
          <Slider
            value={[value.fps]}
            onValueChange={([v]) => update({ fps: v ?? FPS_MIN })}
            min={FPS_MIN}
            max={FPS_MAX}
            step={1}
            disabled={disabled}
          />
        </div>

        {/* Bitrate */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="quality-bitrate">Bitrate</Label>
            <span className="text-xs font-mono tabular-nums text-text-primary">
              {(() => { const Bps = value.bitrate * 125; if (Bps < 1000) return `${Math.round(Bps)} B/s`; const kBps = Bps / 1000; if (kBps < 1000) return `${kBps.toFixed(1)} kB/s`; return `${(kBps / 1000).toFixed(2)} MB/s`; })()}
            </span>
          </div>
          <Slider
            value={[value.bitrate]}
            onValueChange={([v]) => update({ bitrate: v ?? BITRATE_MIN })}
            min={BITRATE_MIN}
            max={BITRATE_MAX}
            step={50}
            disabled={disabled}
          />
        </div>

        {/* Codec */}
        {showCodec ? (
          <div className="space-y-2">
            <Label htmlFor="quality-codec">Codec</Label>
            <Select
              value={value.codec}
              onValueChange={(v) => update({ codec: v })}
              disabled={disabled}
            >
              <SelectTrigger id="quality-codec">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CODEC_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        {/* Advanced: content hint + degradation */}
        {showAdvanced ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="quality-content-hint">Content hint</Label>
              <Select
                value={value.contentHint}
                onValueChange={(v) => update({ contentHint: v })}
                disabled={disabled}
              >
                <SelectTrigger id="quality-content-hint">
                  <SelectValue />
                </SelectTrigger>
              <SelectContent>
                {CONTENT_HINT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-text-muted">
              {CONTENT_HINT_OPTIONS.find((o) => o.value === value.contentHint)?.description ??
                ""}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="quality-degradation">Degradation behavior</Label>
            <Select
              value={value.degradationPreference}
              onValueChange={(v) => update({ degradationPreference: v })}
              disabled={disabled}
            >
              <SelectTrigger id="quality-degradation">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEGRADATION_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
              </Select>
              <p className="text-xs text-text-muted">
                {DEGRADATION_OPTIONS.find((o) => o.value === value.degradationPreference)
                  ?.description ?? ""}
              </p>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
