import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createConnectionSupervisor,
  type ConnectionSupervisor,
  type ConnectionHealthSnapshot,
} from "../src/renderer/services/connection-supervisor.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** A controllable clock for deterministic tests. */
function createControllableClock(initial: number = 0) {
  let _now = initial;
  return {
    now: () => _now,
    advance: (ms: number) => { _now += ms; },
    set: (ms: number) => { _now = ms; },
    get: () => _now,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ConnectionSupervisor", () => {
  let sup: ConnectionSupervisor;

  beforeEach(() => {
    sup = createConnectionSupervisor({
      stallThresholdMs: 5_000,
      backoff: { minMs: 100, maxMs: 10_000, factor: 2, jitter: undefined },
      now: () => 0,
    });
  });

  // ─── Snapshot stability / subscriptions ─────────────────────────────────

  describe("snapshot stability and subscriptions", () => {
    it("provides a default snapshot on creation", () => {
      const snap = sup.getSnapshot();
      expect(snap.controlHealth).toBe("down");
      expect(snap.mediaHealth).toBe("up");
      expect(snap.controlState).toBe("disconnected");
      expect(snap.mediaState).toBe("no-media-yet");
      expect(snap.isPaused).toBe(false);
      expect(snap.isIntentionalStop).toBe(false);
      expect(snap.lastByteProgressMs).toBeNull();
      expect(snap.backoffAttempt).toBe(0);
      expect(snap.backoffDelayMs).toBe(0);
    });

    it("returns stable reference between changes", () => {
      const a = sup.getSnapshot();
      const b = sup.getSnapshot();
      expect(a).toBe(b);
    });

    it("replaces snapshot reference after a state change", () => {
      const before = sup.getSnapshot();
      sup.reportControlConnected();
      const after = sup.getSnapshot();
      expect(after).not.toBe(before);
      expect(after.controlHealth).toBe("up");
    });

    it("calls subscriber immediately with initial snapshot", () => {
      const spy = vi.fn();
      sup.subscribe(spy);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe(sup.getSnapshot());
    });

    it("notifies subscribers on state change", () => {
      const spy = vi.fn();
      sup.subscribe(spy);
      spy.mockClear();

      sup.reportControlConnected();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].controlHealth).toBe("up");
    });

    it("does not notify when state does not change", () => {
      const spy = vi.fn();
      sup.subscribe(spy);
      spy.mockClear();

      sup.reportControlConnected();
      sup.reportControlConnected();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("unsubscribe removes listener", () => {
      const spy = vi.fn();
      const unsub = sup.subscribe(spy);
      spy.mockClear();
      unsub();
      sup.reportControlConnected();
      expect(spy).not.toHaveBeenCalled();
    });

    it("supports multiple subscribers", () => {
      const spy1 = vi.fn();
      const spy2 = vi.fn();
      sup.subscribe(spy1);
      sup.subscribe(spy2);
      spy1.mockClear();
      spy2.mockClear();

      sup.reportControlConnected();
      expect(spy1).toHaveBeenCalledTimes(1);
      expect(spy2).toHaveBeenCalledTimes(1);
    });

    it("handles subscriber that throws without affecting others", () => {
      const bad = vi.fn(() => { throw new Error("boom"); });
      const good = vi.fn();
      sup.subscribe(bad);
      sup.subscribe(good);
      bad.mockClear();
      good.mockClear();

      expect(() => sup.reportControlConnected()).not.toThrow();
      expect(good).toHaveBeenCalledTimes(1);
    });

    it("getSnapshot returns the same reference as subscribe callback", () => {
      const spy = vi.fn();
      sup.subscribe(spy);
      expect(spy.mock.calls[0][0]).toBe(sup.getSnapshot());
    });
  });

  // ─── Control transitions ────────────────────────────────────────────────

  describe("control transitions", () => {
    it("connected -> controlHealth=up", () => {
      sup.reportControlConnected();
      const snap = sup.getSnapshot();
      expect(snap.controlHealth).toBe("up");
      expect(snap.controlState).toBe("connected");
    });

    it("reconnecting -> controlHealth=recovering", () => {
      sup.reportControlReconnecting();
      const snap = sup.getSnapshot();
      expect(snap.controlHealth).toBe("recovering");
      expect(snap.controlState).toBe("reconnecting");
    });

    it("disconnected -> controlHealth=down", () => {
      sup.reportControlDisconnected();
      const snap = sup.getSnapshot();
      expect(snap.controlHealth).toBe("down");
      expect(snap.controlState).toBe("disconnected");
    });

    it("failed -> controlHealth=down", () => {
      sup.reportControlFailed();
      const snap = sup.getSnapshot();
      expect(snap.controlHealth).toBe("down");
      expect(snap.controlState).toBe("failed");
    });

    it("connected -> reconnecting transitions correctly", () => {
      sup.reportControlConnected();
      sup.reportControlReconnecting();
      expect(sup.getSnapshot().controlHealth).toBe("recovering");
    });

    it("reconnecting -> connected recovers health", () => {
      sup.reportControlReconnecting();
      sup.reportControlConnected();
      expect(sup.getSnapshot().controlHealth).toBe("up");
    });

    it("connected -> failed transitions correctly", () => {
      sup.reportControlConnected();
      sup.reportControlFailed();
      expect(sup.getSnapshot().controlHealth).toBe("down");
      expect(sup.getSnapshot().controlState).toBe("failed");
    });

    it("connecting clears intentional stop", () => {
      sup.markIntentionalStop();
      expect(sup.getSnapshot().isIntentionalStop).toBe(true);
      sup.reportControlConnected();
      expect(sup.getSnapshot().isIntentionalStop).toBe(false);
    });

    it("reconnecting does not clear intentional stop", () => {
      sup.markIntentionalStop();
      sup.reportControlReconnecting();
      expect(sup.getSnapshot().isIntentionalStop).toBe(true);
    });
  });

  // ─── Media transitions ──────────────────────────────────────────────────

  describe("media transitions", () => {
    it("initial state is no-media-yet -> mediaHealth=up", () => {
      expect(sup.getSnapshot().mediaHealth).toBe("up");
      expect(sup.getSnapshot().mediaState).toBe("no-media-yet");
    });

    it("connected -> mediaHealth=up", () => {
      sup.reportMediaConnected();
      expect(sup.getSnapshot().mediaHealth).toBe("up");
      expect(sup.getSnapshot().mediaState).toBe("connected");
    });

    it("disconnected -> mediaHealth=down and clears byte progress", () => {
      sup.reportMediaConnected();
      sup.reportMediaProgress(1000, 100);
      expect(sup.getSnapshot().lastByteProgressMs).toBe(100);

      sup.reportMediaDisconnected();
      const snap = sup.getSnapshot();
      expect(snap.mediaHealth).toBe("down");
      expect(snap.mediaState).toBe("disconnected");
      expect(snap.lastByteProgressMs).toBeNull();
    });

    it("connected -> progressing on first progress report", () => {
      sup.reportMediaConnected();
      sup.reportMediaProgress(500, 50);
      expect(sup.getSnapshot().mediaState).toBe("progressing");
      expect(sup.getSnapshot().mediaHealth).toBe("up");
    });

    it("stalled -> progressing on new progress report", () => {
      const clock = createControllableClock(0);
      sup = createConnectionSupervisor({
        stallThresholdMs: 5_000,
        now: () => clock.now(),
        backoff: { minMs: 100, factor: 2, jitter: undefined },
      });
      sup.reportMediaProgress(1000, clock.now());
      clock.advance(6_000);
      sup.checkMediaStall(clock.now());

      expect(sup.getSnapshot().mediaState).toBe("stalled");
      expect(sup.getSnapshot().mediaHealth).toBe("stalled");

      sup.reportMediaProgress(2000, clock.now());
      expect(sup.getSnapshot().mediaState).toBe("progressing");
      expect(sup.getSnapshot().mediaHealth).toBe("up");
    });

    it("reportMediaRecovering -> mediaHealth=recovering", () => {
      sup.reportMediaRecovering();
      const snap = sup.getSnapshot();
      expect(snap.mediaState).toBe("recovering");
      expect(snap.mediaHealth).toBe("recovering");
    });

    it("recovering -> progressing on new byte progress", () => {
      const clock = createControllableClock(0);
      sup = createConnectionSupervisor({
        stallThresholdMs: 5_000,
        now: () => clock.now(),
        backoff: { minMs: 100, factor: 2, jitter: undefined },
      });
      sup.reportMediaRecovering();
      expect(sup.getSnapshot().mediaHealth).toBe("recovering");

      sup.reportMediaProgress(500, clock.now());
      expect(sup.getSnapshot().mediaState).toBe("progressing");
      expect(sup.getSnapshot().mediaHealth).toBe("up");
    });
  });

  // ─── Stall detection ────────────────────────────────────────────────────

  describe("stall detection", () => {
    it("declares stalled when byte progress exceeds threshold", () => {
      const clock = createControllableClock(0);
      sup = createConnectionSupervisor({
        stallThresholdMs: 5_000,
        now: () => clock.now(),
        backoff: { minMs: 100, factor: 2, jitter: undefined },
      });

      sup.reportMediaProgress(1000, clock.now());
      expect(sup.getSnapshot().mediaState).toBe("progressing");

      clock.advance(6_000);
      sup.checkMediaStall(clock.now());

      expect(sup.getSnapshot().mediaState).toBe("stalled");
      expect(sup.getSnapshot().mediaHealth).toBe("stalled");
    });

    it("does not declare stalled when within threshold", () => {
      const clock = createControllableClock(0);
      sup = createConnectionSupervisor({
        stallThresholdMs: 5_000,
        now: () => clock.now(),
        backoff: { minMs: 100, factor: 2, jitter: undefined },
      });

      sup.reportMediaProgress(1000, clock.now());
      clock.advance(3_000);
      sup.checkMediaStall(clock.now());

      expect(sup.getSnapshot().mediaState).toBe("progressing");
      expect(sup.getSnapshot().mediaHealth).toBe("up");
    });

    it("is idempotent - repeated checks do not re-notify", () => {
      const clock = createControllableClock(0);
      sup = createConnectionSupervisor({
        stallThresholdMs: 5_000,
        now: () => clock.now(),
        backoff: { minMs: 100, factor: 2, jitter: undefined },
      });

      sup.reportMediaProgress(1000, clock.now());
      clock.advance(6_000);

      const spy = vi.fn();
      sup.subscribe(spy);
      spy.mockClear();

      sup.checkMediaStall(clock.now());
      expect(spy).toHaveBeenCalledTimes(1);

      sup.checkMediaStall(clock.now());
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("recovers from stalled to progressing when threshold no longer exceeded", () => {
      const clock = createControllableClock(0);
      sup = createConnectionSupervisor({
        stallThresholdMs: 5_000,
        now: () => clock.now(),
        backoff: { minMs: 100, factor: 2, jitter: undefined },
      });

      sup.reportMediaProgress(1000, clock.now());
      clock.advance(6_000);
      sup.checkMediaStall(clock.now());
      expect(sup.getSnapshot().mediaState).toBe("stalled");

      sup.reportMediaProgress(2000, clock.now());
      expect(sup.getSnapshot().mediaState).toBe("progressing");

      clock.advance(1);
      sup.checkMediaStall(clock.now());
      expect(sup.getSnapshot().mediaState).toBe("progressing");
      expect(sup.getSnapshot().mediaHealth).toBe("up");
    });
  });

  // ─── Pause-aware stall detection ────────────────────────────────────────

  describe("pause-aware stall detection", () => {
    it("does not declare stalled when paused", () => {
      const clock = createControllableClock(0);
      sup = createConnectionSupervisor({
        stallThresholdMs: 5_000,
        now: () => clock.now(),
        backoff: { minMs: 100, factor: 2, jitter: undefined },
      });

      sup.reportMediaProgress(1000, clock.now());
      sup.setPaused(true);
      clock.advance(10_000);

      sup.checkMediaStall(clock.now());
      expect(sup.getSnapshot().mediaState).toBe("progressing");
      expect(sup.getSnapshot().mediaHealth).toBe("up");
    });

    it("resumes stall detection after unpause", () => {
      const clock = createControllableClock(0);
      sup = createConnectionSupervisor({
        stallThresholdMs: 5_000,
        now: () => clock.now(),
        backoff: { minMs: 100, factor: 2, jitter: undefined },
      });

      sup.reportMediaProgress(1000, clock.now());
      sup.setPaused(true);
      clock.advance(10_000);
      sup.checkMediaStall(clock.now());
      expect(sup.getSnapshot().mediaState).toBe("progressing");

      sup.setPaused(false);
      sup.checkMediaStall(clock.now());

      expect(sup.getSnapshot().mediaState).toBe("stalled");
      expect(sup.getSnapshot().mediaHealth).toBe("stalled");
    });

    it("toggles pause state in snapshot", () => {
      expect(sup.getSnapshot().isPaused).toBe(false);
      sup.setPaused(true);
      expect(sup.getSnapshot().isPaused).toBe(true);
      sup.setPaused(false);
      expect(sup.getSnapshot().isPaused).toBe(false);
    });
  });

  // ─── No-media-yet behavior ──────────────────────────────────────────────

  describe("no-media-yet behavior", () => {
    it("does not declare stalled when no-media-yet", () => {
      const clock = createControllableClock(0);
      sup = createConnectionSupervisor({
        stallThresholdMs: 1,
        now: () => clock.now(),
        backoff: { minMs: 100, factor: 2, jitter: undefined },
      });

      clock.advance(100_000);
      sup.checkMediaStall(clock.now());

      expect(sup.getSnapshot().mediaState).toBe("no-media-yet");
      expect(sup.getSnapshot().mediaHealth).toBe("up");
    });

    it("transitions from no-media-yet on first progress", () => {
      sup.reportMediaProgress(100, 100);
      expect(sup.getSnapshot().mediaState).toBe("progressing");
    });

    it("transitions from no-media-yet on media connected", () => {
      sup.reportMediaConnected();
      expect(sup.getSnapshot().mediaState).toBe("connected");
    });
  });

  // ─── Intentional stop ───────────────────────────────────────────────────

  describe("intentional stop", () => {
    it("marks intentional stop", () => {
      sup.markIntentionalStop();
      expect(sup.getSnapshot().isIntentionalStop).toBe(true);
    });

    it("connecting clears intentional stop", () => {
      sup.markIntentionalStop();
      sup.reportControlConnected();
      expect(sup.getSnapshot().isIntentionalStop).toBe(false);
    });

    it("reconnecting does not clear intentional stop", () => {
      sup.markIntentionalStop();
      sup.reportControlReconnecting();
      expect(sup.getSnapshot().isIntentionalStop).toBe(true);
    });

    it("cancel clears intentional stop", () => {
      sup.markIntentionalStop();
      sup.cancel();
      expect(sup.getSnapshot().isIntentionalStop).toBe(false);
    });
  });

  // ─── Cancel / reset ─────────────────────────────────────────────────────

  describe("cancel", () => {
    it("resets all state to defaults", () => {
      sup.reportControlConnected();
      sup.reportMediaConnected();
      sup.reportMediaProgress(500, 100);
      sup.setPaused(true);
      sup.markIntentionalStop();
      sup.nextBackoff();

      sup.cancel();

      const snap = sup.getSnapshot();
      expect(snap.controlState).toBe("disconnected");
      expect(snap.controlHealth).toBe("down");
      expect(snap.mediaState).toBe("no-media-yet");
      expect(snap.mediaHealth).toBe("up");
      expect(snap.isPaused).toBe(false);
      expect(snap.isIntentionalStop).toBe(false);
      expect(snap.lastByteProgressMs).toBeNull();
      expect(snap.backoffAttempt).toBe(0);
      expect(snap.backoffDelayMs).toBe(0);
    });

    it("notifies subscribers", () => {
      const spy = vi.fn();
      sup.subscribe(spy);
      spy.mockClear();

      sup.cancel();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Backoff integration ────────────────────────────────────────────────

  describe("backoff integration", () => {
    it("nextBackoff advances attempt and sets delay", () => {
      sup.resetBackoff();
      expect(sup.getSnapshot().backoffAttempt).toBe(0);
      expect(sup.getSnapshot().backoffDelayMs).toBe(0);

      const d1 = sup.nextBackoff();
      expect(d1).toBe(100);
      expect(sup.getSnapshot().backoffAttempt).toBe(1);
      expect(sup.getSnapshot().backoffDelayMs).toBe(100);
    });

    it("produces geometrically increasing delays", () => {
      expect(sup.nextBackoff()).toBe(100);
      expect(sup.nextBackoff()).toBe(200);
      expect(sup.nextBackoff()).toBe(400);
      expect(sup.nextBackoff()).toBe(800);
    });

    it("bounded by maxMs", () => {
      sup = createConnectionSupervisor({
        backoff: { minMs: 1000, maxMs: 3000, factor: 2, jitter: undefined },
      });
      expect(sup.nextBackoff()).toBe(1000);
      expect(sup.nextBackoff()).toBe(2000);
      expect(sup.nextBackoff()).toBe(3000);
      expect(sup.nextBackoff()).toBe(3000);
    });

    it("resetBackoff returns to initial state", () => {
      sup.nextBackoff();
      sup.nextBackoff();
      sup.nextBackoff();
      expect(sup.getSnapshot().backoffAttempt).toBe(3);

      sup.resetBackoff();
      expect(sup.getSnapshot().backoffAttempt).toBe(0);
      expect(sup.getSnapshot().backoffDelayMs).toBe(0);
      expect(sup.nextBackoff()).toBe(100);
    });

    it("publishes snapshot on nextBackoff and resetBackoff", () => {
      const spy = vi.fn();
      sup.subscribe(spy);
      spy.mockClear();

      sup.nextBackoff();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].backoffAttempt).toBe(1);

      sup.resetBackoff();
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[1][0].backoffAttempt).toBe(0);
    });
  });

  // ─── Integrated scenarios ───────────────────────────────────────────────

  describe("integrated scenarios", () => {
    it("control down + media up -> controlHealth=down, mediaHealth=up", () => {
      sup.reportControlDisconnected();
      sup.reportMediaConnected();
      const snap = sup.getSnapshot();
      expect(snap.controlHealth).toBe("down");
      expect(snap.mediaHealth).toBe("up");
    });

    it("control recovering + media stalled -> mixed health", () => {
      const clock = createControllableClock(0);
      sup = createConnectionSupervisor({
        stallThresholdMs: 5_000,
        now: () => clock.now(),
        backoff: { minMs: 100, factor: 2, jitter: undefined },
      });

      sup.reportControlReconnecting();
      sup.reportMediaProgress(1000, clock.now());
      clock.advance(6_000);
      sup.checkMediaStall(clock.now());

      const snap = sup.getSnapshot();
      expect(snap.controlHealth).toBe("recovering");
      expect(snap.mediaHealth).toBe("stalled");
      expect(snap.controlState).toBe("reconnecting");
      expect(snap.mediaState).toBe("stalled");
    });

    it("full recovery cycle: connect -> disconnect -> reconnect", () => {
      const clock = createControllableClock(0);
      sup = createConnectionSupervisor({
        stallThresholdMs: 5_000,
        now: () => clock.now(),
        backoff: { minMs: 100, factor: 2, jitter: undefined },
      });

      // Initial connection
      sup.reportControlConnected();
      sup.reportMediaConnected();
      sup.reportMediaProgress(1000, clock.now());
      expect(sup.getSnapshot().controlHealth).toBe("up");
      expect(sup.getSnapshot().mediaHealth).toBe("up");

      // Control disconnects
      sup.reportControlDisconnected();
      expect(sup.getSnapshot().controlHealth).toBe("down");

      // Media stalls during the outage
      clock.advance(10_000);
      sup.checkMediaStall(clock.now());
      expect(sup.getSnapshot().mediaHealth).toBe("stalled");

      // Control reconnects
      sup.reportControlReconnecting();
      expect(sup.getSnapshot().controlHealth).toBe("recovering");

      // Media restarts flowing
      sup.reportMediaProgress(2000, clock.now());
      expect(sup.getSnapshot().mediaHealth).toBe("up");

      // Control fully restored
      sup.reportControlConnected();
      expect(sup.getSnapshot().controlHealth).toBe("up");
    });

    it("intentional stop prevents recovery classification", () => {
      sup.reportControlConnected();
      sup.reportMediaConnected();
      sup.markIntentionalStop();
      sup.reportControlDisconnected();
      sup.reportMediaDisconnected();

      const snap = sup.getSnapshot();
      expect(snap.isIntentionalStop).toBe(true);
      expect(snap.controlHealth).toBe("down");
      expect(snap.mediaHealth).toBe("down");
    });
  });

  // ─── Cumulative byte semantics ─────────────────────────────────────────

  describe("cumulative byte semantics", () => {
    it("ignores same byte value (duplicate stat poll does not advance timestamp)", () => {
      const clock = createControllableClock(0);
      sup = createConnectionSupervisor({
        stallThresholdMs: 5_000,
        now: () => clock.now(),
        backoff: { minMs: 100, factor: 2, jitter: undefined },
      });

      sup.reportMediaProgress(1000, clock.now());
      expect(sup.getSnapshot().lastByteProgressMs).toBe(0);

      // Same bytes reported again — timestamp must NOT advance
      clock.advance(3_000);
      sup.reportMediaProgress(1000, clock.now());
      expect(sup.getSnapshot().lastByteProgressMs).toBe(0);
    });

    it("ignores smaller byte value (reset/rebaseline does not regress timestamp)", () => {
      const clock = createControllableClock(0);
      sup = createConnectionSupervisor({
        stallThresholdMs: 5_000,
        now: () => clock.now(),
        backoff: { minMs: 100, factor: 2, jitter: undefined },
      });

      sup.reportMediaProgress(2000, clock.now());
      expect(sup.getSnapshot().lastByteProgressMs).toBe(0);

      clock.advance(3_000);
      // Smaller value simulates a stats counter reset — must NOT update timestamp
      sup.reportMediaProgress(500, clock.now());
      expect(sup.getSnapshot().lastByteProgressMs).toBe(0);
    });

    it("reportMediaConnected resets byte tracker for rebaseline", () => {
      const clock = createControllableClock(0);
      sup = createConnectionSupervisor({
        stallThresholdMs: 5_000,
        now: () => clock.now(),
        backoff: { minMs: 100, factor: 2, jitter: undefined },
      });

      sup.reportMediaProgress(9000, clock.now());
      expect(sup.getSnapshot().lastByteProgressMs).toBe(0);

      // Disconnect + reconnect then report a *smaller* cumulative counter
      sup.reportMediaDisconnected();
      sup.reportMediaConnected();
      clock.advance(1_000);

      sup.reportMediaProgress(500, clock.now());
      // Must advance because reportMediaConnected reset the tracker
      expect(sup.getSnapshot().lastByteProgressMs).toBe(1_000);
      expect(sup.getSnapshot().mediaState).toBe("progressing");
    });

    it("same bytes after stall does NOT unstall", () => {
      const clock = createControllableClock(0);
      sup = createConnectionSupervisor({
        stallThresholdMs: 5_000,
        now: () => clock.now(),
        backoff: { minMs: 100, factor: 2, jitter: undefined },
      });

      sup.reportMediaProgress(1000, clock.now());
      clock.advance(6_000);
      sup.checkMediaStall(clock.now());
      expect(sup.getSnapshot().mediaState).toBe("stalled");

      // Same bytes reported again — should NOT unstall
      sup.reportMediaProgress(1000, clock.now());
      expect(sup.getSnapshot().mediaState).toBe("stalled");
    });

    it("advancing bytes after stall does unstall", () => {
      const clock = createControllableClock(0);
      sup = createConnectionSupervisor({
        stallThresholdMs: 5_000,
        now: () => clock.now(),
        backoff: { minMs: 100, factor: 2, jitter: undefined },
      });

      sup.reportMediaProgress(1000, clock.now());
      clock.advance(6_000);
      sup.checkMediaStall(clock.now());
      expect(sup.getSnapshot().mediaState).toBe("stalled");

      // Strictly larger bytes → unstall
      sup.reportMediaProgress(1500, clock.now());
      expect(sup.getSnapshot().mediaState).toBe("progressing");
    });
  });

  // ─── Injected clock ────────────────────────────────────────────────────

  describe("injected clock", () => {
    it("uses injected now function for reportMediaProgress", () => {
      const clock = createControllableClock(42);
      sup = createConnectionSupervisor({ now: () => clock.now() });

      sup.reportMediaProgress(100);
      expect(sup.getSnapshot().lastByteProgressMs).toBe(42);
    });

    it("uses injected now function for checkMediaStall", () => {
      const clock = createControllableClock(0);
      sup = createConnectionSupervisor({
        stallThresholdMs: 1000,
        now: () => clock.now(),
      });

      sup.reportMediaProgress(100, clock.now());
      clock.advance(2000);
      sup.checkMediaStall(); // no explicit now arg
      expect(sup.getSnapshot().mediaState).toBe("stalled");
    });
  });
});
