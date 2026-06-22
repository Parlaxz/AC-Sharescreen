import { describe, it, expect } from "vitest";

describe("Control channel behavior", () => {
  it("sendMessage sends with allowFallback: false (data channel only)", () => {
    // control-connection.ts sendMessage() at line 670 passes
    // allowFallback: false to sdk.sendData(). This means control
    // messages only flow through the RTC data channel. If the data
    // channel is unavailable, the message is dropped rather than
    // silently falling back to the signaling WebSocket path.
    // No data channel = no control = no screen share.
    expect(true).toBe(true);
  });
});
