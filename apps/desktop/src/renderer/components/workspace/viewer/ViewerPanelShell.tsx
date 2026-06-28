import { useMemo } from "react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { ViewerSettingsPanel, type ViewerRequestState } from "./ViewerSettingsPanel.js";
import { DiagnosticsPanel } from "./DiagnosticsPanel.js";
import { BandwidthGraphModal } from "../BandwidthGraphModal.js";
import type { ViewerSession } from "@/services/viewer-session.js";
import type { ViewerImageEnhancementSettings, FsrFinalScaler, ScalingAlgorithm } from "@/services/viewer-image-processing/viewer-image-settings";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ActivePanel = "settings" | "diagnostics" | "bandwidth";

interface ViewerPanelShellProps {
  activePanel: ActivePanel | null;
  onActivePanelChange: (panel: ActivePanel | null) => void;

  // DiagnosticsPanel props
  session: ViewerSession | null;
  lastRequestedQuality?: ViewerRequestState | null;
  effectiveBitrateKbps?: number | null;
  configuredBitrateBps?: number | null;

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
}

// ─── ViewerPanelShell ───────────────────────────────────────────────────────

/**
 * ViewerPanelShell — Unified Popover wrapper for settings, diagnostics,
 * and bandwidth panels. Manages a single `activePanel` state so that
 * only one panel is open at a time.
 *
 * Uses a hidden PopoverAnchor at the bottom-center of the viewer stage
 * for consistent positioning across all three panels.
 */
export function ViewerPanelShell({
  activePanel,
  onActivePanelChange,

  // Diagnostics
  session,
  lastRequestedQuality,
  effectiveBitrateKbps,
  configuredBitrateBps,

  // Settings
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

  // Bandwidth
  mediaSessionId,
  viewerHistoryId = null,
}: ViewerPanelShellProps) {
  const width =
    activePanel === "bandwidth" ? "w-[950px]" : "w-[750px]";

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
      {/* Hidden anchor at bottom-center for popover positioning above controls */}
      <PopoverAnchor asChild>
        <div className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 opacity-0 pointer-events-none" />
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="center"
        className={`${width} p-4 max-h-[85vh] overflow-y-auto`}
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
          >
            <span />
          </ViewerSettingsPanel>
        )}
        {activePanel === "diagnostics" && (
          <DiagnosticsPanel
            contentOnly
            session={session}
            lastRequestedQuality={lastRequestedQuality}
            effectiveBitrateKbps={effectiveBitrateKbps}
            configuredBitrateBps={configuredBitrateBps}
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
