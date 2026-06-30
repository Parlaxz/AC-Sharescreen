/**
 * Tests for video-frame-ring TypeScript integration layer.
 *
 * These tests verify the TS wrapper logic, error types, and constants.
 * The native addon cannot be loaded in unit tests (it requires Electron's
 * process.dlopen), so we validate the pure-JS parts and use integration
 * tests with the real addon separately.
 */
import { describe, it, expect } from "vitest";

import {
  FRAME_RING_PROTOCOL_VERSION,
  SLOT_COUNT,
  SLOT_INPUT_A,
  SLOT_INPUT_B,
  SLOT_OUTPUT,
  DEFAULT_SLOT_PAYLOAD_SIZE,
  FrameRingErrorCode,
  FrameRingError,
} from "../video-frame-ring.js";

// ─── Constants ───────────────────────────────────────────────────────────────

describe("video-frame-ring constants", () => {
  it("exports protocol version", () => {
    expect(FRAME_RING_PROTOCOL_VERSION).toBe("1.0.0");
  });

  it("exports slot count as 3", () => {
    expect(SLOT_COUNT).toBe(3);
  });

  it("exports named slot indices", () => {
    expect(SLOT_INPUT_A).toBe(0);
    expect(SLOT_INPUT_B).toBe(1);
    expect(SLOT_OUTPUT).toBe(2);
  });

  it("exports default slot payload size", () => {
    expect(DEFAULT_SLOT_PAYLOAD_SIZE).toBe(4 * 1024 * 1024);
  });
});

// ─── Error codes ─────────────────────────────────────────────────────────────

describe("FrameRingErrorCode", () => {
  it("has expected enum values", () => {
    expect(FrameRingErrorCode.None).toBe(0);
    expect(FrameRingErrorCode.InvalidArgument).toBe(1);
    expect(FrameRingErrorCode.MappingFailed).toBe(2);
    expect(FrameRingErrorCode.ViewFailed).toBe(3);
    expect(FrameRingErrorCode.SlotOverflow).toBe(4);
    expect(FrameRingErrorCode.SessionMismatch).toBe(5);
    expect(FrameRingErrorCode.NotInitialized).toBe(6);
    expect(FrameRingErrorCode.AlreadyInitialized).toBe(7);
    expect(FrameRingErrorCode.EventFailed).toBe(8);
    expect(FrameRingErrorCode.SessionGuidFailed).toBe(9);
  });

  it("all codes are unique", () => {
    const values = Object.values(FrameRingErrorCode).filter(
      (v): v is number => typeof v === "number",
    );
    expect(new Set(values).size).toBe(values.length);
  });
});

// ─── FrameRingError ──────────────────────────────────────────────────────────

describe("FrameRingError", () => {
  it("creates error with code and message", () => {
    const err = new FrameRingError("test error", FrameRingErrorCode.MappingFailed);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FrameRingError);
    expect(err.name).toBe("FrameRingError");
    expect(err.message).toBe("test error");
    expect(err.code).toBe(FrameRingErrorCode.MappingFailed);
  });

  it("can be caught by instanceof", () => {
    const fn = (): never => {
      throw new FrameRingError("oops", FrameRingErrorCode.SlotOverflow);
    };

    expect(() => fn()).toThrow(FrameRingError);
    expect(() => fn()).toThrow("oops");

    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(FrameRingError);
      expect((err as FrameRingError).code).toBe(FrameRingErrorCode.SlotOverflow);
    }
  });

  it("distinct from plain Error", () => {
    const fn = (): never => {
      throw new FrameRingError("typed", FrameRingErrorCode.NotInitialized);
    };

    expect(() => fn()).not.toThrow("something else");
    expect(() => fn()).toThrow(FrameRingError);
  });

  it("all codes produce distinct error instances", () => {
    const codes = Object.values(FrameRingErrorCode).filter(
      (v): v is number => typeof v === "number",
    );

    for (const code of codes) {
      const err = new FrameRingError(`code ${code}`, code as FrameRingErrorCode);
      expect(err.code).toBe(code as FrameRingErrorCode);
    }
  });
});

// ─── createFrameRing errors (can't load native addon in tests) ────────────────

describe("createFrameRing / VideoFrameRing", () => {
  it("either throws FrameRingError (no native) or creates a mapping (native available)", async () => {
    // In a unit test environment, the native addon may or may not be loadable
    // (vitest runs in Node.js, the addon was built for Electron).
    // We just verify the error type is correct if it fails.
    const mod = await import("../video-frame-ring.js");

    try {
      const result = mod.createFrameRing({ slotPayloadSize: 65536 });
      // If we get here, the native addon loaded (running in Electron or matching Node.js ABI)
      expect(result).toBeDefined();
      expect(typeof result.name).toBe("string");
      expect(result.slotCount).toBe(3);
      expect(result.slotPayloadSize).toBe(65536);
      expect(typeof result.sessionGuid).toBe("string");
      expect(result.sessionGuid.length).toBe(32); // 16 bytes hex-encoded
    } catch (err) {
      expect(err).toBeInstanceOf(FrameRingError);
      expect((err as FrameRingError).message.toLowerCase()).toContain("native");
    }
  });

  it("VideoFrameRing class wraps native API", async () => {
    const mod = await import("../video-frame-ring.js");

    try {
      const ring = new mod.VideoFrameRing();
      ring.open("test-name", "00000000000000000000000000000000");
    } catch (err) {
      // Expected: mapping doesn't exist — but it should be a FrameRingError
      expect(err).toBeInstanceOf(FrameRingError);
    }
  });
});
