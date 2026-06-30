import { useState, useCallback, useEffect, useMemo, useSyncExternalStore, useRef } from "react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { Copy, Check, FolderOpen } from "lucide-react";
import { loadSettings } from "@/services/settings-actions";
import { useStore } from "@/stores/main-store";
import type { ProcessorStats } from "@/services/viewer-image-processing/viewer-image-processor";
import {
  clampValue,
  type ViewerImageEnhancementSettings,
  type ScalingAlgorithm,
  type FsrTargetScale,
  type FsrFinalScaler,
  type ProcessingBackend,
  type NvidiaProcessingMode,
  type NvidiaQuality,
  type NvidiaOutput,
  parseFsrTargetScale,
  SCALING_ALGORITHMS,
  SCALING_ALGORITHM_LABELS,
  PROCESSING_BACKENDS,
  PROCESSING_BACKEND_LABELS,
  WEBGL_SCALING_ALGORITHMS,
  WEBGL_SCALING_ALGORITHM_LABELS,
  NVIDIA_PROCESSING_MODES,
  NVIDIA_PROCESSING_MODE_LABELS,
  NVIDIA_QUALITIES,
  NVIDIA_QUALITY_LABELS,
  NVIDIA_OUTPUTS,
  NVIDIA_OUTPUT_LABELS,
  FSR_TARGET_SCALES,
  FSR_TARGET_SCALE_LABELS,
  FSR_FINAL_SCALERS,
  FSR_FINAL_SCALER_LABELS,
} from "@/services/viewer-image-processing/viewer-image-settings";
import {
  IMAGE_ENHANCEMENT_CONTROL_RANGE,
  VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
} from "@/services/viewer-image-processing/viewer-image-defaults";
import {
  getNvidiaCapabilitySnapshot,
  probeNvidiaCapability,
  subscribeToNvidiaCapability,
} from "@/services/nvidia-capability-store";
import {
  nvidiaBenchmarkService,
  getBenchmarkProgressSnapshot,
  subscribeToBenchmarkProgress,
  type BenchmarkProgress,
  type BenchmarkScenarioResult,
} from "@/services/viewer-image-processing/nvidia-benchmark-service";

type ExportableBenchmarkRecord = {
  id: string;
};

//  Viewer quality request state 

// ─── Benchmark section ──────────────────────────────────────────────────────

function formatMs(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${value.toFixed(2)} ms`;
}

function formatFps(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${value.toFixed(1)} fps`;
}

function formatDimensions(w: number, h: number): string {
  if (w <= 0 || h <= 0) return "—";
  return `${w}×${h}`;
}

/**
 * Phase label for the benchmark progress bar, based on the current state.
 */
function benchmarkPhaseLabel(progress: BenchmarkProgress): string {
  if (progress.phaseLabel) return progress.phaseLabel;
  const labels: Record<string, string> = {
    idle: "Idle",
    validating: "Validating configuration…",
    stabilizing: "Stabilizing pipeline…",
    "collecting-environment": "Gathering environment info…",
    "running-scenarios": "Running scenarios…",
    aggregating: "Aggregating results…",
    exporting: "Finalizing results…",
    completed: "Complete",
    cancelled: "Cancelled",
    failed: "Failed",
  };
  return labels[progress.state] ?? progress.state;
}

function BenchmarkScenarioRow({ result }: { result: BenchmarkScenarioResult }) {
  const isTimedOut = result.timedOut;
  return (
    <div className={cn(
      "grid grid-cols-4 gap-x-2 gap-y-0.5 text-[10px] py-1 border-b border-border-subtle/40 last:border-b-0",
      isTimedOut && "opacity-50",
    )}>
      <span className="col-span-4 font-medium text-text-primary text-[10px] truncate">
        {result.label}
        {isTimedOut && (
          <Badge variant="warning" className="ml-1.5 text-[8px] px-1 py-0">partial</Badge>
        )}
      </span>
      <span className="text-text-muted">Process</span>
      <span className="text-text-secondary font-mono text-right">
        {formatMs(result.avgProcessingTimeMs)}
      </span>
      <span className="text-text-muted">Latency</span>
      <span className="text-text-secondary font-mono text-right">
        {formatMs(result.avgLatencyMs)}
      </span>
      <span className="text-text-muted">p95</span>
      <span className="text-text-secondary font-mono text-right">
        {formatMs(result.p95ProcessingTimeMs)}
      </span>
      <span className="text-text-muted">FPS</span>
      <span className="text-text-secondary font-mono text-right">
        {formatFps(result.achievedFps)}
      </span>
      <span className="text-text-muted">Output</span>
      <span className="text-text-secondary font-mono text-right">
        {formatDimensions(result.nativeOutputWidth, result.nativeOutputHeight)}
      </span>
      {result.nativeQualityLevel != null && (
        <>
          <span className="text-text-muted">QL</span>
          <span className="text-text-secondary font-mono text-right">{result.nativeQualityLevel}</span>
        </>
      )}
      <span className="text-text-muted">Frames</span>
      <span className="text-text-secondary font-mono text-right">
        {result.framesCollected}/{result.framesRequested}
      </span>
    </div>
  );
}

interface BenchmarkSectionProps {
  benchmarkRunning: boolean;
  benchmarkProgress: BenchmarkProgress | null;
  onRunBenchmark: () => void;
  onCancelBenchmark: () => void;
  onApplyBenchmarkRecommendation: () => void;
  enhancementSettings: ViewerImageEnhancementSettings;
  onEnhancementChange: (settings: ViewerImageEnhancementSettings) => void;
}

