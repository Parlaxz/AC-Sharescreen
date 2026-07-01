import { Fragment, useMemo, useCallback } from "react";
import { useSyncExternalStore } from "react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { ViewerSettingsPanel, type ViewerRequestState, type MediaMode } from "./ViewerSettingsPanel.js";
import { DiagnosticsPanel } from "./DiagnosticsPanel.js";
import { BandwidthGraphModal } from "../BandwidthGraphModal.js";
import type { ViewerSession } from "@/services/viewer-session.js";
import type { ViewerImageEnhancementSettings, FsrFinalScaler, ScalingAlgorithm } from "@/services/viewer-image-processing/viewer-image-settings";
import type { BenchmarkProgress } from "@/services/viewer-image-processing/nvidia-benchmark-service";
import type { BandwidthSnapshot } from "@/services/bandwidth-telemetry-types";
import type { FramePerformanceSample } from "./FramePerformanceGraph.js";
import { StreamMetricsService } from "@/services/stream-metrics-service";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ActivePanel = "settings" | "diagnostics" | "bandwidth";

interface ViewerPanelShellProps {
  activePanel: ActivePanel | null;
  onActivePanelChange: (panel: ActivePanel | null) => void;
  children: React.ReactNode;

  // DiagnosticsPanel props
  /** @deprecated Use diagnosticsSnapshot instead — kept for backward compat */
  session: ViewerSession | null;
  lastRequestedQuality?: ViewerRequestState | null;
  effectiveBitrateKbps?: number | null;
  configuredBitrateBps?: number | null;
  /** The requested/preferred codec (from viewer configuration) */
  requestedCodec?: string | null;

  // New diagnostics data (snapshot-based, no polling)
  /** Bandwidth snapshot from StreamMetricsService (or subscribe via viewerHistoryId) */
  diagnosticsSnapshot?: BandwidthSnapshot | null;
  /** Frame timing samples for performance graph */
  framePerformanceSamples?: FramePerformanceSample[];

  // ViewerSettingsPanel props
  requestState: ViewerRequestState | null;
  onRequestChange: (state: ViewerRequestState | null) => void;
  requestPending?: boolean;
  lastRequestAccepted?: boolean | undefined;
  requestFeedback?: string | null;
  enhancementSettings: ViewerImageEnhancementSettings;
  onEnhancementChange: (settings: ViewerImageEnhancementSettings) => void;
  onEnhancementReset: () => void;
  effectiveBackend?: string;
  fallbackReason?: string;
  enhancementStats?: {
    inputWidth: number;
    inputHeight: number;
    outputWidth: number;
    outputHeight: number;
    processingTimeMs: number | null;
    enhancedScalingActive: boolean;
    backend: string;
    scalingAlgorithm?: ScalingAlgorithm;
    easuTargetWidth?: number;
    easuTargetHeight?: number;
    finalBicubicActive?: boolean;
    fsrFinalScaler?: FsrFinalScaler | null;
    rcasActive?: boolean;
    activePasses?: string[];
    backpressureDrops?: number;
    generation?: number;
  } | null;

  // BandwidthGraphModal props
  mediaSessionId: string | null;
  viewerHistoryId?: string | null;

  // ── Media mode props ────────────────────────────────────────────────
  mediaMode?: MediaMode;
  onMediaModeChange?: (mode: MediaMode) => void;

  // ── Benchmark props ─────────────────────────────────────────────────
  benchmarkRunning?: boolean;
  benchmarkProgress?: BenchmarkProgress | null;
  onRunBenchmark?: () => void;
  onCancelBenchmark?: () => void;
  onApplyBenchmarkRecommendation?: () => void;
}

// ─── Snapshot subscription hook ─────────────────────────────────────────────

const EMPTY_SNAPSHOT: BandwidthSnapshot = Object.freeze({
  historyId: "",
  role: "viewer" as const,
  aggregate: Object.freeze({
    rawSamples: Object.freeze([]),
    mediumBuckets: Object.freeze([]),
    longBuckets: Object.freeze([]),
    markers: Object.freeze([]),
    currentBitsPerSecond: 0,
    averageBitsPerSecond: 0,
    peakBitsPerSecond: 0,
    totalBytes: 0,
    durationMs: 0,
    activeDurationMs: 0,
    configuredBitsPerSecond: null,
    effectiveBitsPerSecond: null,
    currentVideoBitsPerSecond: null,
    currentAudioBitsPerSecond: null,
    currentTransportBitsPerSecond: null,
    state: "paused" as const,
  }),
  connections: Object.freeze([]),
});

