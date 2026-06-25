// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";
import { WatchedStreamManager } from "../src/renderer/services/watched-stream-manager.js";
import type { GroupControlEnvelope } from "@screenlink/shared";

interface RuntimeStub {
  deviceId: string;
  getConnectionManager: () => {
    getConnection: (groupId: string) => {
      peerForDevice: (deviceId: string) => string | null;
      sendToPeer: (peerUuid: string, payload: Record<string, unknown>) => Promise<void>;
    } | null;
  };
}

function makeRuntime(knownHosts: string[] = ["host-1"]): { runtime: RuntimeStub; sent: Array<{ peer: string; payload: Record<string, unknown> }> } {
  const sent: Array<{ peer: string; payload: Record<string, unknown> }> = [];
  const conn = {
    peerForDevice: (deviceId: string) => {
      const idx = knownHosts.indexOf(deviceId);
      return idx >= 0 ? `peer-${idx}` : null;
    },
    sendToPeer: async (peerUuid: string, payload: Record<string, unknown>) => {
      sent.push({ peer: peerUuid, payload });
    },
  };
  return {
    runtime: {
      deviceId: "viewer-1",
      getConnectionManager: () => ({
        getConnection: () => conn,
      }),
    },
    sent,
  };
}

function makeEnvelope(
  groupId: string,
  senderDeviceId: string,
  type: GroupControlEnvelope["type"],
  payload: Record<string, unknown>,
  mac = "0".repeat(64),
): GroupControlEnvelope {
  return {
    version: 3,
    type,
    messageId: crypto.randomUUID(),
    sentAt: Date.now(),
    senderDeviceId,
    groupId,
    logicalStamp: { wallTimeMs: Date.now(), counter: 0, nodeId: senderDeviceId },
    payload,
    mac,
  };
}

