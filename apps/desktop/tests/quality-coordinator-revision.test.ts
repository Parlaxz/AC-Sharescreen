// @vitest-environment node
import { describe, it, expect } from "vitest";
import { QualityCoordinator } from "../src/renderer/services/quality-coordinator.js";

const group = "g-1";
const ls = "ls-1";
const viewerA = "viewer-a";
const viewerB = "viewer-b";

function makePayload(
  revision: number,
  requestId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    streamSessionId: ls,
    requestId,
    revision,
    videoBitrateKbps: 1000,
    maxWidth: 1280,
    maxHeight: 720,
    maxFps: 30,
    degradationPreference: "balanced",
    ...overrides,
  };
}

describe("QualityCoordinator revision semantics (Phase 2 simplified)", () => {
  it("handleViewerRequest stores the request and records an accepted revision", () => {
    const qc = new QualityCoordinator();
    qc.handleViewerRequest(group, ls, viewerA, makePayload(1, "req-1"));
    const req = qc.getViewerRequest(group, ls, viewerA);
    expect(req).not.toBeNull();
    expect(req!.requestId).toBe("req-1");
    expect(req!.revision).toBe(1);

    const rec = qc.getAcceptedRevision(group, ls, viewerA);
    expect(rec).not.toBeNull();
    expect(rec!.requestId).toBe("req-1");
    expect(rec!.revision).toBe(1);
  });

  it("handleViewerClear removes the stored request and revision record", () => {
    const qc = new QualityCoordinator();
    qc.handleViewerRequest(group, ls, viewerA, makePayload(1, "req-1"));
    expect(qc.getViewerRequest(group, ls, viewerA)).not.toBeNull();

    qc.handleViewerClear(group, ls, viewerA);
    expect(qc.getViewerRequest(group, ls, viewerA)).toBeNull();
    expect(qc.getAcceptedRevision(group, ls, viewerA)).toBeNull();
  });

  it("isolates viewer A from viewer B (one cannot affect the other)", () => {
    const qc = new QualityCoordinator();
    qc.handleViewerRequest(group, ls, viewerA, makePayload(1, "req-A1"));
    qc.handleViewerRequest(group, ls, viewerB, makePayload(1, "req-B1"));

    expect(qc.getViewerRequest(group, ls, viewerA)!.requestId).toBe("req-A1");
    expect(qc.getViewerRequest(group, ls, viewerB)!.requestId).toBe("req-B1");
  });

  it("overwrites stored revision on a new request for the same viewer", () => {
    const qc = new QualityCoordinator();
    qc.handleViewerRequest(group, ls, viewerA, makePayload(1, "req-1", { videoBitrateKbps: 1000 }));
    qc.handleViewerRequest(group, ls, viewerA, makePayload(2, "req-2", { videoBitrateKbps: 2000 }));

    const req = qc.getViewerRequest(group, ls, viewerA);
    expect(req!.revision).toBe(2);
    expect(req!.videoBitrateKbps).toBe(2000);

    const rec = qc.getAcceptedRevision(group, ls, viewerA);
    expect(rec!.revision).toBe(2);
    expect(rec!.requestId).toBe("req-2");
  });

  it("clear followed by new request stores the new revision", () => {
    const qc = new QualityCoordinator();
    qc.handleViewerRequest(group, ls, viewerA, makePayload(1, "req-1"));
    expect(qc.getAcceptedRevision(group, ls, viewerA)).not.toBeNull();

    qc.handleViewerClear(group, ls, viewerA);
    expect(qc.getAcceptedRevision(group, ls, viewerA)).toBeNull();

    qc.handleViewerRequest(group, ls, viewerA, makePayload(1, "req-2"));
    expect(qc.getAcceptedRevision(group, ls, viewerA)!.requestId).toBe("req-2");
  });
});

// ─── Phase 6A: monotonic revision ordering / idempotency ───────────────────

