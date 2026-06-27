import { useState, useCallback, useEffect } from "react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// ─── Viewer quality request state ─────────────────────────────────────────

/**
 * The viewer's requested quality values. These map directly to the
 * `quality.viewer.request` protocol fields (maxWidth, maxHeight,
 * maxFps, videoBitrateKbps). When null means "no request" (host defaults).
 */
export interface ViewerRequestState {
  videoBitrateKbps: number;
  maxWidth: number;
  maxHeight: number;
  maxFps: number;
}

export const VIEWER_REQUEST_PRESETS: Array<{
  label: string;
  value: ViewerRequestState;
}> = [
  {
    label: "Low (640×360)",
    value: { videoBitrateKbps: 300, maxWidth: 640, maxHeight: 360, maxFps: 15 },
  },
  {
    label: "Medium (1280×720)",
    value: { videoBitrateKbps: 1500, maxWidth: 1280, maxHeight: 720, maxFps: 24 },
  },
  {
    label: "High (1920×1080)",
    value: { videoBitrateKbps: 3000, maxWidth: 1920, maxHeight: 1080, maxFps: 30 },
  },
];

export const RESOLUTION_CHOICES: Array<{ label: string; w: number; h: number }> = [
  { label: "640×360", w: 640, h: 360 },
  { label: "854×480", w: 854, h: 480 },
  { label: "1280×720", w: 1280, h: 720 },
  { label: "1920×1080", w: 1920, h: 1080 },
];

// ─── Display mode ──────────────────────────────────────────────────────────

export type DisplayMode = "fit" | "fill" | "actual";

const DISPLAY_MODE_LABELS: Record<DisplayMode, string> = {
  fit: "Fit to window",
  fill: "Fill window",
  actual: "Actual size",
};

// ─── Props ─────────────────────────────────────────────────────────────────

