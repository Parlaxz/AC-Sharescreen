import type { Phase3Runtime } from "./phase3-runtime.js";
import {
  type GroupQualitySettings,
  type HostQualityLimits,
  classifySettingsDiff,
  diffGroupSettings,
} from "@screenlink/shared";
import { applySenderSettings } from "./quality-coordinator.js";

/**
 * GroupSettingsLiveApply (Gate 9.5)
 *
 * Classifies a group settings change and applies the live-safe fields
 * to every exact active viewer sender via the ViewerMediaBinding.
 * Restart-required fields produce a "Restart All Streams" banner via
 * the RestartCoordinator.
 *
 * Live-safe fields (per Gate 9.5 / 9.6):
 *   videoBitrateKbps, sendWidth, sendHeight, sendFps, contentHint,
 *   degradationPreference, scaleResolutionDownBy, rtpPriority
 *
 * Restart-required fields:
 *   codec, h264Profile, captureWidth, captureHeight, captureFps,
 *   cursorMode, audio.*, scalabilityMode
 */
export interface GroupSettingsChange {
  groupId: string;
  before: GroupQualitySettings;
  after: GroupQualitySettings;
}

export interface LiveApplyResult {
  liveSafe: string[];
  restartRequired: string[];
  appliedToViewers: string[];
  restartSuggested: boolean;
}

export class GroupSettingsLiveApply {
  constructor(private runtime: Phase3Runtime) {}

  /**
   * Classify the change and apply live-safe fields to all active
   * viewer senders. Restart-required fields are returned in the
   * result for the UI to surface a banner.
   */
  async applyChange(change: GroupSettingsChange): Promise<LiveApplyResult> {
    const diffs = diffGroupSettings(change.before, change.after);
    const { liveSafe, restartRequired } = classifySettingsDiff(diffs);

    const appliedToViewers: string[] = [];
    if (liveSafe.length > 0) {
      // Look up the live bindings and apply to each viewer's exact
      // sender. We do not invent defaults — the host must already
      // be streaming and the binding must already be in place.
      const viewerBinding = (this.runtime as unknown as {
        getViewerMediaBinding?: () => {
          getAllViewers: () => Array<{
            groupId: string;
            logicalStreamId: string;
            viewerDeviceId: string;
            videoSender: RTCRtpSender | null;
          }>;
        };
      }).getViewerMediaBinding?.();

      if (viewerBinding) {
        const viewers = viewerBinding.getAllViewers().filter(
          (v) => v.groupId === change.groupId,
        );
        for (const viewer of viewers) {
          if (!viewer.videoSender) continue;
          try {
            await this.applyToSender(
              viewer.videoSender,
              change.after,
            );
            appliedToViewers.push(viewer.viewerDeviceId);
          } catch {
            // best effort
          }
        }
      }
    }

    return {
      liveSafe,
      restartRequired,
      appliedToViewers,
      restartSuggested: restartRequired.length > 0,
    };
  }

  /**
   * Apply live-safe GroupQualitySettings fields to a single
   * RTCRtpSender. Delegates to the shared `applySenderSettings`
   * from quality-coordinator to avoid duplicating sender-encoding
   * parameter logic. We do not apply host-only fields (codec, capture
   * dimensions, cursor mode, audio) — those require a restart.
   */
  private async applyToSender(
    sender: RTCRtpSender,
    settings: GroupQualitySettings,
  ): Promise<void> {
    await applySenderSettings(sender, {
      maxBitrate: settings.video.videoBitrateKbps,
      maxFramerate: settings.video.sendFps,
      degradationPreference: settings.video.degradationPreference,
      scaleResolutionDownBy:
        settings.video.scaleResolutionDownBy >= 1
          ? settings.video.scaleResolutionDownBy
          : undefined,
    });
  }
}