function BenchmarkSection({
  benchmarkRunning,
  benchmarkProgress,
  onRunBenchmark,
  onCancelBenchmark,
  onApplyBenchmarkRecommendation,
}: BenchmarkSectionProps) {
  const [summaryCopied, setSummaryCopied] = useState(false);
  const progress = benchmarkProgress;
  const isRunning = benchmarkRunning && progress != null;
  const isTerminal = progress?.state === "completed" || progress?.state === "cancelled" || progress?.state === "failed";
  const hasResults = progress?.results && progress.results.length > 0;
  const isCompleted = progress?.state === "completed";

  const handleCopySummary = useCallback(async () => {
    if (!progress?.results || progress.results.length === 0) return;
    const lines: string[] = [
      "ScreenLink NVIDIA Benchmark Results",
      "==================================",
      `State: ${progress.state}`,
      `Completed: ${progress.completedScenarios}/${progress.totalScenarios} scenarios`,
      `Timestamp: ${new Date().toISOString()}`,
      "",
    ];
    for (const r of progress.results) {
      lines.push(`[${r.label}]`);
      lines.push(`  Process:   ${formatMs(r.avgProcessingTimeMs)}  (p50: ${formatMs(r.p50ProcessingTimeMs)}  p95: ${formatMs(r.p95ProcessingTimeMs)})`);
      lines.push(`  Latency:   ${formatMs(r.avgLatencyMs)}`);
      lines.push(`  FPS:       ${formatFps(r.achievedFps)}`);
      lines.push(`  Output:    ${formatDimensions(r.nativeOutputWidth, r.nativeOutputHeight)}`);
      if (r.nativeQualityLevel != null) lines.push(`  QL:        ${r.nativeQualityLevel}`);
      lines.push(`  Frames:    ${r.framesCollected}/${r.framesRequested}${r.timedOut ? " (partial)" : ""}`);
      lines.push("");
    }
    // Include recommendation if available
    const agg = nvidiaBenchmarkService.aggregate;
    if (agg?.bestLatency) {
      lines.push(`Best latency: ${agg.bestLatency.label} (${formatMs(agg.bestLatency.avgMs)})`);
    }
    if (agg?.highestQuality) {
      lines.push(`Highest quality: ${agg.highestQuality.label} (${formatMs(agg.highestQuality.avgMs)})`);
    }
    if (agg?.recommendedSettings) {
      lines.push(`Recommended: ${JSON.stringify(agg.recommendedSettings)}`);
    }
    if (agg?.totalDurationMs != null) {
      lines.push(`Total duration: ${(agg.totalDurationMs / 1000).toFixed(1)}s`);
    }

    const text = lines.join("\n");
    try {
      const api = (window as unknown as { screenlink?: { clipboardWriteText: (text: string) => Promise<{ success: boolean; length: number }> } }).screenlink;
      if (api) {
        await api.clipboardWriteText(text);
      } else {
        await navigator.clipboard.writeText(text);
      }
      setSummaryCopied(true);
      setTimeout(() => setSummaryCopied(false), 2000);
    } catch {
      // Clipboard write failed
    }
  }, [progress]);

  const handleOpenFolder = useCallback(async () => {
    try {
      const api = (window as unknown as { screenlink?: { nvidiaOpenBenchmarkFolder: () => Promise<boolean> } }).screenlink;
      await api?.nvidiaOpenBenchmarkFolder();
    } catch {
      // Best-effort
    }
  }, []);

  const handleExportLatest = useCallback(async () => {
    try {
      const api = (window as unknown as { screenlink?: {
        nvidiaGetBenchmarkResults: () => Promise<ExportableBenchmarkRecord[]>;
        nvidiaExportBenchmarkResult: (resultId: string) => Promise<string | null>;
      } }).screenlink;
      if (!api?.nvidiaGetBenchmarkResults || !api?.nvidiaExportBenchmarkResult) {
        return;
      }
      const results = await api.nvidiaGetBenchmarkResults();
      const latest = results.at(-1);
      if (latest?.id) {
        await api.nvidiaExportBenchmarkResult(latest.id);
      }
    } catch {
      // Best-effort
    }
  }, []);

  return (
    <div className="pt-2 border-t border-border-subtle">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] text-text-muted uppercase tracking-wide">Benchmark</span>
        {!isRunning && !isTerminal && (
          <Button
            variant="outline"
            size="sm"
            className="text-[10px] h-7 px-2"
            onClick={onRunBenchmark}
          >
            Run Full Benchmark
          </Button>
        )}
      </div>

      {isRunning && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-text-secondary truncate mr-2">
              {benchmarkPhaseLabel(progress!)}
            </span>
            <span className="text-text-muted font-mono">
              {progress!.percent.toFixed(0)}%
            </span>
          </div>
          <Progress value={progress!.percent} className="h-1.5" />
          {progress!.currentScenario && (
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-text-muted">
                Scenario {progress!.completedScenarios + 1}/{progress!.totalScenarios}
              </span>
              <span className="text-text-secondary font-mono">
                {progress!.currentSamples.length}/{progress!.currentTargetFrames} frames
              </span>
            </div>
          )}
          <Button
            variant="destructive"
            size="sm"
            className="w-full text-[10px] h-7"
            onClick={onCancelBenchmark}
          >
            Cancel Benchmark
          </Button>
        </div>
      )}

      {/* Result summary card */}
      {isTerminal && hasResults && (
        <Card className="mt-2">
          <CardContent className="p-2 space-y-2">
            {/* Header */}
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium text-text-primary uppercase tracking-wide">
                {progress!.state === "completed" ? "Results" : "Benchmark Stopped"}
              </span>
              {isCompleted && (
                <Badge variant="success" className="text-[8px] px-1.5 py-0">Complete</Badge>
              )}
              {progress!.state === "cancelled" && (
                <Badge variant="warning" className="text-[8px] px-1.5 py-0">Cancelled</Badge>
              )}
              {progress!.state === "failed" && (
                <Badge variant="destructive" className="text-[8px] px-1.5 py-0">Failed</Badge>
              )}
            </div>

            {/* Scenario rows */}
            <div className="max-h-48 overflow-y-auto">
              {progress!.results.map((result) => (
                <BenchmarkScenarioRow key={result.scenario} result={result} />
              ))}
            </div>

            {/* Apply recommendation or dismiss */}
            <div className="flex gap-2 pt-1">
              {isCompleted && (
                <Button
                  variant="default"
                  size="sm"
                  className="flex-1 text-[10px] h-7"
                  onClick={onApplyBenchmarkRecommendation}
                >
                  Apply Recommended
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="flex-1 text-[10px] h-7"
                onClick={handleCopySummary}
              >
                {summaryCopied ? (
                  <><Check className="h-3 w-3 mr-1" />Copied</>
                ) : (
                  <><Copy className="h-3 w-3 mr-1" />Copy Summary</>
                )}
              </Button>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1 text-[10px] h-7"
                onClick={handleOpenFolder}
              >
                <FolderOpen className="h-3 w-3 mr-1" />
                Open Folder
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1 text-[10px] h-7"
                onClick={handleExportLatest}
              >
                Export Latest
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1 text-[10px] h-7"
                onClick={onRunBenchmark}
              >
                {isCompleted ? "Run Again" : "Retry"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Error display */}
      {progress?.error && (
        <p className="text-[10px] text-danger mt-1">{progress.error}</p>
      )}
    </div>
  );
}

/**
 * The viewer's requested quality values. These map directly to the
 * `quality.viewer.request` protocol fields (maxWidth, maxHeight,
 * maxFps, videoBitrateKbps). When null means "no request" (host defaults).
 */
function NvidiaCapabilityStatus() {
  const capability = useSyncExternalStore(
    subscribeToNvidiaCapability,
    getNvidiaCapabilitySnapshot,
    getNvidiaCapabilitySnapshot,
  );

  useEffect(() => {
    if (!capability.probed && !capability.probing) {
      void probeNvidiaCapability();
    }
  }, [capability.probed, capability.probing]);

  if (!capability.probed || capability.probing) {
    return (
      <p className="text-[10px] text-text-muted">
        Checking NVIDIA RTX Video support...
      </p>
    );
  }

  if (!capability.available) {
    const reason = capability.reason.split("-").join(" - ");

    return (
      <p className="text-[10px] text-amber-500">
        NVIDIA RTX Video unavailable: {reason}.
      </p>
    );
  }

  return (
    <p className="text-[10px] text-emerald-500">
      NVIDIA RTX Video available
      {capability.adapterName ? `  ${capability.adapterName}` : ""}
    </p>
  );
}

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
    label: "Low (360p)",
    value: { videoBitrateKbps: 300, maxWidth: 640, maxHeight: 360, maxFps: 15 },
  },
  {
    label: "Medium (720p)",
    value: { videoBitrateKbps: 1500, maxWidth: 1280, maxHeight: 720, maxFps: 24 },
  },
  {
    label: "High (1080p)",
    value: { videoBitrateKbps: 3000, maxWidth: 1920, maxHeight: 1080, maxFps: 30 },
  },
];

