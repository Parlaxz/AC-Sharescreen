// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RestartCoordinator } from "../src/renderer/services/restart-coordinator.js";
import type { Phase3Runtime } from "../src/renderer/services/phase3-runtime.js";

function makeRuntime(
  opts: {
    deviceId?: string;
    streamsByGroup?: Array<{
      groupId: string;
      hostDeviceId: string;
      hostDisplayName: string;
      logicalStreamId: string;
      mediaSessionId: string;
    }>;
    knownHosts?: string[];
  } = {},
): { runtime: Phase3Runtime; sent: Array<{ peer: string; payload: Record<string, unknown> }> } {
  const sent: Array<{ peer: string; payload: Record<string, unknown> }> = [];
  const deviceId = opts.deviceId ?? "self-host";
  const conn = {
    peerForDevice: (deviceId: string) => {
      if (deviceId === "self-host") return "peer-self";
      const idx = (opts.knownHosts ?? []).indexOf(deviceId);
      return idx >= 0 ? `peer-${idx}` : null;
    },
    sendToPeer: async (peerUuid: string, payload: Record<string, unknown>) => {
      sent.push({ peer: peerUuid, payload });
    },
  };
  const ssm = {
    state: "active",
    restartStream: vi.fn().mockResolvedValue(undefined),
    currentGroupId: opts.streamsByGroup?.[0]?.groupId ?? "g-1",
    currentLogicalStreamId: opts.streamsByGroup?.[0]?.logicalStreamId ?? "self-ls",
    currentMediaSessionId: "self-ms",
  };
  const registry = {
    getStreamsByGroup: (groupId: string) => {
      return (opts.streamsByGroup ?? [])
        .filter((s) => s.groupId === groupId)
        .map((s) => ({
          groupId: s.groupId,
          hostDeviceId: s.hostDeviceId,
          hostDisplayName: s.hostDisplayName,
          logicalStreamId: s.logicalStreamId,
          mediaSessionId: s.mediaSessionId,
          sourceKind: "screen",
          sourceName: "Display",
          startedAt: Date.now(),
          appliedSettingsRevision: 0,
          heartbeatSequence: 0,
          streamRevision: 1,
          mediaJoinMetadata: "",
          replacesSessionId: null,
          isAudioDegraded: false,
        }));
    },
  };
  const connManager = {
    getConnection: () => conn,
    broadcast: vi.fn().mockResolvedValue(undefined),
  };
  return {
    runtime: {
      deviceId,
      getStreamSessionManager: () => ssm as never,
      getActiveStreamRegistry: () => registry as never,
      getConnectionManager: () => connManager as never,
      getSyncService: () => ({ getSyncState: () => null }) as never,
    } as unknown as Phase3Runtime,
    sent,
  };
}

