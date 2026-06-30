import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  loadImageEnhancementSettings,
  saveImageEnhancementSettings,
  loadImageEnhancementSettingsB,
  saveImageEnhancementSettingsB,
  resetImageEnhancementSettingsB,
  type ViewerImageEnhancementSettings,
} from "../src/renderer/services/viewer-image-processing/viewer-image-settings.js";
import { VIEWER_IMAGE_ENHANCEMENT_DEFAULTS } from "../src/renderer/services/viewer-image-processing/viewer-image-defaults.js";

const KEY_A = "screenlink:viewer-image-enhancement";
const KEY_B = "screenlink:viewer-image-enhancement-b";

// Mock localStorage for node test environment
const store: Record<string, string> = {};
const mockLocalStorage = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
  removeItem: vi.fn((key: string) => { delete store[key]; }),
  clear: vi.fn(() => { for (const k of Object.keys(store)) delete store[k]; }),
  get length() { return Object.keys(store).length; },
  key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
};
Object.defineProperty(globalThis, "localStorage", { value: mockLocalStorage, writable: true, configurable: true });

describe("ViewerImageEnhancementSettings — compare B persistence", () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
  });

  afterEach(() => {
    for (const k of Object.keys(store)) delete store[k];
  });

  it("loadImageEnhancementSettingsB returns settings A on first use (no B key)", () => {
    // Set A to a known non-default value
    const customA: ViewerImageEnhancementSettings = {
      ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
      sharpeningStrength: 0.75,
      enabled: true,
    };
    saveImageEnhancementSettings(customA);

    const b = loadImageEnhancementSettingsB();
    expect(b.sharpeningStrength).toBe(0.75);
    expect(b.enabled).toBe(true);
    expect(b.processingBackend).toBe(customA.processingBackend);
  });

  it("loadImageEnhancementSettingsB returns persisted B when key exists", () => {
    const customA: ViewerImageEnhancementSettings = {
      ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
      sharpeningStrength: 0.75,
    };
    saveImageEnhancementSettings(customA);

    // Save a different B
    const customB: ViewerImageEnhancementSettings = {
      ...customA,
      sharpeningStrength: 0.25,
      noiseProtection: 0.9,
    };
    saveImageEnhancementSettingsB(customB);

    const loaded = loadImageEnhancementSettingsB();
    expect(loaded.sharpeningStrength).toBe(0.25);
    expect(loaded.noiseProtection).toBe(0.9);
  });

  it("saveImageEnhancementSettingsB persists to separate key", () => {
    const a: ViewerImageEnhancementSettings = {
      ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
      sharpeningStrength: 1,
    };
    const b: ViewerImageEnhancementSettings = {
      ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
      sharpeningStrength: 0,
      nvidiaMode: "denoise",
    };

    saveImageEnhancementSettings(a);
    saveImageEnhancementSettingsB(b);

    // A is untouched
    expect(loadImageEnhancementSettings().sharpeningStrength).toBe(1);
    // B is independent
    expect(loadImageEnhancementSettingsB().sharpeningStrength).toBe(0);
    expect(loadImageEnhancementSettingsB().nvidiaMode).toBe("denoise");
  });

  it("resetImageEnhancementSettingsB returns a copy of settings A without persisting", () => {
    const customA: ViewerImageEnhancementSettings = {
      ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
      sharpeningStrength: 0.5,
    };
    saveImageEnhancementSettings(customA);

    const b = resetImageEnhancementSettingsB();
    expect(b.sharpeningStrength).toBe(0.5);

    // Should NOT have persisted
    expect(localStorage.getItem(KEY_B)).toBeNull();
  });

  it("A and B are fully independent objects (no shared reference)", () => {
    const a: ViewerImageEnhancementSettings = {
      ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
    };
    saveImageEnhancementSettings(a);

    const b = loadImageEnhancementSettingsB();
    b.sharpeningStrength = 0.99;
    // Should not affect A
    expect(loadImageEnhancementSettings().sharpeningStrength).not.toBe(0.99);
  });

  it("B settings survive a round-trip (save then load)", () => {
    const b: ViewerImageEnhancementSettings = {
      ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
      processingBackend: "nvidia-vsr",
      nvidiaMode: "vsr",
      nvidiaQuality: "ultra",
      sharpeningStrength: 0.8,
      noiseProtection: 0.3,
      compressionCleanup: 0.5,
      debanding: 0.2,
    };
    saveImageEnhancementSettingsB(b);

    const loaded = loadImageEnhancementSettingsB();
    expect(loaded.processingBackend).toBe("nvidia-vsr");
    expect(loaded.nvidiaMode).toBe("vsr");
    expect(loaded.nvidiaQuality).toBe("ultra");
    expect(loaded.sharpeningStrength).toBe(0.8);
    expect(loaded.noiseProtection).toBe(0.3);
    expect(loaded.compressionCleanup).toBe(0.5);
    expect(loaded.debanding).toBe(0.2);
  });

  it("A and B use different localStorage keys", () => {
    saveImageEnhancementSettings({ ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS, enabled: true });
    saveImageEnhancementSettingsB({ ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS, enabled: false });

    expect(localStorage.getItem(KEY_A)).toBeTruthy();
    expect(localStorage.getItem(KEY_B)).toBeTruthy();
    expect(localStorage.getItem(KEY_A)).not.toBe(localStorage.getItem(KEY_B));
  });
});
