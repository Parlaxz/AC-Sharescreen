import { Fragment, useMemo } from "react";
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
  children: React.ReactNode;

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

export function ViewerPanelShell({
  activePanel,
  onActivePanelChange,
  children,
  session,
  lastRequestedQuality,
  effectiveBitrateKbps,
  configuredBitrateBps,
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
}: ViewerPanelShellProps) {
  const width =
    activePanel === "bandwidth" ? "w-[950px] max-w-[calc(100vw-32px)]" : "w-[750px] max-w-[calc(100vw-32px)]";

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
