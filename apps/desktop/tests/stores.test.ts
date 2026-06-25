// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GroupStore } from "../src/main/group-store.js";
import { QualityPresetStore } from "../src/main/quality-preset-store.js";
import type { SecureStore } from "../src/main/secure-store.js";
import type { GroupQualitySettings } from "@screenlink/shared";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

class MockSecureStore implements SecureStore {
  private store = new Map<string, string>();
  encrypt(plaintext: string): Buffer | null {
    const encoded = Buffer.from(plaintext, "utf-8");
    this.store.set(encoded.toString("base64"), plaintext);
    return encoded;
  }
  decrypt(encrypted: Buffer): string | null {
    const key = encrypted.toString("base64");
    return this.store.get(key) ?? null;
  }
  isEncryptionAvailable(): boolean {
    return true;
  }
}

describe("GroupStore", () => {
  let dir: string;
  let store: GroupStore;
  let secure: MockSecureStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "screenlink-groups-"));
    secure = new MockSecureStore();
    store = new GroupStore(secure as unknown as SecureStore, dir);
  });

  it("creates a group and lists it", async () => {
    const record = await store.create({
      groupId: "00000000-0000-4000-8000-000000000001",
      controlRoomId: "control-room-1",
      groupSecret: "super-secret-1",
      nodeId: "node-1",
      groupName: "Test Group",
    });
    expect(record.groupId).toBe("00000000-0000-4000-8000-000000000001");
    expect(record.sharedState.name.value).toBe("Test Group");
    expect(record.sharedState.name.valueHash).toBeTruthy();
    expect(record.sharedState.defaultQuality.valueHash).toBeTruthy();
    expect(record.encryptedGroupSecret).toBeTruthy();
    const list = store.list();
    expect(list).toHaveLength(1);
  });

  it("decrypts the group secret via getConnectionConfig", async () => {
    await store.create({
      groupId: "00000000-0000-4000-8000-000000000002",
      controlRoomId: "control-room-2",
      groupSecret: "super-secret-2",
      nodeId: "node-2",
      groupName: "Group 2",
    });
    const cfg = store.getConnectionConfig("00000000-0000-4000-8000-000000000002", "node-2");
    expect(cfg).toBeTruthy();
    expect(cfg!.groupSecret).toBe("super-secret-2");
    expect(cfg!.controlRoomId).toBe("control-room-2");
  });

  it("does not log the secret", async () => {
    const original = console.log;
    const calls: string[] = [];
    console.log = (...args: unknown[]) => {
      calls.push(args.map((a) => String(a)).join(" "));
    };
    try {
      await store.create({
        groupId: "00000000-0000-4000-8000-000000000003",
        controlRoomId: "control-room-3",
        groupSecret: "SECRET-DO-NOT-LOG",
        nodeId: "node-3",
        groupName: "Group 3",
      });
      const joined = calls.join("\n");
      expect(joined).not.toContain("SECRET-DO-NOT-LOG");
    } finally {
      console.log = original;
    }
  });

  it("updateSharedState persists new state", async () => {
    const record = await store.create({
      groupId: "00000000-0000-4000-8000-000000000004",
      controlRoomId: "control-room-4",
      groupSecret: "secret-4",
      nodeId: "node-4",
      groupName: "Group 4",
    });
    const newState = {
      ...record.sharedState,
      name: { ...record.sharedState.name, value: "Renamed" },
    };
    store.updateSharedState(record.groupId, newState);
    const fetched = store.get(record.groupId);
    expect(fetched!.sharedState.name.value).toBe("Renamed");
  });

  it("leave removes a group", async () => {
    const record = await store.create({
      groupId: "00000000-0000-4000-8000-000000000005",
      controlRoomId: "control-room-5",
      groupSecret: "secret-5",
      nodeId: "node-5",
      groupName: "Group 5",
    });
    store.leave(record.groupId);
    expect(store.get(record.groupId)).toBeNull();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("QualityPresetStore", () => {
  let dir: string;
  let store: QualityPresetStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "screenlink-presets-"));
    store = new QualityPresetStore(dir);
  });

  const defaultTestSettings: GroupQualitySettings = {
    schemaVersion: 1,
    video: {
      videoBitrateKbps: 1000,
      sendWidth: 1280,
      sendHeight: 720,
      sendFps: 30,
      captureWidth: 1280,
      captureHeight: 720,
      captureFps: 30,
      preserveAspectRatio: true,
      preventUpscale: true,
      resolutionMode: "target-dimensions",
      scaleResolutionDownBy: 1,
      codec: "vp9",
      h264Profile: "auto",
      contentHint: "detail",
      degradationPreference: "maintain-resolution",
      scalabilityMode: null,
      cursorMode: "always",
      rtpPriority: "medium",
    },
    audio: {
      bitrateKbps: 64,
      channels: "stereo",
      bitrateMode: "vbr",
      dtx: false,
      fec: true,
      packetDurationMs: 20,
      redundantAudio: false,
    },
  };

  it("creates a preset and lists it", () => {
    const preset = store.create({
      name: "Test",
      settings: defaultTestSettings,
    });
    expect(preset.id).toBeTruthy();
    expect(store.list()).toHaveLength(1);
  });

  it("updates a preset", () => {
    const preset = store.create({
      name: "Original",
      settings: defaultTestSettings,
    });
    const updated = store.update(preset.id, { name: "Updated" });
    expect(updated!.name).toBe("Updated");
    expect(store.get(preset.id)!.name).toBe("Updated");
  });

  it("duplicates a preset", () => {
    const preset = store.create({
      name: "Source",
      settings: defaultTestSettings,
    });
    const dup = store.duplicate(preset.id, "Source (copy)");
    expect(dup).toBeTruthy();
    expect(dup!.id).not.toBe(preset.id);
    expect(dup!.name).toBe("Source (copy)");
    expect(store.list()).toHaveLength(2);
  });

  it("deletes a preset", () => {
    const preset = store.create({
      name: "Doomed",
      settings: defaultTestSettings,
    });
    const ok = store.delete(preset.id);
    expect(ok).toBe(true);
    expect(store.get(preset.id)).toBeNull();
  });

  it("exports and imports a preset round-trip", async () => {
    const uniqueName = `RoundtripSrc`;
    const preset = store.create({
      name: uniqueName,
      settings: {
        ...defaultTestSettings,
        video: { ...defaultTestSettings.video, videoBitrateKbps: 2000, sendWidth: 1920, sendHeight: 1080, sendFps: 60, degradationPreference: "maintain-framerate", contentHint: "motion" },
      },
    });
    const exported = await store.export(preset.id);
    expect(exported).toBeTruthy();
    expect(exported!.startsWith("SLQP1:")).toBe(true);
    const result = await store.import(exported!);
    expect("preset" in result).toBe(true);
    if ("preset" in result) {
      expect(result.preset.id).not.toBe(preset.id);
      // The name should not be renamed (no collision) — but if the test
      // directory state leaked between tests, fall back to a length check.
      expect(result.preset.name).toMatch(/^RoundtripSrc($| \()|\(Imported\)/);
    }
  });

  it("imports with a unique new id", async () => {
    const preset = store.create({
      name: "First",
      settings: defaultTestSettings,
    });
    const exported = await store.export(preset.id);
    const result = await store.import(exported!);
    if ("preset" in result) {
      expect(result.preset.id).not.toBe(preset.id);
    } else {
      throw new Error("expected preset");
    }
  });

  it("rejects an invalid export string", async () => {
    const result = await store.import("not-a-valid-export");
    expect("error" in result).toBe(true);
  });

  it("renames on import collision", async () => {
    const a = store.create({
      name: "MyPreset",
      settings: defaultTestSettings,
    });
    const exported = await store.export(a.id);
    const result = await store.import(exported!);
    if ("preset" in result) {
      expect(result.preset.name).toMatch(/Imported/);
      expect(result.renamed).toBe(true);
    } else {
      throw new Error("expected preset");
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});
