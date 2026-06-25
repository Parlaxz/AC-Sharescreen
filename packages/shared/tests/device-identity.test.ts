import { describe, it, expect } from "vitest";
import {
  generateDeviceIdentity,
  updateDeviceDisplayName,
  DeviceIdentitySchema,
} from "@screenlink/shared";

describe("DeviceIdentity", () => {
  it("generateDeviceIdentity creates a valid identity", () => {
    const id = generateDeviceIdentity("  Alice  ");
    expect(id.displayName).toBe("Alice");
    expect(id.deviceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(id.createdAt).toBeGreaterThan(0);
    expect(DeviceIdentitySchema.safeParse(id).success).toBe(true);
  });

  it("trims display name whitespace", () => {
    const id = generateDeviceIdentity("   Bob   ");
    expect(id.displayName).toBe("Bob");
  });

  it("throws on empty display name after trim", () => {
    expect(() => generateDeviceIdentity("   ")).toThrow(
      "displayName must not be empty",
    );
  });

  it("throws on display name exceeding 100 chars", () => {
    const long = "a".repeat(101);
    expect(() => generateDeviceIdentity(long)).toThrow(
      "displayName must be at most 100",
    );
  });

  it("updateDeviceDisplayName returns new object with updated name", () => {
    const original = generateDeviceIdentity("Alice");
    const updated = updateDeviceDisplayName(original, "Bob");
    expect(updated.displayName).toBe("Bob");
    expect(updated.deviceId).toBe(original.deviceId);
    expect(updated.createdAt).toBe(original.createdAt);
  });

  it("updateDeviceDisplayName validates the new name", () => {
    const original = generateDeviceIdentity("Alice");
    expect(() => updateDeviceDisplayName(original, "")).toThrow(
      "displayName must not be empty",
    );
  });

  it("updateDeviceDisplayName trims whitespace", () => {
    const original = generateDeviceIdentity("Alice");
    const updated = updateDeviceDisplayName(original, "  Charlie  ");
    expect(updated.displayName).toBe("Charlie");
  });

  it("generates unique device IDs", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateDeviceIdentity("test").deviceId));
    expect(ids.size).toBe(50);
  });
});
