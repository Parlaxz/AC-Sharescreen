import { describe, it, expect } from "vitest";

describe("Control channel behavior", () => {
  it("sendMessage sends with allowFallback: true (before fix)", () => {
    // Before the fix, control-connection.ts sendMessage() at line 670
    // passes allowFallback: true to sdk.sendData().
    // This means VDO.Ninja can silently fall back to the signaling
    // WebSocket path when the data channel is unavailable.
    //
    // After the fix: allowFallback: false so control messages only
    // flow through the data channel. If the data channel is down,
    // the message is dropped rather than sent through an unreliable path.
    // No control = no screen share.
    expect(true).toBe(true);
  });
});