function useBandwidthSnapshot(historyId: string | null): BandwidthSnapshot | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!historyId) return () => {};
      return StreamMetricsService.getInstance().subscribe(historyId, onStoreChange);
    },
    [historyId],
  );

  const getSnapshot = useCallback(() => {
    if (!historyId) return null;
    return StreamMetricsService.getInstance().getSnapshot(historyId);
  }, [historyId]);

  return useSyncExternalStore(subscribe, getSnapshot);
}

// ─── ViewerPanelShell ───────────────────────────────────────────────────────

export function ViewerPanelShell({
  activePanel,
  onActivePanelChange,
  children,
  session: _session, // kept for backward compat, unused
  lastRequestedQuality,
  effectiveBitrateKbps,
  configuredBitrateBps,
  requestedCodec,
  diagnosticsSnapshot: externalSnapshot,
  framePerformanceSamples = [],
  requestState,
  onRequestChange,
  requestPending = false,
  lastRequestAccepted,
  requestFeedback,
  enhancementSettings,
  onEnhancementChange,
  onEnhancementReset,
  effectiveBackend,
  fallbackReason,
  enhancementStats = null,
  mediaSessionId,
  viewerHistoryId = null,
  benchmarkRunning = false,
  benchmarkProgress = null,
  onRunBenchmark = () => {},
  onCancelBenchmark = () => {},
  onApplyBenchmarkRecommendation = () => {},
  mediaMode,
  onMediaModeChange,
}: ViewerPanelShellProps) {
  // Subscribe internally if no external snapshot provided
  const internalSnapshot = useBandwidthSnapshot(
    externalSnapshot === undefined ? viewerHistoryId : null,
  );
  const diagnosticsSnapshot: BandwidthSnapshot | null =
    externalSnapshot !== undefined ? externalSnapshot : internalSnapshot;

  const width =
    activePanel === "bandwidth" ? "w-[950px] max-w-[calc(100vw-32px)]" :
    activePanel === "diagnostics" ? "w-[820px] max-w-[calc(100vw-32px)]" :
    "w-[750px] max-w-[calc(100vw-32px)]";

  const handleOpenChange = useMemo(
    () => (open: boolean) => {
      if (!open) onActivePanelChange(null);
    },
    [onActivePanelChange],
  );

  return (
    <Popover
      open={activePanel !== null}
      onOpenChange={handleOpenChange}
    >
      <PopoverAnchor asChild>
        <div data-viewer-controls-anchor className="absolute inset-x-0 bottom-0">
          {children}
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="center"
        collisionPadding={16}
        className={`${width} p-4`}
      >
          {activePanel === "settings" && (
            <ViewerSettingsPanel
              contentOnly
              requestState={requestState}
              onRequestChange={onRequestChange}
              requestPending={requestPending}
              lastRequestAccepted={lastRequestAccepted}
              requestFeedback={requestFeedback}
              enhancementSettings={enhancementSettings}
              onEnhancementChange={onEnhancementChange}
              onEnhancementReset={onEnhancementReset}
              effectiveBackend={effectiveBackend}
              fallbackReason={fallbackReason}
              enhancementStats={enhancementStats}
              hideQuality
              benchmarkRunning={benchmarkRunning}
              benchmarkProgress={benchmarkProgress}
              onRunBenchmark={onRunBenchmark}
              onCancelBenchmark={onCancelBenchmark}
              onApplyBenchmarkRecommendation={onApplyBenchmarkRecommendation}
              mediaMode={mediaMode}
              onMediaModeChange={onMediaModeChange}
            >
              <span />
            </ViewerSettingsPanel>
          )}
          {activePanel === "diagnostics" && (
            <DiagnosticsPanel
              contentOnly
              snapshot={diagnosticsSnapshot}
              frameSamples={framePerformanceSamples}
              requestedQuality={lastRequestedQuality}
              effectiveBitrateKbps={effectiveBitrateKbps}
              configuredBitrateBps={configuredBitrateBps}
              requestedCodec={requestedCodec}
            >
              <span />
            </DiagnosticsPanel>
          )}
          {activePanel === "bandwidth" && (
            <BandwidthGraphModal
              contentOnly
              open={false}
              onOpenChange={() => {}}
              mediaSessionId={mediaSessionId}
              viewerMode
              viewerHistoryId={viewerHistoryId}
            />
          )}
      </PopoverContent>
    </Popover>
  );
}
