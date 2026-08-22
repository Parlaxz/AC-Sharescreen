/**
 * Screen-sharing source types and start-share input contracts
 * shared between renderer services and the IPC boundary.
 */

/** Audio mode for a share session */
export type AudioModeValue = "none" | "monitor" | "application";

/** Source descriptor from the system capture picker */
export interface ShareSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  displayId?: string | null;
  fingerprint?: string | null;
  /** Audio mode selected for this source (if applicable) */
  audioMode?: "none" | "monitor" | "application";
}

/**
 * Typed input for the shared start transaction.
 * Used by ShareSetup, QuickShareDialog, and the share coordinator.
 */
export interface StartShareInput {
  groupId: string;
  source: ShareSource;
  qualityOverride?: {
    videoBitrateKbps?: number;
    sendWidth?: number;
    sendHeight?: number;
    sendFps?: number;
    captureWidth?: number;
    captureHeight?: number;
    captureFps?: number;
    codec?: string;
    contentHint?: string;
    degradationPreference?: string;
  };
}