export const RESOLUTION_CHOICES: Array<{ label: string; w: number; h: number }> = [
  { label: "1080p", w: 1920, h: 1080 },
  { label: "720p", w: 1280, h: 720 },
  { label: "480p", w: 854, h: 480 },
  { label: "360p", w: 640, h: 360 },
  { label: "240p", w: 426, h: 240 },
  { label: "144p", w: 256, h: 144 },
];

//  Props 

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
  /** Called when the popover opens or closes */
  onOpenChange?: (open: boolean) => void;
  /** Max value for the bitrate slider kbps (default 5000) */
  maxSliderBitrateKbps?: number;
  /** Current GPU image enhancement settings */
  enhancementSettings?: ViewerImageEnhancementSettings;
  /** Called live when any enhancement control changes */
  onEnhancementChange?: (settings: ViewerImageEnhancementSettings) => void;
  /** Called when the user clicks Reset to Defaults in the enhancements tab */
  onEnhancementReset?: () => void;
  /** Effective backend after auto-detection (shown when different from selected) */
  effectiveBackend?: string;
  /** Fallback reason if the requested backend couldn't be used */
  fallbackReason?: string;
  /** When true, the quality tab in the popover is hidden */
  hideQuality?: boolean;
  /** Processing statistics (shown when enhancements enabled) */
  enhancementStats?: (Omit<Partial<ProcessorStats>, "backend"> & {
    inputWidth: number;
    inputHeight: number;
    outputWidth: number;
    outputHeight: number;
    processingTimeMs: number | null;
    enhancedScalingActive: boolean;
    backend: string;
  }) | null;
  children: React.ReactNode;
  /** When true, render only the content tabs without Popover wrappers */
  contentOnly?: boolean;

  // ── Benchmark props ─────────────────────────────────────────────────
  /** True while the benchmark service is running scenarios. */
  benchmarkRunning?: boolean;
  /** Current benchmark progress snapshot (when running / completed). */
  benchmarkProgress?: BenchmarkProgress | null;
  /** Called when the user clicks "Run Full Benchmark". */
  onRunBenchmark?: () => void;
  /** Called when the user clicks "Cancel". */
  onCancelBenchmark?: () => void;
  /** Called when the user clicks "Apply Recommended Settings". */
  onApplyBenchmarkRecommendation?: () => void;

  /**
   * Compare variant identifier. When "B", the panel renders with a tinted
   * appearance and "Comparison Configuration B" header.
   */
  variant?: "A" | "B";
}

//  Helpers 

/** Clamp a value between min and max */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

//  Enhancement slider sub-component 

/**
 * A single slider + number-input pair for GPU image enhancement controls.
 * Manages its own text input state internally and fires live onChange.
 */
function EnhancementSliderControl({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));

  // Sync text when value changes externally (e.g. reset)
  useEffect(() => {
    setText(String(value));
  }, [value]);

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      setText(raw);
      const v = parseFloat(raw);
      if (Number.isFinite(v) && v >= 0 && v <= 1) {
        onChange(clampValue(v, 0, 1));
      }
    },
    [onChange],
  );

  const handleBlur = useCallback(() => {
    const v = parseFloat(text);
    const clamped = Number.isFinite(v) ? clampValue(v, 0, 1) : value;
    setText(String(clamped));
    if (clamped !== value) onChange(clamped);
  }, [text, value, onChange]);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-text-muted uppercase tracking-wide">
          {label}
        </span>
        <span className="text-[11px] font-mono text-text-secondary">
          {value.toFixed(2)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <Slider
            value={[value]}
            onValueChange={([v]) => onChange(clampValue(v, 0, 1))}
            min={IMAGE_ENHANCEMENT_CONTROL_RANGE.min}
            max={IMAGE_ENHANCEMENT_CONTROL_RANGE.max}
            step={IMAGE_ENHANCEMENT_CONTROL_RANGE.step}
            aria-label={label}
            disabled={disabled}
          />
        </div>
        <Input
          type="number"
          value={text}
          onChange={handleTextChange}
          onBlur={handleBlur}
          min={IMAGE_ENHANCEMENT_CONTROL_RANGE.min}
          max={IMAGE_ENHANCEMENT_CONTROL_RANGE.max}
          step={IMAGE_ENHANCEMENT_CONTROL_RANGE.step}
          className="w-16 h-7 text-xs text-center font-mono"
          disabled={disabled}
        />
      </div>
    </div>
  );
}

