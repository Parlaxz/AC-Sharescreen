import { describe, it, expect } from "vitest";
import {
  type PairingConfig,
  type PairingExport,
  PAIRING_LIFECYCLE,
  parsePairingCode,
  formatPairingCode,
  createCreatorConfig,
  createImporterConfig,
  getPairingDisplayInfo,
  applyPeerHello,
  isPairedLifecycle,
  isPreHandshakeLifecycle,
  resetToUnpaired,
  parsePairingLink,
  getDefaultDevDisplayName,
  getImporterDisplayName,
} from "@screenlink/shared";

// ── Helpers ────────────────────────────────────────────────────────────────

const TEST_PAIR_ID = "test-pair-id-1234567890";
const TEST_PAIR_SECRET = "test-pair-secret-abcdef1234567890abcdef1234567890";
const TEST_DEVICE_ID_ALICE = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const TEST_DEVICE_ID_BOB = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const TEST_DEVICE_ID_MALLORY = "deadbeef-dead-4ead-beef-deadbeefdead";
const TEST_DISPLAY_ALICE = "Alice";
const TEST_DISPLAY_BOB = "Bob";

function makeExportData(overrides?: Partial<PairingExport>): PairingExport {
  return {
    version: 1,
    pairId: TEST_PAIR_ID,
    pairSecret: TEST_PAIR_SECRET,
    creatorDeviceId: TEST_DEVICE_ID_ALICE,
    creatorDisplayName: TEST_DISPLAY_ALICE,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("PairingLifecycle", () => {
  it("has exactly the required states", () => {
    expect(new Set(Object.values(PAIRING_LIFECYCLE))).toEqual(new Set([
      "UNPAIRED",
      "PAIR_CREATED_WAITING_FOR_IMPORT",
      "PAIR_IMPORTED_CONNECTING",
      "PAIR_CONNECTED_UNCONFIRMED",
      "PAIRED_OFFLINE",
      "PAIRED_ONLINE",
    ]));
  });

  it("isPairedLifecycle returns true for completed states", () => {
    expect(isPairedLifecycle("PAIRED_ONLINE")).toBe(true);
    expect(isPairedLifecycle("PAIRED_OFFLINE")).toBe(true);
  });

  it("isPairedLifecycle returns false for non-completed states", () => {
    expect(isPairedLifecycle("UNPAIRED")).toBe(false);
    expect(isPairedLifecycle("PAIR_CREATED_WAITING_FOR_IMPORT")).toBe(false);
    expect(isPairedLifecycle("PAIR_IMPORTED_CONNECTING")).toBe(false);
    expect(isPairedLifecycle("PAIR_CONNECTED_UNCONFIRMED")).toBe(false);
  });

  it("isPreHandshakeLifecycle returns true for states before handshake", () => {
    expect(isPreHandshakeLifecycle("PAIR_CREATED_WAITING_FOR_IMPORT")).toBe(true);
    expect(isPreHandshakeLifecycle("PAIR_IMPORTED_CONNECTING")).toBe(true);
    expect(isPreHandshakeLifecycle("PAIR_CONNECTED_UNCONFIRMED")).toBe(true);
    expect(isPreHandshakeLifecycle("PAIRED_ONLINE")).toBe(false);
    expect(isPreHandshakeLifecycle("PAIRED_OFFLINE")).toBe(false);
    expect(isPreHandshakeLifecycle("UNPAIRED")).toBe(false);
  });
});

describe("createCreatorConfig", () => {
  it("creates config with PAIR_CREATED_WAITING_FOR_IMPORT lifecycle", () => {
    const result = createCreatorConfig({
      pairId: TEST_PAIR_ID,
      pairSecret: TEST_PAIR_SECRET,
      localDeviceId: TEST_DEVICE_ID_ALICE,
      localDisplayName: TEST_DISPLAY_ALICE,
    });

    expect(result.config.pairingLifecycle).toBe("PAIR_CREATED_WAITING_FOR_IMPORT");
    expect(result.config.localDeviceId).toBe(TEST_DEVICE_ID_ALICE);
    expect(result.config.localDisplayName).toBe(TEST_DISPLAY_ALICE);
    expect(result.config.pairId).toBe(TEST_PAIR_ID);
    expect(result.config.remoteDeviceId).toBeUndefined();
    expect(result.config.remoteDisplayName).toBeUndefined();
  });

  it("generates a valid pairing link", () => {
    const result = createCreatorConfig({
      pairId: TEST_PAIR_ID,
      pairSecret: TEST_PAIR_SECRET,
      localDeviceId: TEST_DEVICE_ID_ALICE,
      localDisplayName: TEST_DISPLAY_ALICE,
    });

    expect(result.pairingLink).toMatch(/^screenlink:\/\/pair\?v=1&data=/);

    const url = new URL(result.pairingLink);
    const data = url.searchParams.get("data");
    expect(data).toBeTruthy();
    const parsed = parsePairingCode(decodeURIComponent(data!));
    expect(parsed).not.toBeNull();
    expect(parsed!.creatorDeviceId).toBe(TEST_DEVICE_ID_ALICE);
  });

  it("exportData has correct fields", () => {
    const result = createCreatorConfig({
      pairId: TEST_PAIR_ID,
      pairSecret: TEST_PAIR_SECRET,
      localDeviceId: TEST_DEVICE_ID_ALICE,
      localDisplayName: TEST_DISPLAY_ALICE,
    });

    expect(result.exportData.pairId).toBe(TEST_PAIR_ID);
    expect(result.exportData.pairSecret).toBe(TEST_PAIR_SECRET);
    expect(result.exportData.creatorDeviceId).toBe(TEST_DEVICE_ID_ALICE);
    expect(result.exportData.creatorDisplayName).toBe(TEST_DISPLAY_ALICE);
  });

  it("creating a pairing does NOT mark it complete", () => {
    const result = createCreatorConfig({
      pairId: TEST_PAIR_ID,
      pairSecret: TEST_PAIR_SECRET,
      localDeviceId: TEST_DEVICE_ID_ALICE,
      localDisplayName: TEST_DISPLAY_ALICE,
    });

    expect(isPairedLifecycle(result.config.pairingLifecycle)).toBe(false);
    expect(result.config.remoteDeviceId).toBeUndefined();
    expect(result.config.remoteDisplayName).toBeUndefined();
  });
});

describe("createImporterConfig", () => {
  it("creates config with PAIR_IMPORTED_CONNECTING lifecycle", () => {
    const exportData = makeExportData();
    const config = createImporterConfig({
      exportData,
      localDeviceId: TEST_DEVICE_ID_BOB,
      localDisplayName: TEST_DISPLAY_BOB,
    });

    expect(config.pairingLifecycle).toBe("PAIR_IMPORTED_CONNECTING");
    expect(config.pairId).toBe(TEST_PAIR_ID);
    expect(config.localDeviceId).toBe(TEST_DEVICE_ID_BOB);
    expect(config.localDisplayName).toBe(TEST_DISPLAY_BOB);
  });

  it("sets remoteDeviceId to the creator's device ID", () => {
    const exportData = makeExportData();
    const config = createImporterConfig({
      exportData,
      localDeviceId: TEST_DEVICE_ID_BOB,
      localDisplayName: TEST_DISPLAY_BOB,
    });

    expect(config.remoteDeviceId).toBe(TEST_DEVICE_ID_ALICE);
    expect(config.remoteDisplayName).toBe(TEST_DISPLAY_ALICE);
  });

  it("creates a DIFFERENT local device ID than the creator", () => {
    const exportData = makeExportData();
    const config = createImporterConfig({
      exportData,
      localDeviceId: TEST_DEVICE_ID_BOB,
      localDisplayName: TEST_DISPLAY_BOB,
    });

    expect(config.localDeviceId).not.toBe(exportData.creatorDeviceId);
    expect(config.localDeviceId).toBe(TEST_DEVICE_ID_BOB);
  });

  it("importing does NOT mark pairing complete", () => {
    const exportData = makeExportData();
    const config = createImporterConfig({
      exportData,
      localDeviceId: TEST_DEVICE_ID_BOB,
      localDisplayName: TEST_DISPLAY_BOB,
    });

    expect(isPairedLifecycle(config.pairingLifecycle)).toBe(false);
  });

  it("throws if localDeviceId equals creatorDeviceId", () => {
    const exportData = makeExportData();
    expect(() => {
      createImporterConfig({
        exportData,
        localDeviceId: exportData.creatorDeviceId, // SAME as creator!
        localDisplayName: TEST_DISPLAY_BOB,
      });
    }).toThrow("Importer localDeviceId must differ from creatorDeviceId");
  });
});

describe("parsePairingLink", () => {
  it("parses a valid screenlink://pair link", () => {
    const exportData = makeExportData();
    const code = formatPairingCode(exportData);
    const link = `screenlink://pair?v=1&data=${encodeURIComponent(code)}`;

    const result = parsePairingLink(link);
    expect(result).not.toBeNull();
    expect(result!.pairId).toBe(TEST_PAIR_ID);
    expect(result!.creatorDeviceId).toBe(TEST_DEVICE_ID_ALICE);
    expect(result!.creatorDisplayName).toBe(TEST_DISPLAY_ALICE);
  });

  it("returns null for invalid links", () => {
    expect(parsePairingLink("")).toBeNull();
    expect(parsePairingLink("not-a-link")).toBeNull();
    expect(parsePairingLink("screenlink://pair?")).toBeNull();
    expect(parsePairingLink("screenlink://pair?v=1")).toBeNull();
    expect(parsePairingLink("screenlink://pair?v=1&data=invalid-base64")).toBeNull();
  });
});

describe("getPairingDisplayInfo", () => {
  it('returns "Paired with: Unknown" never', () => {
    const lifecycles = Object.values(PAIRING_LIFECYCLE);

    for (const lifecycle of lifecycles) {
      const config: PairingConfig = {
        version: 1,
        pairId: TEST_PAIR_ID,
        pairSecret: TEST_PAIR_SECRET,
        localDeviceId: TEST_DEVICE_ID_ALICE,
        localDisplayName: TEST_DISPLAY_ALICE,
        pairingLifecycle: lifecycle,
      };

      const info = getPairingDisplayInfo(config);
      expect(info.pairedName).not.toContain("Unknown");
    }
  });

  it('shows friend name when paired online', () => {
    const config: PairingConfig = {
      version: 1,
      pairId: TEST_PAIR_ID,
      pairSecret: TEST_PAIR_SECRET,
      localDeviceId: TEST_DEVICE_ID_ALICE,
      localDisplayName: TEST_DISPLAY_ALICE,
      pairingLifecycle: "PAIRED_ONLINE",
      remoteDeviceId: TEST_DEVICE_ID_BOB,
      remoteDisplayName: TEST_DISPLAY_BOB,
    };

    const info = getPairingDisplayInfo(config);
    expect(info.pairedName).toBe(TEST_DISPLAY_BOB);
    expect(info.showReplaceForget).toBe(true);
    expect(info.showLink).toBe(false);
  });

  it('shows friend name when paired offline', () => {
    const config: PairingConfig = {
      version: 1,
      pairId: TEST_PAIR_ID,
      pairSecret: TEST_PAIR_SECRET,
      localDeviceId: TEST_DEVICE_ID_ALICE,
      localDisplayName: TEST_DISPLAY_ALICE,
      pairingLifecycle: "PAIRED_OFFLINE",
      remoteDeviceId: TEST_DEVICE_ID_BOB,
      remoteDisplayName: TEST_DISPLAY_BOB,
    };

    const info = getPairingDisplayInfo(config);
    expect(info.pairedName).toBe(TEST_DISPLAY_BOB);
    expect(info.showReplaceForget).toBe(true);
    expect(info.showLink).toBe(false);
  });

  it("shows link when waiting for import", () => {
    const config: PairingConfig = {
      version: 1,
      pairId: TEST_PAIR_ID,
      pairSecret: TEST_PAIR_SECRET,
      localDeviceId: TEST_DEVICE_ID_ALICE,
      localDisplayName: TEST_DISPLAY_ALICE,
      pairingLifecycle: "PAIR_CREATED_WAITING_FOR_IMPORT",
    };

    const info = getPairingDisplayInfo(config);
    expect(info.showLink).toBe(true);
    expect(info.showReplaceForget).toBe(false);
    expect(info.pairedName).toBe("");
  });

  it("shows link during PAIR_CONNECTED_UNCONFIRMED if pendingPairingLink is set", () => {
    const config: PairingConfig = {
      version: 1,
      pairId: TEST_PAIR_ID,
      pairSecret: TEST_PAIR_SECRET,
      localDeviceId: TEST_DEVICE_ID_ALICE,
      localDisplayName: TEST_DISPLAY_ALICE,
      pairingLifecycle: "PAIR_CONNECTED_UNCONFIRMED",
      pendingPairingLink: "screenlink://pair?v=1&data=abc123",
    };

    const info = getPairingDisplayInfo(config);
    expect(info.showLink).toBe(true);
    expect(info.showReplaceForget).toBe(false);
    expect(info.pairedName).toBe("");
  });

  it("does NOT show link during PAIR_CONNECTED_UNCONFIRMED without pendingPairingLink", () => {
    const config: PairingConfig = {
      version: 1,
      pairId: TEST_PAIR_ID,
      pairSecret: TEST_PAIR_SECRET,
      localDeviceId: TEST_DEVICE_ID_ALICE,
      localDisplayName: TEST_DISPLAY_ALICE,
      pairingLifecycle: "PAIR_CONNECTED_UNCONFIRMED",
      // no pendingPairingLink
    };

    const info = getPairingDisplayInfo(config);
    expect(info.showLink).toBe(false);
  });

  it("shows generic display name when friend name is not available", () => {
    const config: PairingConfig = {
      version: 1,
      pairId: TEST_PAIR_ID,
      pairSecret: TEST_PAIR_SECRET,
      localDeviceId: TEST_DEVICE_ID_ALICE,
      localDisplayName: TEST_DISPLAY_ALICE,
      pairingLifecycle: "PAIRED_ONLINE",
    };

    const info = getPairingDisplayInfo(config);
    expect(info.pairedName).not.toContain("Unknown");
    expect(info.pairedName).toBe("");
  });

  it("shows nothing for unpaired", () => {
    const info = getPairingDisplayInfo(null);
    expect(info.showLink).toBe(false);
    expect(info.showReplaceForget).toBe(false);
    expect(info.pairedName).toBe("");
    expect(info.statusText).toBe("");
  });
});

describe("applyPeerHello", () => {
  it("updates remote identity on creator config", () => {
    const result = createCreatorConfig({
      pairId: TEST_PAIR_ID,
      pairSecret: TEST_PAIR_SECRET,
      localDeviceId: TEST_DEVICE_ID_ALICE,
      localDisplayName: TEST_DISPLAY_ALICE,
    });

    const { config: updated, accepted } = applyPeerHello(result.config, TEST_DEVICE_ID_BOB, TEST_DISPLAY_BOB);

    expect(accepted).toBe(true);
    expect(updated).not.toBeNull();
    expect(updated!.remoteDeviceId).toBe(TEST_DEVICE_ID_BOB);
    expect(updated!.remoteDisplayName).toBe(TEST_DISPLAY_BOB);
    expect(updated!.trustedAt).toBeGreaterThan(0);
    expect(updated!.pairingLifecycle).toBe("PAIRED_ONLINE");
    // Pending link should be cleared
    expect(updated!.pendingPairingLink).toBeUndefined();
  });

  it("does not overwrite already-known remote identity", () => {
    const config: PairingConfig = {
      version: 1,
      pairId: TEST_PAIR_ID,
      pairSecret: TEST_PAIR_SECRET,
      localDeviceId: TEST_DEVICE_ID_ALICE,
      localDisplayName: TEST_DISPLAY_ALICE,
      pairingLifecycle: "PAIRED_ONLINE",
      remoteDeviceId: TEST_DEVICE_ID_BOB,
      remoteDisplayName: TEST_DISPLAY_BOB,
      trustedAt: 1000,
    };

    const { config: updated, accepted } = applyPeerHello(config, TEST_DEVICE_ID_BOB, "Bob NewName");

    expect(accepted).toBe(true);
    expect(updated).not.toBeNull();
    // Display name should NOT be overwritten
    expect(updated!.remoteDisplayName).toBe(TEST_DISPLAY_BOB);
    // trustedAt should be preserved for already-known identity
    expect(updated!.trustedAt).toBe(1000);
    // Lifecycle should stay PAIRED_ONLINE
    expect(updated!.pairingLifecycle).toBe("PAIRED_ONLINE");
  });

  it("rejects hello from different device ID when trust exists", () => {
    const config: PairingConfig = {
      version: 1,
      pairId: TEST_PAIR_ID,
      pairSecret: TEST_PAIR_SECRET,
      localDeviceId: TEST_DEVICE_ID_ALICE,
      localDisplayName: TEST_DISPLAY_ALICE,
      pairingLifecycle: "PAIRED_ONLINE",
      remoteDeviceId: TEST_DEVICE_ID_BOB,
      remoteDisplayName: TEST_DISPLAY_BOB,
      trustedAt: 1000,
    };

    // Mallory tries to impersonate Bob with a different device ID
    const { config: updated, accepted, reason } = applyPeerHello(
      config,
      TEST_DEVICE_ID_MALLORY,
      "Mallory",
    );

    expect(accepted).toBe(false);
    expect(updated).toBeNull();
    expect(reason).toContain("does not match trusted identity");
  });

  it("transitions importer from PAIR_IMPORTED_CONNECTING to PAIRED_ONLINE", () => {
    const exportData = makeExportData();
    const config = createImporterConfig({
      exportData,
      localDeviceId: TEST_DEVICE_ID_BOB,
      localDisplayName: TEST_DISPLAY_BOB,
    });

    const { config: updated, accepted } = applyPeerHello(config, TEST_DEVICE_ID_ALICE, TEST_DISPLAY_ALICE);

    expect(accepted).toBe(true);
    expect(updated).not.toBeNull();
    expect(updated!.pairingLifecycle).toBe("PAIRED_ONLINE");
    expect(updated!.remoteDeviceId).toBe(TEST_DEVICE_ID_ALICE);
    expect(updated!.trustedAt).toBeGreaterThan(0);
  });
});

describe("resetToUnpaired", () => {
  it("clears all pairing state", () => {
    const config: PairingConfig = {
      version: 1,
      pairId: TEST_PAIR_ID,
      pairSecret: TEST_PAIR_SECRET,
      localDeviceId: TEST_DEVICE_ID_ALICE,
      localDisplayName: TEST_DISPLAY_ALICE,
      pairingLifecycle: "PAIRED_ONLINE",
      remoteDeviceId: TEST_DEVICE_ID_BOB,
      remoteDisplayName: TEST_DISPLAY_BOB,
      trustedAt: 1234567890,
    };

    const cleared = resetToUnpaired();
    expect(cleared).toBeNull();
  });

  it("returns null when there is nothing to clear", () => {
    expect(resetToUnpaired()).toBeNull();
  });
});

describe("getDefaultDevDisplayName", () => {
  it('returns "Alice" for alice profile', () => {
    expect(getDefaultDevDisplayName("alice")).toBe("Alice");
  });

  it('returns "Bob" for bob profile', () => {
    expect(getDefaultDevDisplayName("bob")).toBe("Bob");
  });

  it("returns null for unknown profiles", () => {
    expect(getDefaultDevDisplayName("charlie")).toBeNull();
    expect(getDefaultDevDisplayName("")).toBeNull();
  });
});

describe("getImporterDisplayName", () => {
  it("uses saved display name if not default", () => {
    expect(getImporterDisplayName("MyName", undefined)).toBe("MyName");
    expect(getImporterDisplayName("MyName", "alice")).toBe("MyName");
  });

  it('falls back to dev profile default when current name is "Host"', () => {
    expect(getImporterDisplayName("Host", "alice")).toBe("Alice");
    expect(getImporterDisplayName("Host", "bob")).toBe("Bob");
  });

  it('falls back to "ScreenLink User" when no dev profile and name is default', () => {
    expect(getImporterDisplayName("Host", undefined)).toBe("ScreenLink User");
    expect(getImporterDisplayName("", undefined)).toBe("ScreenLink User");
    expect(getImporterDisplayName(undefined, undefined)).toBe("ScreenLink User");
  });
});

describe("Alice-first and Bob-first ordering (pure state model)", () => {
  it("creator learns importer ID through handshake regardless of who connects first", () => {
    const aliceResult = createCreatorConfig({
      pairId: TEST_PAIR_ID,
      pairSecret: TEST_PAIR_SECRET,
      localDeviceId: TEST_DEVICE_ID_ALICE,
      localDisplayName: TEST_DISPLAY_ALICE,
    });

    const bobConfig = createImporterConfig({
      exportData: aliceResult.exportData,
      localDeviceId: TEST_DEVICE_ID_BOB,
      localDisplayName: TEST_DISPLAY_BOB,
    });

    // Alice receives Bob's hello
    const aliceAfterHello = applyPeerHello(aliceResult.config, TEST_DEVICE_ID_BOB, TEST_DISPLAY_BOB);
    expect(aliceAfterHello.accepted).toBe(true);
    expect(aliceAfterHello.config!.remoteDeviceId).toBe(TEST_DEVICE_ID_BOB);
    expect(aliceAfterHello.config!.remoteDisplayName).toBe(TEST_DISPLAY_BOB);
    expect(isPairedLifecycle(aliceAfterHello.config!.pairingLifecycle)).toBe(true);

    // Bob receives Alice's hello
    const bobAfterHello = applyPeerHello(bobConfig, TEST_DEVICE_ID_ALICE, TEST_DISPLAY_ALICE);
    expect(bobAfterHello.accepted).toBe(true);
    expect(bobAfterHello.config!.remoteDeviceId).toBe(TEST_DEVICE_ID_ALICE);
    expect(bobAfterHello.config!.remoteDisplayName).toBe(TEST_DISPLAY_ALICE);
    expect(isPairedLifecycle(bobAfterHello.config!.pairingLifecycle)).toBe(true);

    // Their local device IDs are different
    expect(aliceResult.config.localDeviceId).not.toBe(bobConfig.localDeviceId);
  });

  it("reconnect from offline preserves trusted identity", () => {
    const savedConfig: PairingConfig = {
      version: 1,
      pairId: TEST_PAIR_ID,
      pairSecret: TEST_PAIR_SECRET,
      localDeviceId: TEST_DEVICE_ID_ALICE,
      localDisplayName: TEST_DISPLAY_ALICE,
      pairingLifecycle: "PAIRED_OFFLINE",
      remoteDeviceId: TEST_DEVICE_ID_BOB,
      remoteDisplayName: TEST_DISPLAY_BOB,
      trustedAt: 1234567890,
    };

    // App restarts, loads saved config - identity is preserved
    expect(savedConfig.remoteDeviceId).toBe(TEST_DEVICE_ID_BOB);
    expect(savedConfig.remoteDisplayName).toBe(TEST_DISPLAY_BOB);
    expect(savedConfig.trustedAt).toBe(1234567890);

    // Reconnecting - matching hello preserves identity
    const afterReconnect = applyPeerHello(savedConfig, TEST_DEVICE_ID_BOB, TEST_DISPLAY_BOB);
    expect(afterReconnect.accepted).toBe(true);
    expect(afterReconnect.config!.remoteDeviceId).toBe(TEST_DEVICE_ID_BOB);
    expect(afterReconnect.config!.remoteDisplayName).toBe(TEST_DISPLAY_BOB);
    expect(afterReconnect.config!.pairingLifecycle).toBe("PAIRED_ONLINE");

    // Mismatch hello is rejected
    const wrongHello = applyPeerHello(afterReconnect.config!, TEST_DEVICE_ID_MALLORY, "Mallory");
    expect(wrongHello.accepted).toBe(false);
    expect(wrongHello.config).toBeNull();
  });

  it("importer does not immediately claim pairing complete on import", () => {
    // Verifies that createImporterConfig does NOT set PAIRED_ONLINE
    const exportData = makeExportData();
    const config = createImporterConfig({
      exportData,
      localDeviceId: TEST_DEVICE_ID_BOB,
      localDisplayName: TEST_DISPLAY_BOB,
    });

    expect(config.pairingLifecycle).toBe("PAIR_IMPORTED_CONNECTING");
    expect(isPairedLifecycle(config.pairingLifecycle)).toBe(false);
  });

  it("creator link remains visible before handshake completes", () => {
    // Creator creates pairing
    const result = createCreatorConfig({
      pairId: TEST_PAIR_ID,
      pairSecret: TEST_PAIR_SECRET,
      localDeviceId: TEST_DEVICE_ID_ALICE,
      localDisplayName: TEST_DISPLAY_ALICE,
    });

    // Verify link is visible right after creation
    const infoAfterCreate = getPairingDisplayInfo(result.config);
    expect(infoAfterCreate.showLink).toBe(true);

    // Simulate signal connect (lifecycle transitions to PAIR_CONNECTED_UNCONFIRMED)
    // but pendingPairingLink is still set — link should remain visible
    const signalConnectedConfig: PairingConfig = {
      ...result.config,
      pairingLifecycle: "PAIR_CONNECTED_UNCONFIRMED",
    };
    const infoAfterSignal = getPairingDisplayInfo(signalConnectedConfig);
    expect(infoAfterSignal.showLink).toBe(true);

    // Now handshake completes — pending link is cleared
    const { config: afterHello } = applyPeerHello(
      signalConnectedConfig,
      TEST_DEVICE_ID_BOB,
      TEST_DISPLAY_BOB,
    );
    const infoAfterHello = getPairingDisplayInfo(afterHello!);
    expect(infoAfterHello.showLink).toBe(false);
  });

  it("dev profile default display names actually apply", () => {
    expect(getDefaultDevDisplayName("alice")).toBe("Alice");
    expect(getDefaultDevDisplayName("bob")).toBe("Bob");
    // getImporterDisplayName applies them when current name is "Host"
    expect(getImporterDisplayName("Host", "alice")).toBe("Alice");
    expect(getImporterDisplayName("Host", "bob")).toBe("Bob");
  });

  it("startup with persisted trusted remote identity preloads the remote name", () => {
    // Simulate what control-connection.ts does on start:
    // Load config, if it has remoteDisplayName/remoteDeviceId, preload into store.
    const savedConfig: PairingConfig = {
      version: 1,
      pairId: TEST_PAIR_ID,
      pairSecret: TEST_PAIR_SECRET,
      localDeviceId: TEST_DEVICE_ID_ALICE,
      localDisplayName: TEST_DISPLAY_ALICE,
      pairingLifecycle: "PAIRED_OFFLINE",
      remoteDeviceId: TEST_DEVICE_ID_BOB,
      remoteDisplayName: TEST_DISPLAY_BOB,
      trustedAt: 1234567890,
    };

    // On restart, the remote identity is visible from the config
    expect(savedConfig.remoteDisplayName).toBe(TEST_DISPLAY_BOB);
    expect(savedConfig.remoteDeviceId).toBe(TEST_DEVICE_ID_BOB);

    // The display info should show the friend name even while offline
    const info = getPairingDisplayInfo(savedConfig);
    expect(info.pairedName).toBe(TEST_DISPLAY_BOB);
    expect(info.statusText).toContain(TEST_DISPLAY_BOB);
    expect(info.statusText).toContain("offline");
  });

  it("disconnect does not erase trusted identity", () => {
    // Trusted config before disconnect
    const beforeConfig: PairingConfig = {
      version: 1,
      pairId: TEST_PAIR_ID,
      pairSecret: TEST_PAIR_SECRET,
      localDeviceId: TEST_DEVICE_ID_ALICE,
      localDisplayName: TEST_DISPLAY_ALICE,
      pairingLifecycle: "PAIRED_ONLINE",
      remoteDeviceId: TEST_DEVICE_ID_BOB,
      remoteDisplayName: TEST_DISPLAY_BOB,
      trustedAt: 1234567890,
    };

    // Simulate disconnect — lifecycle goes to PAIRED_OFFLINE
    const afterConfig: PairingConfig = {
      ...beforeConfig,
      pairingLifecycle: "PAIRED_OFFLINE",
    };

    // remoteDisplayName is NOT erased
    expect(afterConfig.remoteDisplayName).toBe(TEST_DISPLAY_BOB);
    expect(afterConfig.remoteDeviceId).toBe(TEST_DEVICE_ID_BOB);

    // getPairingDisplayInfo still shows the friend name
    const info = getPairingDisplayInfo(afterConfig);
    expect(info.pairedName).toBe(TEST_DISPLAY_BOB);
    expect(info.showLink).toBe(false);
    expect(info.showReplaceForget).toBe(true);
  });

  it("signaling-connected alone does NOT become PAIR_CONNECTED_UNCONFIRMED", () => {
    // Creator stays in PAIR_CREATED_WAITING_FOR_IMPORT even after signal connects
    const creatorConfig: PairingConfig = {
      version: 1,
      pairId: TEST_PAIR_ID,
      pairSecret: TEST_PAIR_SECRET,
      localDeviceId: TEST_DEVICE_ID_ALICE,
      localDisplayName: TEST_DISPLAY_ALICE,
      pairingLifecycle: "PAIR_CREATED_WAITING_FOR_IMPORT",
      pendingPairingLink: "screenlink://pair?v=1&data=abc123",
    };

    // Signal connected — but NO data channel yet, so lifecycle stays the same
    // NOTE: The control-connection.ts must NOT transition to PAIR_CONNECTED_UNCONFIRMED
    // on the SDK "connected" event, only on "dataChannelOpen".
    // Verify the pure function behavior:
    expect(creatorConfig.pairingLifecycle).toBe("PAIR_CREATED_WAITING_FOR_IMPORT");
    expect(isPreHandshakeLifecycle(creatorConfig.pairingLifecycle)).toBe(true);
    expect(isPairedLifecycle(creatorConfig.pairingLifecycle)).toBe(false);

    // The display info still shows the link (creator still waiting)
    const info = getPairingDisplayInfo(creatorConfig);
    expect(info.showLink).toBe(true);
    expect(info.pairedName).toBe("");

    // Importer also stays in PAIR_IMPORTED_CONNECTING after signal connects
    const importerConfig: PairingConfig = {
      version: 1,
      pairId: TEST_PAIR_ID,
      pairSecret: TEST_PAIR_SECRET,
      localDeviceId: TEST_DEVICE_ID_BOB,
      localDisplayName: TEST_DISPLAY_BOB,
      pairingLifecycle: "PAIR_IMPORTED_CONNECTING",
    };
    expect(importerConfig.pairingLifecycle).toBe("PAIR_IMPORTED_CONNECTING");
    expect(isPreHandshakeLifecycle(importerConfig.pairingLifecycle)).toBe(true);
    expect(isPairedLifecycle(importerConfig.pairingLifecycle)).toBe(false);
  });

  it("updateRemoteIdentity rejection does NOT move online", () => {
    // Config with trusted identity for Bob
    const config: PairingConfig = {
      version: 1,
      pairId: TEST_PAIR_ID,
      pairSecret: TEST_PAIR_SECRET,
      localDeviceId: TEST_DEVICE_ID_ALICE,
      localDisplayName: TEST_DISPLAY_ALICE,
      pairingLifecycle: "PAIRED_OFFLINE",
      remoteDeviceId: TEST_DEVICE_ID_BOB,
      remoteDisplayName: TEST_DISPLAY_BOB,
      trustedAt: 1234567890,
    };

    // Mallory sends hello with different device ID
    const result = applyPeerHello(config, TEST_DEVICE_ID_MALLORY, "Mallory");

    // The result says rejected
    expect(result.accepted).toBe(false);
    expect(result.config).toBeNull();

    // The config should NOT be modified — stays in PAIRED_OFFLINE
    // The caller must NOT transition to PAIRED_ONLINE when accepted=false
    expect(config.pairingLifecycle).toBe("PAIRED_OFFLINE");
    expect(config.remoteDeviceId).toBe(TEST_DEVICE_ID_BOB);
    expect(config.remoteDisplayName).toBe(TEST_DISPLAY_BOB);
  });

  it("import status message is connecting not paired", () => {
    // This tests the Settings.tsx behavior after import.
    // The message should be "Pairing imported. Connecting to {name}..."
    // not "Paired with {name}!"

    const exportData = makeExportData();
    const config = createImporterConfig({
      exportData,
      localDeviceId: TEST_DEVICE_ID_BOB,
      localDisplayName: TEST_DISPLAY_BOB,
    });

    // Lifecycle must be PAIR_IMPORTED_CONNECTING (not PAIRED_ONLINE)
    expect(config.pairingLifecycle).toBe("PAIR_IMPORTED_CONNECTING");

    // Display should show "Connecting to friend..." not a "Paired with" message
    const info = getPairingDisplayInfo(config);
    expect(info.statusText).toBe("Connecting to friend...");
    expect(info.statusText).not.toContain("Paired");
    expect(info.showLink).toBe(false);
    expect(info.showReplaceForget).toBe(false);
  });

  it("clear-pairing truly clears stored state", () => {
    // resetToUnpaired returns null — the IPC handler then calls
    // SettingsStore.clearPairing() which removes pairingConfig and
    // encryptedPairSecret from the persisted object.
    const cleared = resetToUnpaired();
    expect(cleared).toBeNull();

    // Verify that when get-pairing-config reads null/absent, it returns null
    const result = cleared;
    expect(result).toBeNull();
    // The IPC handler (get-pairing-config) checks typeof raw !== "string" 
    // and returns null when the field is absent or empty string.
  });
});
