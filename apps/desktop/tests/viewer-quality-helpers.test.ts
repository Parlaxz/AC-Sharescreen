// @vitest-environment node
import { describe, it, expect } from "vitest";

import {
  getViewerQualityEffectiveFeedback,
  getViewerQualityDispatchError,
  resolveViewerQualityFeedbackStreamId,
} from "../src/renderer/components/workspace/viewer/viewer-quality-helpers.js";

describe("viewer quality apply safeguards", () => {
  it("returns an explicit error when apply cannot be sent", () => {
    expect(getViewerQualityDispatchError(null, { logicalStreamId: "stream-1" })).toBe(
      "Cannot send request — not connected",
    );
    expect(getViewerQualityDispatchError({} as never, null)).toBe(
      "Cannot send request — not connected",
    );
    expect(
      getViewerQualityDispatchError({} as never, { logicalStreamId: "stream-1" }),
    ).toBeNull();
  });

  it("prefers the watched target stream id for quality feedback matching", () => {
    expect(
      resolveViewerQualityFeedbackStreamId({
        watchingTargetLogicalStreamId: "watched-stream",
        currentStreamLogicalStreamId: "stale-stream",
      }),
    ).toBe("watched-stream");
  });

  it("falls back to current stream id when no watched target id exists", () => {
    expect(
      resolveViewerQualityFeedbackStreamId({
        watchingTargetLogicalStreamId: null,
        currentStreamLogicalStreamId: "current-stream",
      }),
    ).toBe("current-stream");
  });

  it("marks mapping-missing feedback as pending with grounded copy", () => {
    expect(
      getViewerQualityEffectiveFeedback({
        videoBitrateKbps: 2500,
        clampReasons: ["mapping missing"],
      }),
    ).toEqual({
      accepted: undefined,
      message: "Waiting for media connection — will apply automatically",
    });
  });

  it("preserves actual application failures as rejected feedback", () => {
    expect(
      getViewerQualityEffectiveFeedback({
        clampReasons: ["application failed: sender timeout"],
      }),
    ).toEqual({
      accepted: false,
      message: "Could not apply quality: application failed: sender timeout",
    });
  });

  it("keeps capped feedback accepted when only clamp reasons are present", () => {
    expect(
      getViewerQualityEffectiveFeedback({
        videoBitrateKbps: 2500,
        clampReasons: ["bitrate clamped to host max 2500 kbps"],
      }),
    ).toEqual({
      accepted: true,
      message: "Accepted, capped: bitrate clamped to host max 2500 kbps",
    });
  });
});