//  Preset type from store 

interface StorePreset {
  id: string;
  name: string;
  settings: Record<string, unknown>;
}

//  ViewerSettingsPanel 

/**
 * ViewerSettingsPanel  Quality request controls with explicit resolution,
 * FPS, and bitrate inputs. Sends `quality.viewer.request` protocol messages
 * via the parent callback.
 */
export function ViewerSettingsPanel({
  requestState,
  onRequestChange,
  requestPending = false,
  lastRequestAccepted,
  requestFeedback = null,
  onOpenChange,
  maxSliderBitrateKbps = 5000,
  enhancementSettings = VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
  onEnhancementChange = () => {},
  onEnhancementReset = () => {},
  effectiveBackend,
  fallbackReason,
  enhancementStats = null,
  children,
  contentOnly = false,
  benchmarkRunning = false,
  benchmarkProgress = null,
  onRunBenchmark = () => {},
  onCancelBenchmark = () => {},
  onApplyBenchmarkRecommendation = () => {},
  variant,
}: ViewerSettingsPanelProps) {
  const [open, setOpen] = useState(false);
  const [effectiveMaxBitrate, setEffectiveMaxBitrate] = useState(maxSliderBitrateKbps);

  // Load quality presets from store
  const rawPresets = useStore((s) => s.qualityPresets as StorePreset[]);

  const qualityPresets = useMemo(() => {
    if (!Array.isArray(rawPresets)) return [];
    return rawPresets.filter((p) => {
      const video = p.settings?.video as Record<string, unknown> | undefined;
      return video && typeof video.videoBitrateKbps === "number";
    });
  }, [rawPresets]);

  // Load persisted viewerBitrateSliderMaxKbps setting on mount
  useEffect(() => {
    loadSettings()
      .then((s) => {
        if (s.viewerBitrateSliderMaxKbps != null) {
          setEffectiveMaxBitrate(s.viewerBitrateSliderMaxKbps);
        }
      })
      .catch(() => {
        // fall back to prop default
      });
  }, []);

  // Local editing state (only applies when user hits Send / Clear)
  const [localQuality, setLocalQuality] = useState<ViewerRequestState>(
    requestState ?? VIEWER_REQUEST_PRESETS[1].value,
  );

  // FPS / bitrate text input state
  const [fpsText, setFpsText] = useState(String(localQuality.maxFps));
  const [bitrateText, setBitrateText] = useState(String(localQuality.videoBitrateKbps));

  // Sync local state when requestState changes externally
  useEffect(() => {
    if (requestState) {
      setLocalQuality(requestState);
      setFpsText(String(requestState.maxFps));
      setBitrateText(String(requestState.videoBitrateKbps));
    }
  }, [requestState]);

  // Sync text inputs when sliders change
  useEffect(() => {
    setFpsText(String(localQuality.maxFps));
  }, [localQuality.maxFps]);

  useEffect(() => {
    setBitrateText(String(localQuality.videoBitrateKbps));
  }, [localQuality.videoBitrateKbps]);

  // Listen for keyboard shortcut S to toggle settings panel, and Escape to close
  useEffect(() => {
    if (contentOnly) return;
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
  }, [localQuality, onRequestChange, requestPending]);

  const handleClear = useCallback(() => {
    if (requestPending) return;
    onRequestChange(null);
  }, [onRequestChange, requestPending]);

  const handleFpsTextChange = useCallback((text: string) => {
    setFpsText(text);
    const v = parseInt(text, 10);
    if (Number.isFinite(v) && v >= 1 && v <= 60) {
      setLocalQuality((prev) => ({ ...prev, maxFps: clamp(Math.round(v), 1, 60) }));
    }
  }, []);

  const handleFpsTextBlur = useCallback(() => {
    const v = parseInt(fpsText, 10);
    if (!Number.isFinite(v) || v < 1) {
      const clamped = 1;
      setFpsText(String(clamped));
      setLocalQuality((prev) => ({ ...prev, maxFps: clamped }));
    } else if (v > 60) {
      setFpsText("60");
      setLocalQuality((prev) => ({ ...prev, maxFps: 60 }));
    } else {
      setLocalQuality((prev) => ({ ...prev, maxFps: clamp(Math.round(v), 1, 60) }));
    }
  }, [fpsText]);

  const handleBitrateTextChange = useCallback((text: string) => {
    setBitrateText(text);
    const v = parseInt(text, 10);
    if (Number.isFinite(v) && v >= 100 && v <= effectiveMaxBitrate) {
      setLocalQuality((prev) => ({ ...prev, videoBitrateKbps: clamp(Math.round(v), 100, effectiveMaxBitrate) }));
    }
  }, [effectiveMaxBitrate]);

  const handleBitrateTextBlur = useCallback(() => {
    const v = parseInt(bitrateText, 10);
    if (!Number.isFinite(v) || v < 100) {
      setBitrateText("100");
      setLocalQuality((prev) => ({ ...prev, videoBitrateKbps: 100 }));
    } else if (v > effectiveMaxBitrate) {
      setBitrateText(String(effectiveMaxBitrate));
      setLocalQuality((prev) => ({ ...prev, videoBitrateKbps: effectiveMaxBitrate }));
    } else {
      setLocalQuality((prev) => ({ ...prev, videoBitrateKbps: clamp(Math.round(v), 100, effectiveMaxBitrate) }));
    }
  }, [bitrateText, effectiveMaxBitrate]);

  const applyPreset = useCallback((preset: ViewerRequestState) => {
    setLocalQuality(preset);
    setFpsText(String(preset.maxFps));
    setBitrateText(String(preset.videoBitrateKbps));
  }, []);

  const isCustom = requestState === null;

  //  Algorithm helper 
  const algorithm = enhancementSettings.webglScalingAlgorithm ?? "native";
  const isFsr = algorithm === "fsr1-easu";

  const content = (
    <Tabs defaultValue="general" className="w-full">
      {variant === "B" && (
        <div className="text-[10px] font-medium text-accent/80 uppercase tracking-wide mb-2 pb-1 border-b border-accent/20">
          Comparison Configuration B
        </div>
      )}
      <TabsList className="w-full mb-2">
        <TabsTrigger value="general" className="flex-1 text-xs">General</TabsTrigger>
        <TabsTrigger value="enhancements" className="flex-1 text-xs">Image Enhancements</TabsTrigger>
      </TabsList>

      {/*  General tab (existing quality controls)  */}
      <TabsContent value="general" className="mt-0">
        <div className="grid grid-cols-2 gap-3">
          {qualityPresets.length > 0 && (
            <div className="col-span-2 sm:col-span-1">
              <p className="text-[10px] text-text-muted uppercase tracking-wide mb-1.5">Presets</p>
              <div className="flex flex-wrap gap-1">
                {qualityPresets.map((preset) => {
                  const video = preset.settings.video as Record<string, unknown>;
                  const pw = video.sendWidth as number;
                  const ph = video.sendHeight as number;
                  const pf = video.sendFps as number;
                  const pb = video.videoBitrateKbps as number;
                  const isMatch = localQuality.maxWidth === pw &&
                    localQuality.maxHeight === ph &&
                    localQuality.maxFps === pf &&
                    localQuality.videoBitrateKbps === pb;
                  return (
                    <button
                      key={preset.id}
                      className={cn(
                        "px-2 py-0.5 rounded-standard text-[10px] transition-colors border",
                        isMatch
                          ? "bg-accent/10 border-accent/30 text-text-primary"
                          : "bg-surface-2 border-border-subtle text-text-muted hover:text-text-secondary",
                      )}
                      onClick={() => applyPreset({
                        videoBitrateKbps: pb,
                        maxWidth: pw,
                        maxHeight: ph,
                        maxFps: pf,
                      })}
                      disabled={requestPending}
                    >
                      {preset.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className={cn(qualityPresets.length > 0 ? "col-span-2 sm:col-span-1" : "col-span-2")}>
            <p className="text-[10px] text-text-muted uppercase tracking-wide mb-1.5">Quick</p>
            <div className="flex flex-wrap gap-1">
              {VIEWER_REQUEST_PRESETS.map((preset) => {
                const isMatch = requestState !== null &&
                  requestState.videoBitrateKbps === preset.value.videoBitrateKbps &&
                  requestState.maxWidth === preset.value.maxWidth &&
                  requestState.maxFps === preset.value.maxFps;
                return (
                  <button
                    key={preset.label}
                    className={cn(
                      "px-2 py-0.5 rounded-standard text-[10px] transition-colors border",
                      isMatch
                        ? "bg-accent/10 border-accent/30 text-text-primary"
                        : "bg-surface-2 border-border-subtle text-text-muted hover:text-text-secondary",
                    )}
                    onClick={() => applyPreset(preset.value)}
                    disabled={requestPending}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="col-span-2">
            <p className="text-[10px] text-text-muted uppercase tracking-wide mb-1.5">Resolution</p>
            <div className="flex flex-wrap gap-1">
              {RESOLUTION_CHOICES.map((r) => (
                <button
                  key={r.label}
                  className={cn(
                    "px-2.5 py-1 rounded-standard text-[11px] transition-colors border",
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

          <div className="col-span-2 grid grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-text-muted uppercase tracking-wide">FPS</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1">
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
                <Input
                  type="number"
                  value={fpsText}
                  onChange={(e) => handleFpsTextChange(e.target.value)}
                  onBlur={handleFpsTextBlur}
                  min={1}
                  max={60}
                  className="w-16 h-7 text-xs text-center font-mono"
                  disabled={requestPending}
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-text-muted uppercase tracking-wide">Bitrate</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <Slider
                    value={[localQuality.videoBitrateKbps]}
                    onValueChange={([v]) => setLocalQuality((prev) => ({ ...prev, videoBitrateKbps: clamp(Math.round(v), 100, effectiveMaxBitrate) }))}
                    min={100}
                    max={effectiveMaxBitrate}
                    step={50}
                    aria-label="Requested bitrate"
                    className="[&>div]:h-1"
                  />
                </div>
                <Input
                  type="number"
                  value={bitrateText}
                  onChange={(e) => handleBitrateTextChange(e.target.value)}
                  onBlur={handleBitrateTextBlur}
                  min={100}
                  max={effectiveMaxBitrate}
                  className="w-20 h-7 text-xs text-center font-mono"
                  disabled={requestPending}
                />
              </div>
            </div>
          </div>

          <div className="col-span-2 flex items-center gap-2 pt-1">
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

          {requestFeedback && (
            <p className={cn(
              "col-span-2 text-xs",
              lastRequestAccepted === false ? "text-danger" : "text-text-secondary",
            )}>
              {requestFeedback}
            </p>
          )}
        </div>
      </TabsContent>

      {/*  Image Enhancements tab  */}
      <TabsContent value="enhancements" className="mt-0 max-h-[60vh] overflow-y-auto">
        <div className="space-y-3">
          {/* Master toggle */}
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-text-muted uppercase tracking-wide">GPU Image Enhancements</span>
            <Switch
              checked={enhancementSettings.enabled}
              onCheckedChange={(checked) =>
                onEnhancementChange({ ...enhancementSettings, enabled: checked })
              }
              aria-label="Toggle GPU Image Enhancements"
            />
          </div>

          {/* Processing Backend + WebGL Scaler side by side */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-text-muted uppercase tracking-wide">Processing Backend</span>
              </div>
              <select
                className="w-full h-8 rounded-standard text-xs bg-surface-2 border border-border-subtle text-text-primary px-2"
                value={enhancementSettings.processingBackend ?? "webgl2"}
                onChange={(e) =>
                  onEnhancementChange({
                    ...enhancementSettings,
                    processingBackend: e.target.value as ProcessingBackend,
                  })
                }
                disabled={!enhancementSettings.enabled || benchmarkRunning}
                aria-label="Processing Backend"
              >
                {PROCESSING_BACKENDS.map((backend) => (
                  <option key={backend} value={backend}>
                    {PROCESSING_BACKEND_LABELS[backend]}
                  </option>
                ))}
              </select>
              {fallbackReason && (
                <p className="text-[10px] text-amber-500 mt-1">{fallbackReason}</p>
              )}
              {effectiveBackend && effectiveBackend !== enhancementSettings.processingBackend && (
                <p className="text-[10px] text-text-muted mt-0.5">
                  Active: {effectiveBackend}
                </p>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-text-muted uppercase tracking-wide">WebGL Scaler</span>
              </div>
              <select
                className="w-full h-8 rounded-standard text-xs bg-surface-2 border border-border-subtle text-text-primary px-2"
                value={enhancementSettings.webglScalingAlgorithm ?? "native"}
                onChange={(e) =>
                  onEnhancementChange({
                    ...enhancementSettings,
                    webglScalingAlgorithm: e.target.value as ScalingAlgorithm,
                  })
                }
                disabled={!enhancementSettings.enabled || benchmarkRunning}
                aria-label="WebGL Scaler"
              >
                {SCALING_ALGORITHMS.map((algo) => (
                  <option key={algo} value={algo}>
                    {SCALING_ALGORITHM_LABELS[algo]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* WebGL-only controls — hidden when NVIDIA backend is selected */}
          {enhancementSettings.processingBackend !== "nvidia-vsr" && (
            <>
              <hr className="border-border-subtle" />

              {/* Sliders in a 2-column grid */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <EnhancementSliderControl
                  label="Sharpness"
                  value={enhancementSettings.sharpeningStrength}
                  disabled={!enhancementSettings.enabled || benchmarkRunning}
                  onChange={(v) => onEnhancementChange({ ...enhancementSettings, sharpeningStrength: v })}
                />

                <EnhancementSliderControl
                  label="Noise Protection"
                  value={enhancementSettings.noiseProtection}
                  disabled={!enhancementSettings.enabled || benchmarkRunning}
                  onChange={(v) => onEnhancementChange({ ...enhancementSettings, noiseProtection: v })}
                />

                <EnhancementSliderControl
                  label="Compression Cleanup"
                  value={enhancementSettings.compressionCleanup}
                  disabled={!enhancementSettings.enabled || benchmarkRunning}
                  onChange={(v) => onEnhancementChange({ ...enhancementSettings, compressionCleanup: v })}
                />

                <EnhancementSliderControl
                  label="Debanding"
                  value={enhancementSettings.debanding}
                  disabled={!enhancementSettings.enabled || benchmarkRunning}
                  onChange={(v) => onEnhancementChange({ ...enhancementSettings, debanding: v })}
                />
              </div>

              {/* FSR Target Scale  only when FSR 1 EASU is selected */}
              {isFsr && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-text-muted uppercase tracking-wide">FSR Target Scale</span>
                  </div>
                  <select
                    className="w-full h-8 rounded-standard text-xs bg-surface-2 border border-border-subtle text-text-primary px-2"
                    value={enhancementSettings.fsrTargetScale}
                    onChange={(e) =>
                      onEnhancementChange({
                        ...enhancementSettings,
                        fsrTargetScale: parseFsrTargetScale(e.target.value),
                      })
                    }
                    disabled={!enhancementSettings.enabled || benchmarkRunning}
                    aria-label="FSR Target Scale"
                  >
                    {FSR_TARGET_SCALES.map((s) => (
                      <option key={s} value={s}>
                        {FSR_TARGET_SCALE_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* FSR Final Scaler  only when FSR is selected */}
              {isFsr && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-text-muted uppercase tracking-wide">FSR Final Scaler</span>
                  </div>
                  <select
                    className="w-full h-8 rounded-standard text-xs bg-surface-2 border border-border-subtle text-text-primary px-2"
                    value={enhancementSettings.fsrFinalScaler}
                    onChange={(e) =>
                      onEnhancementChange({
                        ...enhancementSettings,
                        fsrFinalScaler: e.target.value as FsrFinalScaler,
                      })
                    }
                    disabled={!enhancementSettings.enabled || benchmarkRunning}
                    aria-label="FSR Final Scaler"
                  >
                    {FSR_FINAL_SCALERS.map((s) => (
                      <option key={s} value={s}>
                        {FSR_FINAL_SCALER_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}

          {/* NVIDIA RTX Video Settings */}
          {enhancementSettings.processingBackend === "nvidia-vsr" && (
            <>
              <hr className="border-border-subtle" />
              <p className="text-[10px] text-text-muted uppercase tracking-wide mb-1">NVIDIA RTX Video</p>
              <NvidiaCapabilityStatus />

              {/* Processing Mode */}
              <div className="mb-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-text-muted uppercase tracking-wide">Processing Mode</span>
                </div>
                <select
                  className="w-full h-8 rounded-standard text-xs bg-surface-2 border border-border-subtle text-text-primary px-2"
                  value={enhancementSettings.nvidiaMode ?? "vsr"}
                  onChange={(e) =>
                    onEnhancementChange({
                      ...enhancementSettings,
                      nvidiaMode: e.target.value as NvidiaProcessingMode,
                    })
                  }
                  disabled={!enhancementSettings.enabled || benchmarkRunning}
                  aria-label="NVIDIA Processing Mode"
                >
                  {NVIDIA_PROCESSING_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {NVIDIA_PROCESSING_MODE_LABELS[mode]}
                    </option>
                  ))}
                </select>
              </div>

              {/* Quality Level */}
              <div className="mb-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-text-muted uppercase tracking-wide">Quality</span>
                </div>
                <select
                  className="w-full h-8 rounded-standard text-xs bg-surface-2 border border-border-subtle text-text-primary px-2"
                  value={enhancementSettings.nvidiaQuality ?? "high"}
                  onChange={(e) =>
                    onEnhancementChange({
                      ...enhancementSettings,
                      nvidiaQuality: e.target.value as NvidiaQuality,
                    })
                  }
                  disabled={!enhancementSettings.enabled || benchmarkRunning}
                  aria-label="NVIDIA Quality Level"
                >
                  {NVIDIA_QUALITIES.map((q) => (
                    <option key={q} value={q}>
                      {NVIDIA_QUALITY_LABELS[q]}
                    </option>
                  ))}
                </select>
              </div>

              {/* Output policy (read-only) */}
              <div className="text-[10px] text-text-muted mb-2">
                Output:{' '}
                {(enhancementSettings.nvidiaMode === "vsr" || enhancementSettings.nvidiaMode === "high-bitrate")
                  ? "2× source resolution"
                  : "Same-resolution processing"}
              </div>

              {/* Active QualityLevel display */}
              {(enhancementSettings.enabled && enhancementStats) && (
                <div className="text-[10px] text-text-muted mb-2">
                  Active QualityLevel:{' '}
                  <span className="font-mono text-text-secondary">
                    {enhancementStats.nativeQualityLevel ?? "—"}
                  </span>
                </div>
              )}
            </>
          )}
          {/*  Benchmark trigger / progress / results  */}
          <BenchmarkSection
            benchmarkRunning={benchmarkRunning}
            benchmarkProgress={benchmarkProgress}
            onRunBenchmark={onRunBenchmark}
            onCancelBenchmark={onCancelBenchmark}
            onApplyBenchmarkRecommendation={onApplyBenchmarkRecommendation}
            enhancementSettings={enhancementSettings}
            onEnhancementChange={onEnhancementChange}
          />

          <div className="pt-1">
            <Button
              variant="outline"
              size="sm"
              className="w-full text-xs"
              onClick={onEnhancementReset}
              disabled={benchmarkRunning}
            >
              Reset to Defaults
            </Button>
          </div>

          {/*  Processing statistics  */}
              {enhancementSettings.enabled && enhancementStats && (
            <div className="pt-2 border-t border-border-subtle">
              <p className="text-[10px] text-text-muted uppercase tracking-wide mb-2">Processing Stats</p>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                <span className="text-text-muted">Input</span>
                <span className="text-text-secondary font-mono text-right">
                  {enhancementStats.inputWidth}x{enhancementStats.inputHeight}
                </span>
                {enhancementStats.easuTargetWidth != null && enhancementStats.easuTargetWidth > 0 && (
                  <>
                    <span className="text-text-muted">EASU Target</span>
                    <span className="text-text-secondary font-mono text-right">
                      {enhancementStats.easuTargetWidth}x{enhancementStats.easuTargetHeight}
                    </span>
                  </>
                )}
                <span className="text-text-muted">Display</span>
                <span className="text-text-secondary font-mono text-right">
                  {enhancementStats.outputWidth}x{enhancementStats.outputHeight}
                </span>
                {enhancementStats.finalBicubicActive != null && (
                  <>
                    <span className="text-text-muted">Final Scaling</span>
                    <span className="text-text-secondary font-mono text-right">
                      {enhancementStats.finalBicubicActive
                        ? (enhancementStats.fsrFinalScaler
                          ? FSR_FINAL_SCALER_LABELS[enhancementStats.fsrFinalScaler]
                          : (enhancementStats.scalingAlgorithm === "lanczos" ? "Lanczos 3" : "Bicubic"))
                        : enhancementStats.easuTargetWidth ? "EASU only" : "Native"}
                    </span>
                  </>
                )}
                {enhancementStats.fsrFinalScaler != null && (
                  <>
                    <span className="text-text-muted">FSR Final Scaler</span>
                    <span className="text-text-secondary font-mono text-right">
                      {FSR_FINAL_SCALER_LABELS[enhancementStats.fsrFinalScaler] ?? enhancementStats.fsrFinalScaler}
                    </span>
                  </>
                )}
                {enhancementStats.rcasActive != null && (
                  <>
                    <span className="text-text-muted">RCAS</span>
                    <span className="text-text-secondary font-mono text-right">
                      {enhancementStats.rcasActive ? "Active" : "Off"}
                    </span>
                  </>
                )}
                {enhancementStats.activePasses && enhancementStats.activePasses.length > 0 && (
                  <>
                    <span className="text-text-muted">Passes</span>
                    <span className="text-text-secondary font-mono text-right text-[10px]">
                      {enhancementStats.activePasses.join("  ")}
                    </span>
                  </>
                )}
                <span className="text-text-muted">Backend</span>
                <span className="text-text-secondary font-mono text-right">
                  {enhancementStats.backend}
                </span>
                {enhancementStats.backpressureDrops != null && (
                  <>
                    <span className="text-text-muted">Backpressure Drops</span>
                    <span className="text-text-secondary font-mono text-right">
                      {enhancementStats.backpressureDrops}
                    </span>
                  </>
                )}
                {enhancementStats.generation != null && (
                  <>
                    <span className="text-text-muted">Generation</span>
                    <span className="text-text-secondary font-mono text-right">
                      {enhancementStats.generation}
                    </span>
                  </>
                )}
                {/* Honest timing labels—never label native round-trip as GPU Time */}
                {enhancementStats.backend === "nvidia-vsr" ? (
                  <>
                    <span className="text-text-muted">Native Round Trip</span>
                    <span className="text-text-secondary font-mono text-right">
                      {enhancementStats.processingTimeMs != null
                        ? `${enhancementStats.processingTimeMs.toFixed(2)} ms`
                        : "N/A"}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="text-text-muted">GPU Time</span>
                    <span className="text-text-secondary font-mono text-right">
                      {enhancementStats.processingTimeMs != null
                        ? `${enhancementStats.processingTimeMs.toFixed(2)} ms`
                        : "N/A"}
                    </span>
                  </>
                )}
                <span className="text-text-muted">Algorithm</span>
                <span className="text-text-secondary font-mono text-right">
                  {enhancementStats.backend === "nvidia-vsr"
                    ? "NVIDIA RTX Video"
                    : enhancementStats.scalingAlgorithm
                      ? SCALING_ALGORITHM_LABELS[enhancementStats.scalingAlgorithm] ?? enhancementStats.scalingAlgorithm
                      : enhancementStats.enhancedScalingActive ? "Enhanced" : "Native"}
                </span>

                {/* Phase 1: Expanded NVIDIA statistics with Phase 6 rolling stats */}
                {enhancementStats.backend === "nvidia-vsr" && (
                  <>
                    <span className="text-text-muted">Frames Displayed</span>
                    <span className="text-text-secondary font-mono text-right">
                      {enhancementStats.framesDisplayed ?? enhancementStats.framesProcessed}
                    </span>

                    <span className="text-text-muted">Completed FPS</span>
                    <span className="text-text-secondary font-mono text-right">
                      {enhancementStats.completedFps != null
                        ? `${enhancementStats.completedFps.toFixed(1)}`
                        : "—"}
                    </span>

                    <span className="text-text-muted">Capture/Readback (avg)</span>
                    <span className="text-text-secondary font-mono text-right">
                      {enhancementStats.captureReadbackTimeMs != null
                        ? `${enhancementStats.captureReadbackTimeMs.toFixed(2)} ms`
                        : "—"}
                    </span>

                    <span className="text-text-muted">Native Effect (round trip)</span>
                    <span className="text-text-secondary font-mono text-right">
                      {enhancementStats.nativeTransportProcessingTimeMs != null
                        ? `${enhancementStats.nativeTransportProcessingTimeMs.toFixed(2)} ms`
                        : "—"}
                    </span>

                    <span className="text-text-muted">Display Upload</span>
                    <span className="text-text-secondary font-mono text-right">
                      {enhancementStats.displayUploadTimeMs != null
                        ? `${enhancementStats.displayUploadTimeMs.toFixed(2)} ms`
                        : "—"}
                    </span>

                    <span className="text-text-muted">Total Latency (avg)</span>
                    <span className="text-text-secondary font-mono text-right">
                      {enhancementStats.totalEnhancedFrameLatencyMs != null
                        ? `${enhancementStats.totalEnhancedFrameLatencyMs.toFixed(2)} ms`
                        : "—"}
                    </span>

                    {/* Phase 6: Rolling window statistics */}
                    {enhancementStats.avgNativeRoundTripMs != null && (
                      <>
                        <span className="text-text-muted">Native Effect (avg)</span>
                        <span className="text-text-secondary font-mono text-right">
                          {enhancementStats.avgNativeRoundTripMs.toFixed(2)} ms
                        </span>
                      </>
                    )}
                    {enhancementStats.p50NativeRoundTripMs != null && (
                      <>
                        <span className="text-text-muted">Native Effect (p50)</span>
                        <span className="text-text-secondary font-mono text-right">
                          {enhancementStats.p50NativeRoundTripMs.toFixed(2)} ms
                        </span>
                      </>
                    )}
                    {enhancementStats.p95NativeRoundTripMs != null && (
                      <>
                        <span className="text-text-muted">Native Effect (p95)</span>
                        <span className="text-text-secondary font-mono text-right">
                          {enhancementStats.p95NativeRoundTripMs.toFixed(2)} ms
                        </span>
                      </>
                    )}
                    {enhancementStats.avgTotalLatencyMs != null && (
                      <>
                        <span className="text-text-muted">E2E Latency (avg)</span>
                        <span className="text-text-secondary font-mono text-right">
                          {enhancementStats.avgTotalLatencyMs.toFixed(2)} ms
                        </span>
                      </>
                    )}
                    {(enhancementStats.windowSampleCount ?? 0) > 0 && (
                      <>
                        <span className="text-text-muted">Window Samples</span>
                        <span className="text-text-secondary font-mono text-right">
                          {enhancementStats.windowSampleCount ?? 0}
                        </span>
                      </>
                    )}

                    <span className="text-text-muted">Native Output</span>
                    <span className="text-text-secondary font-mono text-right">
                      {enhancementStats.nativeOutputWidth != null && enhancementStats.nativeOutputWidth > 0
                        ? `${enhancementStats.nativeOutputWidth}x${enhancementStats.nativeOutputHeight}`
                        : `${enhancementStats.outputWidth}x${enhancementStats.outputHeight}`}
                    </span>

                    {"nativeQualityLevel" in enhancementStats && enhancementStats.nativeQualityLevel != null && (
                      <>
                        <span className="text-text-muted">QualityLevel</span>
                        <span className="text-text-secondary font-mono text-right">
                          {enhancementStats.nativeQualityLevel}
                        </span>
                      </>
                    )}

                    <span className="text-text-muted">Scheduler Drops</span>
                    <span className="text-text-secondary font-mono text-right">
                      {enhancementStats.schedulerDrops ?? 0}
                    </span>

                    <span className="text-text-muted">Native Failures</span>
                    <span className="text-text-secondary font-mono text-right">
                      {enhancementStats.nativeFailures ?? 0}
                    </span>

                    {/* Phase 6: Processor-level counters */}
                    <span className="text-text-muted">Processing Attempts</span>
                    <span className="text-text-secondary font-mono text-right">
                      {enhancementStats.processingAttempts ?? enhancementStats.framesProcessed}
                    </span>
                    <span className="text-text-muted">Coalesced Frames</span>
                    <span className="text-text-secondary font-mono text-right">
                      {enhancementStats.coalescedFrames ?? 0}
                    </span>
                    <span className="text-text-muted">Backend Drops</span>
                    <span className="text-text-secondary font-mono text-right">
                      {enhancementStats.backpressureDrops ?? 0}
                    </span>
                    <span className="text-text-muted">Stale-Gen Results</span>
                    <span className="text-text-secondary font-mono text-right">
                      {enhancementStats.staleGenerationDrops ?? 0}
                    </span>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </TabsContent>
    </Tabs>
  );

  if (contentOnly) {
    const containerClass = variant === "B"
      ? "w-[750px] p-4 max-h-[80vh] overflow-y-auto border-l-2 border-accent/30 bg-accent/[0.02]"
      : "w-[750px] p-4 max-h-[80vh] overflow-y-auto";
    return <div className={containerClass}>{content}</div>;
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-[750px] p-4 max-h-[80vh] overflow-y-auto">
        {content}
      </PopoverContent>
    </Popover>
  );
}