describe("QualityCoordinator monotonic revision ordering (Phase 6A)", () => {
  it("rejects stale revision (incoming < stored)", () => {
    const qc = new QualityCoordinator();
    qc.handleViewerRequest(group, ls, viewerA, makePayload(5, "req-5", { videoBitrateKbps: 5000 }));

    // Attempt to overwrite with a lower revision
    qc.handleViewerRequest(group, ls, viewerA, makePayload(3, "req-3", { videoBitrateKbps: 3000 }));

    // Stored request must still be revision 5 with bitrate 5000
    const req = qc.getViewerRequest(group, ls, viewerA);
    expect(req!.revision).toBe(5);
    expect(req!.videoBitrateKbps).toBe(5000);
    expect(req!.requestId).toBe("req-5");

    // Accepted revision must still be revision 5
    const rec = qc.getAcceptedRevision(group, ls, viewerA);
    expect(rec!.revision).toBe(5);
  });

  it("accepts higher revision after a lower one was stored", () => {
    const qc = new QualityCoordinator();
    qc.handleViewerRequest(group, ls, viewerA, makePayload(1, "req-1", { videoBitrateKbps: 1000 }));
    qc.handleViewerRequest(group, ls, viewerA, makePayload(3, "req-3", { videoBitrateKbps: 3000 }));

    const req = qc.getViewerRequest(group, ls, viewerA);
    expect(req!.revision).toBe(3);
    expect(req!.videoBitrateKbps).toBe(3000);
  });

  it("equal revision with same requestId is idempotent (no-op)", () => {
    const qc = new QualityCoordinator();
    qc.handleViewerRequest(group, ls, viewerA, makePayload(1, "req-1", { videoBitrateKbps: 1000 }));

    // Send the exact same payload again
    qc.handleViewerRequest(group, ls, viewerA, makePayload(1, "req-1", { videoBitrateKbps: 1000 }));

    const req = qc.getViewerRequest(group, ls, viewerA);
    expect(req!.revision).toBe(1);
    expect(req!.videoBitrateKbps).toBe(1000);

    // The requestedAt for idempotent duplicate may differ, but that's acceptable.
    // The key invariant: revision and content are unchanged.
  });

  it("equal revision with different requestId is NOT idempotent (advances)", () => {
    // Different requestId at same revision is still an advance — accept the update
    const qc = new QualityCoordinator();
    qc.handleViewerRequest(group, ls, viewerA, makePayload(1, "req-1", { videoBitrateKbps: 1000 }));

    qc.handleViewerRequest(group, ls, viewerA, makePayload(1, "req-1b", { videoBitrateKbps: 2000 }));

    const req = qc.getViewerRequest(group, ls, viewerA);
    // Same revision but different requestId — revise
    expect(req!.requestId).toBe("req-1b");
    expect(req!.videoBitrateKbps).toBe(2000);
    expect(req!.revision).toBe(1);
  });

  it("rejects stale revision even when requestId is different", () => {
    // Incoming revision < stored revision, should reject regardless of requestId
    const qc = new QualityCoordinator();
    qc.handleViewerRequest(group, ls, viewerA, makePayload(10, "req-10", { videoBitrateKbps: 10000 }));

    qc.handleViewerRequest(group, ls, viewerA, makePayload(5, "req-5", { videoBitrateKbps: 5000 }));

    const req = qc.getViewerRequest(group, ls, viewerA);
    expect(req!.revision).toBe(10);
    expect(req!.videoBitrateKbps).toBe(10000);
  });

  it("accepts same revision after clear (clear resets acceptance state)", () => {
    const qc = new QualityCoordinator();
    qc.handleViewerRequest(group, ls, viewerA, makePayload(3, "req-3"));
    qc.handleViewerClear(group, ls, viewerA);

    // After clear, a request with revision 3 should be accepted (state was reset)
    qc.handleViewerRequest(group, ls, viewerA, makePayload(3, "req-3b", { videoBitrateKbps: 9999 }));

    const req = qc.getViewerRequest(group, ls, viewerA);
    expect(req!.revision).toBe(3);
    expect(req!.requestId).toBe("req-3b");
    expect(req!.videoBitrateKbps).toBe(9999);
  });

  it("multi-viewer revision isolation (A rev 5, B rev 2 — A's state does not affect B)", () => {
    const qc = new QualityCoordinator();
    qc.handleViewerRequest(group, ls, viewerA, makePayload(5, "req-A5"));
    qc.handleViewerRequest(group, ls, viewerB, makePayload(2, "req-B2"));

    // B can still accept revision 2 (its own latest is 2)
    qc.handleViewerRequest(group, ls, viewerB, makePayload(2, "req-B2-dup", { videoBitrateKbps: 7777 }));

    const reqB = qc.getViewerRequest(group, ls, viewerB);
    // revision 2 with new requestId — advances
    expect(reqB!.revision).toBe(2);
    expect(reqB!.requestId).toBe("req-B2-dup");
    expect(reqB!.videoBitrateKbps).toBe(7777);

    // A is unaffected
    const reqA = qc.getViewerRequest(group, ls, viewerA);
    expect(reqA!.revision).toBe(5);
    expect(reqA!.requestId).toBe("req-A5");
  });

  it("session isolation: same viewer different logicalStreamId have independent state", () => {
    const qc = new QualityCoordinator();
    qc.handleViewerRequest(group, "stream-1", viewerA, makePayload(3, "req-s1-3"));
    qc.handleViewerRequest(group, "stream-2", viewerA, makePayload(1, "req-s2-1"));

    // stream-1 at rev 3
    expect(qc.getViewerRequest(group, "stream-1", viewerA)!.revision).toBe(3);
    // stream-2 at rev 1
    expect(qc.getViewerRequest(group, "stream-2", viewerA)!.revision).toBe(1);

    // Stale for stream-1 should not affect stream-2 or vice versa
    qc.handleViewerRequest(group, "stream-1", viewerA, makePayload(2, "req-stale"));
    expect(qc.getViewerRequest(group, "stream-1", viewerA)!.revision).toBe(3); // unchanged

    // stream-2 should still accept rev 2
    qc.handleViewerRequest(group, "stream-2", viewerA, makePayload(2, "req-s2-2", { videoBitrateKbps: 5432 }));
    expect(qc.getViewerRequest(group, "stream-2", viewerA)!.videoBitrateKbps).toBe(5432);
  });
});
