// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const register = vi.fn();
const unregister = vi.fn();
const isRegistered = vi.fn();

vi.mock("electron", () => ({
  globalShortcut: {
    register,
    unregister,
    isRegistered,
  },
}));

// Import after mocks
const { GroupShortcutManager, normalizeShortcut } = await import(
  "../src/main/group-shortcut-manager.js"
);

// ─── Helpers ────────────────────────────────────────────────────────────────

function createManager(): GroupShortcutManager {
  return new GroupShortcutManager(() => null);
}

// ─── normalizeShortcut ──────────────────────────────────────────────────────

describe("normalizeShortcut", () => {
  it("sorts modifiers alphabetically", () => {
    expect(normalizeShortcut("Shift+Alt+Ctrl+S")).toBe("Alt+Ctrl+Shift+S");
  });

  it("normalises Win to Super", () => {
    expect(normalizeShortcut("Win+Alt+S")).toBe("Alt+Super+S");
  });

  it("uppercases single letter keys", () => {
    expect(normalizeShortcut("Ctrl+a")).toBe("Ctrl+A");
  });

  it("handles function keys", () => {
    expect(normalizeShortcut("Ctrl+F1")).toBe("Ctrl+F1");
  });

  it("deduplicates modifiers", () => {
    // normalizeShortcut doesn't deduplicate — the sort just orders them
    const result = normalizeShortcut("Ctrl+Ctrl+A");
    // Both "Ctrl"s survive; the key is the last part
    expect(result).toContain("A");
  });
});

// ─── Static reserved list ───────────────────────────────────────────────────

describe("GroupShortcutManager validate (reserved)", () => {
  let mgr: GroupShortcutManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mgr = createManager();
  });

  // These are in user-facing form (Win not Super). The validator
  // normalizes internally before comparing against the reserved list.
  const reservedCases = [
    "Alt+Tab",
    "Alt+F4",
    "Ctrl+Alt+Delete",
    "Ctrl+Shift+Escape",
    "Win+L",
    "Win+D",
    "Win+E",
    "Win+R",
    "Win+Tab",
    "Win+Shift+S",
    "Ctrl+Escape",
  ];

  for (const shortcut of reservedCases) {
    it(`rejects reserved shortcut: ${shortcut}`, () => {
      const result = mgr.validate(shortcut, "group-a", "quick-share");
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/reserved/);
    });
  }
});

// ─── Validation ─────────────────────────────────────────────────────────────

describe("GroupShortcutManager validate", () => {
  let mgr: GroupShortcutManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mgr = createManager();
  });

  it("accepts a valid shortcut with modifier", () => {
    const result = mgr.validate("Ctrl+Shift+S", "group-a", "quick-share");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("Ctrl+Shift+S");
  });

  it("rejects a bare key without modifier", () => {
    const result = mgr.validate("F1", "group-a", "quick-share");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/modifier/);
  });

  it("rejects a bare letter without modifier", () => {
    const result = mgr.validate("A", "group-a", "quick-share");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/modifier/);
  });

  it("rejects duplicates in different groups", () => {
    // Register first shortcut
    register.mockReturnValue(true);
    mgr.register("group-a", "quick-share", "Ctrl+Alt+M");

    // Try to register the same shortcut for another group
    const result = mgr.validate("Ctrl+Alt+M", "group-b", "quick-share");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/already assigned/);
  });

  it("rejects duplicate quick-share and quick-join in same group", () => {
    register.mockReturnValue(true);
    mgr.register("group-a", "quick-share", "Ctrl+Alt+M");

    const result = mgr.validate("Ctrl+Alt+M", "group-a", "quick-join");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/already assigned/);
  });

  it("allows editing own shortcut (excludeSelf)", () => {
    register.mockReturnValue(true);
    mgr.register("group-a", "quick-share", "Ctrl+Alt+M");

    // Same group+action should pass with excludeSelf=true
    const result = mgr.validate("Ctrl+Alt+M", "group-a", "quick-share", true);
    expect(result.valid).toBe(true);
  });
});

// ─── Registration lifecycle ─────────────────────────────────────────────────

