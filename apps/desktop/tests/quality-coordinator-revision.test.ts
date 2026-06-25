// @vitest-environment node
import { describe, it, expect } from "vitest";
import { QualityCoordinator } from "../src/renderer/services/quality-coordinator.js";
import type { ViewerQualityRequest } from "@screenlink/shared";

const group = "g-1";
const ls = "ls-1";
const viewerA = "viewer-a";
const viewerB = "viewer-b";

function makeRequest(
  viewerDeviceId: string,
  revision: number,
  requestId: string,
  overrides: Partial<ViewerQualityRequest> = {},
): ViewerQualityRequest {
  return {
    streamSessionId: ls,
    requestId,
    revision,
    videoBitrateKbps: 1000,
    maxWidth: 1280,
    maxHeight: 720,
    maxFps: 30,
    degradationPreference: "balanced",
    requestedAt: Date.now(),
    ...overrides,
  };
}

describe("QualityCoordinator revision semantics (Gate 6.2)", () => {
  it("accepts a first request and records it", () => {
    const qc = new QualityCoordinator();
    const d = qc.decideViewerRequest(group, ls, viewerA, makeRequest(viewerA, 1, "req-1"));
    expect(d.kind).toBe("accepted");
    expect(qc.getAcceptedRequest(group, ls, viewerA)?.revision).toBe(1);
  });

  it("treats a same requestId replay as idempotent", () => {
    const qc = new QualityCoordinator();
    qc.decideViewerRequest(group, ls, viewerA, makeRequest(viewerA, 1, "req-1"));
    const d = qc.decideViewerRequest(group, ls, viewerA, makeRequest(viewerA, 1, "req-1"));
    expect(d.kind).toBe("idempotent");
  });

  it("rejects a lower revision as stale", () => {
    const qc = new QualityCoordinator();
    qc.decideViewerRequest(group, ls, viewerA, makeRequest(viewerA, 5, "req-1"));
    const d = qc.decideViewerRequest(group, ls, viewerA, makeRequest(viewerA, 3, "req-2"));
    expect(d.kind).toBe("stale");
  });

  it("rejects same revision + different requestId as conflict", () => {
    const qc = new QualityCoordinator();
    qc.decideViewerRequest(group, ls, viewerA, makeRequest(viewerA, 5, "req-1"));
    const d = qc.decideViewerRequest(group, ls, viewerA, makeRequest(viewerA, 5, "req-2"));
    expect(d.kind).toBe("conflict");
  });

  it("accepts a higher revision and overwrites the stored state", () => {
    const qc = new QualityCoordinator();
    qc.decideViewerRequest(group, ls, viewerA, makeRequest(viewerA, 1, "req-1"));
    const d = qc.decideViewerRequest(group, ls, viewerA, makeRequest(viewerA, 2, "req-2", { videoBitrateKbps: 2000 }));
    expect(d.kind).toBe("accepted");
    expect(qc.getAcceptedRequest(group, ls, viewerA)?.revision).toBe(2);
    expect(qc.getAcceptedRequest(group, ls, viewerA)?.payload.videoBitrateKbps).toBe(2000);
  });

  it("isolates viewer A from viewer B (one cannot affect the other)", () => {
    const qc = new QualityCoordinator();
    qc.decideViewerRequest(group, ls, viewerA, makeRequest(viewerA, 1, "req-A1"));
    const d = qc.decideViewerRequest(group, ls, viewerB, makeRequest(viewerB, 1, "req-B1"));
    expect(d.kind).toBe("accepted");
    expect(qc.getAcceptedRequest(group, ls, viewerA)?.requestId).toBe("req-A1");
    expect(qc.getAcceptedRequest(group, ls, viewerB)?.requestId).toBe("req-B1");
  });

  it("clear removes the accepted state so the next request is a fresh accept", () => {
    const qc = new QualityCoordinator();
    qc.decideViewerRequest(group, ls, viewerA, makeRequest(viewerA, 1, "req-1"));
    qc.clearViewerRequest(group, ls, viewerA);
    expect(qc.getAcceptedRequest(group, ls, viewerA)).toBeNull();
    const d = qc.decideViewerRequest(group, ls, viewerA, makeRequest(viewerA, 1, "req-2"));
    expect(d.kind).toBe("accepted");
  });
});
