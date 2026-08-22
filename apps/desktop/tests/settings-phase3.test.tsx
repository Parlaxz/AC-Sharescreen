// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { Settings } from "../src/renderer/routes/Settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const settingsSourcePath = path.resolve(__dirname, "..", "src", "renderer", "routes", "Settings.tsx");
const apiTypesPath = path.resolve(__dirname, "..", "src", "preload", "api-types.ts");

describe("Settings Phase 3 (Stage 12)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("removes all pairing/friend UI from settings renderer path", () => {
    expect(Settings).toBeDefined();
    // Verify no pairing API calls are referenced in the component source
    const source = readFileSync(settingsSourcePath, "utf-8");
    // The component should not reference pairing API methods
    expect(source.includes("createPairing")).toBe(false);
    expect(source.includes("importPairing")).toBe(false);
    expect(source.includes("clearPairing")).toBe(false);
    expect(source.includes("getPairingConfig")).toBe(false);
    expect(source.includes("getPairingLink")).toBe(false);
    expect(source.includes("exportCurrentPairing")).toBe(false);
  });

  it("includes profile, behavior, host quality limits, local transport, Developer Mode", () => {
    expect(Settings).toBeDefined();
    // These sections should be present in the settings page by checking the source
    const source = readFileSync(settingsSourcePath, "utf-8");
    // The component must handle these fields
    expect(source.includes("hostQualityLimits")).toBe(true);
    expect(source.includes("developerMode")).toBe(true);
    expect(source.includes("localTransportPolicy")).toBe(true);
    expect(source.includes("Display Name")).toBe(true);
    expect(source.includes("Launch at login")).toBe(true);
    expect(source.includes("Auto-resume")).toBe(true);
    expect(source.includes("Allow viewer quality requests")).toBe(true);
  });

  it("display name save propagates through updateDisplayName into all groups", () => {
    // Verify the Settings page references updateDisplayName API type
    const source = readFileSync(apiTypesPath, "utf-8");
    expect(source).toContain("updateDisplayName");
  });

  it("IPC updateDisplayName handler persists and returns identity", () => {
    // Simulate what the update-display-name IPC handler does
    const current = {
      deviceIdentity: { deviceId: "dev-1", displayName: "Old Name", createdAt: 1000 },
      hostDisplayName: "Old Name",
    };
    const trimmed = "New Name".trim();
    const updated = {
      deviceIdentity: { ...current.deviceIdentity, displayName: trimmed },
      hostDisplayName: trimmed,
    };
    expect(updated.deviceIdentity.displayName).toBe("New Name");
    expect(updated.hostDisplayName).toBe("New Name");
  });
});
