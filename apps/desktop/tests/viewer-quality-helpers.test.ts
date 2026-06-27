// @vitest-environment node
import { describe, it, expect } from "vitest";

import {
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
});