describe("WatchedStreamManager (Gate 5)", () => {
  it("startWatch fails when the host peer is not mapped", async () => {
    const { runtime } = makeRuntime([]);
    const m = new WatchedStreamManager(runtime as never);
    const r = await m.startWatch({
      groupId: "g-1",
      hostDeviceId: "host-x",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("host-not-mapped");
    }
  });

  it("startWatch sends a targeted join request — never broadcast", async () => {
    const { runtime, sent } = makeRuntime(["host-1"]);
    const m = new WatchedStreamManager(runtime as never);
    const r = await m.startWatch({
      groupId: "g-1",
      hostDeviceId: "host-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
    });
    expect(r.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.peer).toBe("peer-0");
    expect(sent[0]?.payload.type).toBe("stream.join.request");
  });

  it("handleJoinResponse correlates by requestId and stores bind token", async () => {
    const { runtime } = makeRuntime(["host-1"]);
    const m = new WatchedStreamManager(runtime as never);
    const r = await m.startWatch({
      groupId: "g-1",
      hostDeviceId: "host-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
    });
    if (!r.ok) throw new Error("startWatch failed");
    const requestId = r.entry.pendingJoinRequestId!;
    const env = makeEnvelope("g-1", "host-1", "stream.join.response", {
      logicalStreamId: "ls-1",
      accepted: true,
      viewerDeviceId: "viewer-1",
      requestId,
      mediaSessionId: "ms-1",
      bindingToken: "tok-1",
      streamId: "vdo-stream-1",
      password: "vdo-pass-1",
    });
    expect(m.handleJoinResponse(env)).toBe(true);
    const entry = m.get({ groupId: "g-1", hostDeviceId: "host-1", logicalStreamId: "ls-1" });
    expect(entry?.pendingBindToken).toBe("tok-1");
  });

  it("handleBindAck moves entry to connected and records the bound media peer", () => {
    const { runtime } = makeRuntime(["host-1"]);
    const m = new WatchedStreamManager(runtime as never);
    void m.startWatch({ groupId: "g-1", hostDeviceId: "host-1", logicalStreamId: "ls-1", mediaSessionId: "ms-1" });
    const env = makeEnvelope("g-1", "host-1", "stream.bind.ack", {
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      viewerDeviceId: "viewer-1",
      hostDeviceId: "host-1",
      accepted: true,
      boundMediaPeer: "media-peer-1",
    });
    expect(m.handleBindAck(env)).toBe(true);
    const entry = m.get({ groupId: "g-1", hostDeviceId: "host-1", logicalStreamId: "ls-1" });
    expect(entry?.connectionState).toBe("connected");
    expect(entry?.mediaPeerUuid).toBe("media-peer-1");
  });

  it("handleStreamRestarted preserves mute/volume and reconnects", async () => {
    const { runtime, sent } = makeRuntime(["host-1"]);
    const m = new WatchedStreamManager(runtime as never);
    await m.startWatch({ groupId: "g-1", hostDeviceId: "host-1", logicalStreamId: "ls-1", mediaSessionId: "ms-1" });
    m.setMute({ groupId: "g-1", hostDeviceId: "host-1", logicalStreamId: "ls-1" }, true);
    m.setVolume({ groupId: "g-1", hostDeviceId: "host-1", logicalStreamId: "ls-1" }, 0.42);
    sent.length = 0; // reset
    const env = makeEnvelope("g-1", "host-1", "stream.restarted", {
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-2",
      groupId: "g-1",
      hostDeviceId: "host-1",
      hostDisplayName: "Host",
      sourceKind: "screen",
      sourceName: "Display",
      startedAt: Date.now(),
      appliedSettingsRevision: 0,
      heartbeatSequence: 0,
      streamRevision: 2,
      mediaJoinMetadata: "",
      replacesSessionId: "ms-1",
    });
    await m.handleStreamRestarted(env);
    const entry = m.get({ groupId: "g-1", hostDeviceId: "host-1", logicalStreamId: "ls-1" });
    expect(entry?.mediaSessionId).toBe("ms-2");
    expect(entry?.mute).toBe(true);
    expect(entry?.volume).toBeCloseTo(0.42);
    expect(sent.length).toBe(1);
    expect(sent[0]?.payload.type).toBe("stream.join.request");
  });

  it("handleStreamStopped closes and removes the entry", () => {
    const { runtime } = makeRuntime(["host-1"]);
    const m = new WatchedStreamManager(runtime as never);
    void m.startWatch({ groupId: "g-1", hostDeviceId: "host-1", logicalStreamId: "ls-1", mediaSessionId: "ms-1" });
    const env = makeEnvelope("g-1", "host-1", "stream.stopped", {
      groupId: "g-1",
      hostDeviceId: "host-1",
      logicalStreamId: "ls-1",
    });
    m.handleStreamStopped(env);
    expect(m.get({ groupId: "g-1", hostDeviceId: "host-1", logicalStreamId: "ls-1" })).toBeNull();
  });

  it("stopWatch is idempotent and tears down the entry", () => {
    const { runtime } = makeRuntime(["host-1"]);
    const m = new WatchedStreamManager(runtime as never);
    void m.startWatch({ groupId: "g-1", hostDeviceId: "host-1", logicalStreamId: "ls-1", mediaSessionId: "ms-1" });
    m.stopWatch({ groupId: "g-1", hostDeviceId: "host-1", logicalStreamId: "ls-1" });
    m.stopWatch({ groupId: "g-1", hostDeviceId: "host-1", logicalStreamId: "ls-1" });
    expect(m.list()).toHaveLength(0);
  });

  it("supports multiple simultaneous watched streams with different logical stream IDs", async () => {
    const { runtime, sent } = makeRuntime(["host-1", "host-2"]);
    const m = new WatchedStreamManager(runtime as never);
    await m.startWatch({ groupId: "g-1", hostDeviceId: "host-1", logicalStreamId: "ls-1", mediaSessionId: "ms-1" });
    await m.startWatch({ groupId: "g-1", hostDeviceId: "host-2", logicalStreamId: "ls-2", mediaSessionId: "ms-2" });
    expect(m.list()).toHaveLength(2);
    expect(sent.map((s) => s.peer).sort()).toEqual(["peer-0", "peer-1"]);
  });
});