describe("RestartCoordinator distributed restart (Gate 10)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("restartAllStreams snapshots every current host in the group", async () => {
    const { runtime, sent } = makeRuntime({
      deviceId: "self-host",
      streamsByGroup: [
        { groupId: "g-1", hostDeviceId: "host-a", hostDisplayName: "Alice", logicalStreamId: "ls-a", mediaSessionId: "ms-a" },
        { groupId: "g-1", hostDeviceId: "host-b", hostDisplayName: "Bob", logicalStreamId: "ls-b", mediaSessionId: "ms-b" },
        { groupId: "g-1", hostDeviceId: "host-a", hostDisplayName: "Alice", logicalStreamId: "ls-a2", mediaSessionId: "ms-a2" },
      ],
      knownHosts: ["host-a", "host-b"],
    });
    const coord = new RestartCoordinator(runtime);
    const status = await coord.restartAllStreams("g-1", "stamp-1", "hash-1");
    expect(Object.keys(status.hosts).sort()).toEqual(["host-a", "host-b"]);
    // The two known hosts each received a targeted restart request.
    const targets = sent.map((s) => s.peer).sort();
    expect(targets).toEqual(["peer-0", "peer-1"]);
    // Each request is a stream.restart.request with the right commandId.
    for (const s of sent) {
      expect(s.payload.type).toBe("stream.restart.request");
      expect(s.payload.commandId).toBe(status.commandId);
      expect(s.payload.targetSettingsStamp).toBe("stamp-1");
      expect(s.payload.targetSettingsHash).toBe("hash-1");
    }
  });

  it("does not restart the same host twice for the same command", async () => {
    const { runtime, sent } = makeRuntime({
      streamsByGroup: [
        { groupId: "g-1", hostDeviceId: "host-a", hostDisplayName: "Alice", logicalStreamId: "ls-a", mediaSessionId: "ms-a" },
        { groupId: "g-1", hostDeviceId: "host-a", hostDisplayName: "Alice", logicalStreamId: "ls-a2", mediaSessionId: "ms-a2" },
      ],
      knownHosts: ["host-a"],
    });
    const coord = new RestartCoordinator(runtime);
    const status = await coord.restartAllStreams("g-1", undefined, undefined);
    // Only one targeted request, even though host-a has two streams.
    expect(sent).toHaveLength(1);
    expect(status.hosts["host-a"]?.logicalStreamIds.sort()).toEqual(["ls-a", "ls-a2"]);
  });

  it("marks a host failed when the peer is not currently mapped", async () => {
    const { runtime, sent } = makeRuntime({
      deviceId: "self-host",
      streamsByGroup: [
        { groupId: "g-1", hostDeviceId: "host-offline", hostDisplayName: "Offline", logicalStreamId: "ls-off", mediaSessionId: "ms-off" },
        { groupId: "g-1", hostDeviceId: "host-online", hostDisplayName: "Online", logicalStreamId: "ls-on", mediaSessionId: "ms-on" },
      ],
      knownHosts: ["host-online"],
    });
    const coord = new RestartCoordinator(runtime);
    const status = await coord.restartAllStreams("g-1", undefined, undefined);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.peer).toBe("peer-0");
    expect(status.hosts["host-offline"]?.state).toBe("failed");
    expect(status.hosts["host-offline"]?.failureReason).toBe("host-not-mapped");
    expect(status.hosts["host-online"]?.state).toBe("pending");
  });

  it("handleRestartResult updates per-host state and markHostCompleted finalizes", async () => {
    const { runtime, sent } = makeRuntime({
      streamsByGroup: [
        { groupId: "g-1", hostDeviceId: "host-a", hostDisplayName: "Alice", logicalStreamId: "ls-a", mediaSessionId: "ms-a" },
      ],
      knownHosts: ["host-a"],
    });
    const coord = new RestartCoordinator(runtime);
    const status = await coord.restartAllStreams("g-1", undefined, undefined);
    const commandId = status.commandId;
    coord.handleRestartResult(commandId, "host-a", "ls-a", true, true, undefined);
    expect(status.hosts["host-a"]?.state).toBe("accepted");
    coord.markHostCompleted(commandId, "host-a", "ls-a");
    expect(status.hosts["host-a"]?.state).toBe("completed");
    expect(status.completedAt).toBeGreaterThan(0);
  });

  it("handleRestartResult with failure marks the host failed and preserves the reason", async () => {
    const { runtime } = makeRuntime({
      streamsByGroup: [
        { groupId: "g-1", hostDeviceId: "host-a", hostDisplayName: "Alice", logicalStreamId: "ls-a", mediaSessionId: "ms-a" },
      ],
      knownHosts: ["host-a"],
    });
    const coord = new RestartCoordinator(runtime);
    const status = await coord.restartAllStreams("g-1", undefined, undefined);
    coord.handleRestartResult(status.commandId, "host-a", "ls-a", true, false, "no resources");
    expect(status.hosts["host-a"]?.state).toBe("failed");
    expect(status.hosts["host-a"]?.failureReason).toBe("no resources");
  });

  it("handleIncomingRestartRequest dedupes by (commandId, deviceId)", async () => {
    const { runtime } = makeRuntime();
    const coord = new RestartCoordinator(runtime);
    const r1 = await coord.handleIncomingRestartRequest("cmd-1", "g-1", undefined, undefined, "remote");
    expect(r1.accepted).toBe(true);
    const r2 = await coord.handleIncomingRestartRequest("cmd-1", "g-1", undefined, undefined, "remote");
    expect(r2.accepted).toBe(false);
    expect(r2.reason).toBe("duplicate-command");
  });

  it("handleIncomingRestartRequest rejects when target settings hash mismatches", async () => {
    const { runtime } = makeRuntime();
    const coord = new RestartCoordinator(runtime);
    // Replace getSyncService to return a known state with hash-X.
    (runtime as unknown as { getSyncService: () => unknown }).getSyncService = () => ({
      getSyncState: () => ({ state: { defaultQuality: { valueHash: "hash-X" } } }),
    });
    const r = await coord.handleIncomingRestartRequest("cmd-2", "g-1", undefined, "hash-Y", "remote");
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("target-settings-hash-mismatch");
  });
});