interface ViewerSettingsPanelProps {
  /** Current viewer request state (null = no request = host defaults) */
  requestState: ViewerRequestState | null;
  /** Called when the user updates their quality request */
  onRequestChange: (state: ViewerRequestState | null) => void;
  /** Whether a quality request is pending */
  requestPending?: boolean;
  /** Whether the last request was accepted (true) or capped/rejected (false) */
  lastRequestAccepted?: boolean | undefined;
  /** Feedback message (e.g. "Capped at 2000 kbps") */
  requestFeedback?: string | null;
  /** Current display mode */
  displayMode?: DisplayMode;
  /** Change display mode */
  onDisplayModeChange?: (mode: DisplayMode) => void;
  /** Called when the popover opens or closes */
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function resolveResolutionLabel(w: number, h: number): string {
  const match = RESOLUTION_CHOICES.find((r) => r.w === w && r.h === h);
  return match ? match.label : `${w}×${h}`;
}

/** Clamp a value between min and max */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ─── ViewerSettingsPanel ──────────────────────────────────────────────────

/**
 * ViewerSettingsPanel — Quality request controls with explicit resolution,
 * FPS, and bitrate inputs. Sends `quality.viewer.request` protocol messages
 * via the parent callback. No fake codec/content controls — the host decides
 * those. Persists preferences locally for reuse on later streams.
 */
export function ViewerSettingsPanel({
  requestState,
  onRequestChange,
  requestPending = false,
  lastRequestAccepted,
  requestFeedback = null,
  displayMode = "fit",
  onDisplayModeChange,
  onOpenChange,
  children,
}: ViewerSettingsPanelProps) {
  const [open, setOpen] = useState(false);

  // Local editing state (only applies when user hits Send / Clear)
  const [localQuality, setLocalQuality] = useState<ViewerRequestState>(
    requestState ?? VIEWER_REQUEST_PRESETS[1].value,
  );

  // Sync local state when requestState changes externally (e.g., from feedback clear)
  useEffect(() => {
    if (requestState) {
      setLocalQuality(requestState);
    }
  }, [requestState]);

  // Listen for keyboard shortcut S to toggle settings panel, and Escape to close
  useEffect(() => {
    const handleToggle = () => {
      setOpen((prev) => !prev);
    };
    const handleEscape = () => {
      setOpen(false);
    };
    window.addEventListener("screenlink:viewer-toggle-settings", handleToggle);
    window.addEventListener("screenlink:viewer-escape", handleEscape);
    return () => {
      window.removeEventListener("screenlink:viewer-toggle-settings", handleToggle);
      window.removeEventListener("screenlink:viewer-escape", handleEscape);
    };
  }, []);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }, [onOpenChange]);

  const handleSend = useCallback(() => {
    if (requestPending) return;
    onRequestChange(localQuality);
    setOpen(false);
  }, [localQuality, onRequestChange, requestPending]);

  const handleClear = useCallback(() => {
    if (requestPending) return;
    onRequestChange(null); // null = clear = host defaults
    setOpen(false);
  }, [onRequestChange, requestPending]);

  const isCustom = requestState === null;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-80 p-3">
        <div className="space-y-3">
          {/* ── Quality request section ──────────────────────────── */}
          <div>
            <p className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-1.5">
              Request quality
            </p>
            <p className="text-xs text-text-muted mb-2">
              Values are sent to the host. Actual quality depends on host limits.
            </p>

            {/* Resolution quick-select */}
            <div className="mb-3">
              <p className="text-[11px] text-text-muted mb-1.5">Resolution</p>
              <div className="flex flex-wrap gap-1">
                {RESOLUTION_CHOICES.map((r) => (
                  <button
                    key={r.label}
                    className={cn(
                      "px-2 py-1 rounded-standard text-[11px] transition-colors border",
                      localQuality.maxWidth === r.w && localQuality.maxHeight === r.h
                        ? "bg-accent/10 border-accent/30 text-text-primary"
                        : "bg-surface-2 border-border-subtle text-text-muted hover:text-text-secondary",
                    )}
                    onClick={() => setLocalQuality((prev) => ({ ...prev, maxWidth: r.w, maxHeight: r.h }))}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            {/* FPS slider */}
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-text-muted">FPS</span>
                <span className="text-[11px] text-text-primary font-medium">{localQuality.maxFps} fps</span>
              </div>
              <Slider
                value={[localQuality.maxFps]}
                onValueChange={([v]) => setLocalQuality((prev) => ({ ...prev, maxFps: clamp(Math.round(v), 5, 60) }))}
                min={5}
                max={60}
                step={1}
                aria-label="Requested FPS"
                className="[&>div]:h-1"
              />
            </div>

            {/* Bitrate slider */}
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-text-muted">Bitrate</span>
                <span className="text-[11px] text-text-primary font-medium">{localQuality.videoBitrateKbps} kbps</span>
              </div>
              <Slider
                value={[localQuality.videoBitrateKbps]}
                onValueChange={([v]) => setLocalQuality((prev) => ({ ...prev, videoBitrateKbps: clamp(Math.round(v), 100, 20000) }))}
                min={100}
                max={20000}
                step={50}
                aria-label="Requested bitrate"
                className="[&>div]:h-1"
              />
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2">
              <Button
                variant="default"
                size="sm"
                className="flex-1 text-xs"
                onClick={handleSend}
                disabled={requestPending}
              >
                {requestPending ? "Sending..." : "Apply"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={handleClear}
                disabled={requestPending}
              >
                {isCustom ? "Defaults" : "Clear"}
              </Button>
            </div>

            {/* Quick preset chips (convenience) */}
            <div className="flex flex-wrap gap-1 mt-2">
              {VIEWER_REQUEST_PRESETS.map((preset) => {
                const isMatch = requestState !== null &&
                  requestState.videoBitrateKbps === preset.value.videoBitrateKbps &&
                  requestState.maxWidth === preset.value.maxWidth &&
                  requestState.maxFps === preset.value.maxFps;
                return (
                  <button
                    key={preset.label}
                    className={cn(
                      "px-2 py-1 rounded-standard text-[10px] transition-colors border",
                      isMatch
                        ? "bg-accent/10 border-accent/30 text-text-primary"
                        : "bg-surface-2 border-border-subtle text-text-muted hover:text-text-secondary",
                    )}
                    onClick={() => {
                      setLocalQuality(preset.value);
                      onRequestChange(preset.value);
                      setOpen(false);
                    }}
                    disabled={requestPending}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>

            {/* Request feedback */}
            {requestFeedback && (
              <p className={cn(
                "text-xs mt-2",
                lastRequestAccepted === false ? "text-danger" : "text-text-secondary",
              )}>
                {requestFeedback}
              </p>
            )}
          </div>

          {/* ── Display mode section ─────────────────────────── */}
          {onDisplayModeChange && (
            <>
              <div className="border-t border-border-subtle pt-2">
                <p className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-1.5">
                  Display
                </p>
                <div className="space-y-1">
                  {(Object.keys(DISPLAY_MODE_LABELS) as DisplayMode[]).map((mode) => (
                    <button
                      key={mode}
                      className={cn(
                        "w-full text-left px-3 py-1.5 rounded-standard text-xs transition-colors",
                        displayMode === mode
                          ? "bg-accent/10 text-text-primary"
                          : "text-text-muted hover:text-text-secondary hover:bg-surface-2",
                      )}
                      onClick={() => onDisplayModeChange(mode)}
                    >
                      {DISPLAY_MODE_LABELS[mode]}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
