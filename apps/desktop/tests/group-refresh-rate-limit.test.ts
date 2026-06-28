// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@screenlink/vdo-adapter", () => ({
  getSDKConstructor: () => {
    return function () {
      return { sendData: vi.fn().mockReturnValue(true), addEventListener: vi.fn(), removeEventListener: vi.fn(), autoConnect: vi.fn().mockResolvedValue({ stop: vi.fn(), streamID: "test-id" }), disconnect: vi.fn().mockResolvedValue(undefined), leaveRoom: vi.fn().mockResolvedValue(undefined), state: { connected: false, roomJoined: false, room: null } };
    };
  },
}));

import { Phase3Runtime } from "../src/renderer/services/phase3-runtime.js";

describe("Phase3Runtime.requestGroupSync", () => {
  let runtime: Phase3Runtime;
  beforeEach(() => { vi.clearAllMocks(); runtime = new Phase3Runtime(); });
  afterEach(() => { Phase3Runtime.REFRESH_COOLDOWN_MS = 3000; });

  it("deduplicates in-flight", async () => {
    Phase3Runtime.REFRESH_COOLDOWN_MS = 0;
    const doSync = vi.spyOn(runtime as any, "doRequestGroupSync");
    const p1 = runtime.requestGroupSync("g-1");
    const p2 = runtime.requestGroupSync("g-1");
    await Promise.all([p1, p2]);
    expect(doSync).toHaveBeenCalledTimes(1);
  });

  it("skips during cooldown", async () => {
    Phase3Runtime.REFRESH_COOLDOWN_MS = 10_000;
    const doSync = vi.spyOn(runtime as any, "doRequestGroupSync");
    await runtime.requestGroupSync("g-2"); expect(doSync).toHaveBeenCalledTimes(1);
    await runtime.requestGroupSync("g-2"); expect(doSync).toHaveBeenCalledTimes(1);
  });

  it("allows after cooldown", async () => {
    Phase3Runtime.REFRESH_COOLDOWN_MS = 20;
    const doSync = vi.spyOn(runtime as any, "doRequestGroupSync");
    await runtime.requestGroupSync("g-3"); expect(doSync).toHaveBeenCalledTimes(1);
    await new Promise(r => setTimeout(r, 30));
    await runtime.requestGroupSync("g-3"); expect(doSync).toHaveBeenCalledTimes(2);
  });

  it("sends group.state.request + stream.state.request", async () => {
    Phase3Runtime.REFRESH_COOLDOWN_MS = 0;
    const send = vi.fn().mockResolvedValue(undefined);
    vi.spyOn((runtime as any).connManager, "getConnection").mockReturnValue({ state: "connected", connectedPeers: ["p1","p2"], sendToPeer: send });
    await runtime.requestGroupSync("g-4");
    expect(send).toHaveBeenCalledTimes(4);
    expect(send).toHaveBeenCalledWith("p1", { type: "group.state.request" });
    expect(send).toHaveBeenCalledWith("p1", { type: "stream.state.request" });
    expect(send).toHaveBeenCalledWith("p2", { type: "group.state.request" });
    expect(send).toHaveBeenCalledWith("p2", { type: "stream.state.request" });
  });

  it("cooldown on error", async () => {
    Phase3Runtime.REFRESH_COOLDOWN_MS = 0;
    vi.spyOn((runtime as any).syncService, "requestSync").mockRejectedValue(new Error("e"));
    const doSync = vi.spyOn(runtime as any, "doRequestGroupSync");
    await expect(runtime.requestGroupSync("g-5")).rejects.toThrow("e");
    expect(doSync).toHaveBeenCalledTimes(1);
    Phase3Runtime.REFRESH_COOLDOWN_MS = 10_000;
    await runtime.requestGroupSync("g-5");
    expect(doSync).toHaveBeenCalledTimes(1);
  });
});