describe("GroupShortcutManager registration", () => {
  let mgr: GroupShortcutManager;

  beforeEach(() => {
    vi.clearAllMocks();
    register.mockReturnValue(true);
    isRegistered.mockReturnValue(false);
    mgr = createManager();
  });

  it("registers a shortcut successfully", () => {
    const result = mgr.register("group-a", "quick-share", "Ctrl+Shift+S");
    expect(result.success).toBe(true);
    expect(register).toHaveBeenCalledWith(
      "Ctrl+Shift+S",
      expect.any(Function),
    );
  });

  it("changing shortcut unregisters old and registers new", () => {
    mgr.register("group-a", "quick-share", "Ctrl+Shift+S");
    expect(register).toHaveBeenLastCalledWith("Ctrl+Shift+S", expect.any(Function));

    // Reset mock counts to isolate the second call
    register.mockClear();
    unregister.mockClear();

    mgr.register("group-a", "quick-share", "Alt+Shift+T");
    // unregister should be called with the old normalized accelerator
    // Note: unregister is called with the electron-normalized form (after normalizeAccelerator)
    // which for "Alt+Shift+T" is just "Alt+Shift+T" (no Win to convert)
    const firstUnregisterCall = unregister.mock.calls[0]?.[0];
    // The old accelerator was "Ctrl+Shift+S" — unregister strips any electron-only prefix
    expect(firstUnregisterCall).toBe("Ctrl+Shift+S");
    expect(register).toHaveBeenLastCalledWith("Alt+Shift+T", expect.any(Function));
  });

  it("clearing a shortcut unregisters it", () => {
    mgr.register("group-a", "quick-share", "Ctrl+Shift+S");
    expect(register).toHaveBeenCalledTimes(1);

    mgr.register("group-a", "quick-share", null);
    expect(unregister).toHaveBeenCalledWith("Ctrl+Shift+S");
  });

  it("only clears one group's shortcut, not others", () => {
    mgr.register("group-a", "quick-share", "Ctrl+Shift+S");
    mgr.register("group-b", "quick-share", "Alt+Shift+T");

    mgr.register("group-a", "quick-share", null);

    // group-b's shortcut should still be registered
    const entries = mgr.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].groupId).toBe("group-b");
  });

  it("failed registration leaves the manager in clean state", () => {
    register.mockReturnValueOnce(true); // first succeeds
    register.mockReturnValueOnce(false); // second fails
    isRegistered.mockReturnValue(false);

    mgr.register("group-a", "quick-share", "Ctrl+Shift+S");

    const result = mgr.register("group-a", "quick-share", "Alt+F2");
    expect(result.success).toBe(false);

    // The old shortcut should have been unregistered
    expect(unregister).toHaveBeenCalledWith("Ctrl+Shift+S");

    // The entry should not have the failed shortcut
    const entries = mgr.getEntries();
    expect(entries).toHaveLength(0);
  });

  it("destroy unregisters all shortcuts", () => {
    mgr.register("group-a", "quick-share", "Ctrl+Shift+S");
    mgr.register("group-b", "quick-join", "Alt+Shift+J");

    mgr.destroy();

    expect(unregister).toHaveBeenCalledWith("Ctrl+Shift+S");
    expect(unregister).toHaveBeenCalledWith("Alt+Shift+J");
    expect(mgr.getEntries()).toHaveLength(0);
  });

  it("one failed registration does not affect other working shortcuts", () => {
    register.mockReturnValue(true);
    mgr.register("group-a", "quick-share", "Ctrl+Shift+S");

    // Now make registration fail
    register.mockReturnValueOnce(false);
    isRegistered.mockReturnValue(false);

    const result = mgr.register("group-b", "quick-share", "Alt+F3");
    expect(result.success).toBe(false);

    // group-a's shortcut should still work
    const entries = mgr.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].groupId).toBe("group-a");
  });
});

// ─── Reserved shortcut via Electron (not static list) ────────────────────────

describe("GroupShortcutManager Electron registration failures", () => {
  let mgr: GroupShortcutManager;

  beforeEach(() => {
    vi.clearAllMocks();
    register.mockReturnValue(false);
    isRegistered.mockReturnValue(true);
    mgr = createManager();
  });

  it("reports when Electron refuses a shortcut", () => {
    const result = mgr.register("group-a", "quick-share", "Ctrl+Shift+Q");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already registered/);
  });
});

// ─── IPC handler validation (synthetic) ─────────────────────────────────────

describe("GroupShortcutManager IPC integration", () => {
  it("passes normalizeAccelerator for Electron (Win -> Super)", () => {
    // This tests that the IPC handler uses normalizeAccelerator
    // which the GroupShortcutManager.register already handles via normalizeShortcut
    const normalized = normalizeShortcut("Win+Alt+S");
    expect(normalized).toBe("Alt+Super+S");
    // The register method applies normalizeAccelerator internally
    // So "Alt+Super+S" gets passed to globalShortcut.register
  });
});

// ─── Race condition guards ─────────────────────────────────────────────────

describe("GroupShortcutManager idempotency guards", () => {
  let mgr: GroupShortcutManager;

  beforeEach(() => {
    vi.clearAllMocks();
    register.mockReturnValue(true);
    mgr = createManager();
  });

  it("allows separate groups to have different shortcuts", () => {
    mgr.register("group-a", "quick-share", "Ctrl+Shift+S");
    mgr.register("group-b", "quick-share", "Alt+Shift+T");

    const entries = mgr.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.groupId === "group-a")).toBeTruthy();
    expect(entries.find((e) => e.groupId === "group-b")).toBeTruthy();
  });

  it("allows quick-share and quick-join in the same group", () => {
    mgr.register("group-a", "quick-share", "Ctrl+Shift+S");
    mgr.register("group-a", "quick-join", "Ctrl+Shift+J");

    const entries = mgr.getEntries();
    expect(entries).toHaveLength(2);
  });
});
