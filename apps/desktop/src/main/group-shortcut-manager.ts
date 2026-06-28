import { globalShortcut, BrowserWindow } from "electron";
import { normalizeAccelerator } from "./shortcut-sender.js";

export type ShortcutAction = "quick-share" | "quick-join";

/**
 * Static list of Windows-reserved or unsafe shortcut combinations
 * that ScreenLink should never attempt to claim.
 *
 * This list is NOT exhaustive — Electron's globalShortcut registration
 * result is the authoritative validation. A shortcut that passes this
 * list but is rejected by Electron is reported as unavailable.
 */
/**
 * Static list of Windows-reserved or unsafe shortcut combinations,
 * stored in normalized form (modifiers sorted, Win→Super).
 */
const RESERVED_SHORTCUTS: ReadonlySet<string> = new Set([
  "Alt+Tab",
  "Alt+F4",
  "Alt+Ctrl+Delete",
  "Ctrl+Shift+Escape",
  "Super+L",
  "Super+D",
  "Super+E",
  "Super+R",
  "Super+Tab",
  "Shift+Super+S",
  "Ctrl+Escape",
]);

interface ShortcutEntry {
  groupId: string;
  action: ShortcutAction;
}

/**
 * Normalize a shortcut string to a canonical format for
 * duplicate detection and persistence.
 *
 * - Sorts modifiers alphabetically before the key
 * - Normalises "Win" → "Super" (Electron canonical)
 * - Uppercases single-letter keys
 */
export function normalizeShortcut(raw: string): string {
  const parts = raw.split("+").map((p) => p.trim());
  const key = parts.pop() ?? "";
  const mods = parts.map((m) => {
    const lower = m.toLowerCase();
    if (lower === "win") return "Super";
    if (lower === "ctrl") return "Ctrl";
    if (lower === "alt") return "Alt";
    if (lower === "shift") return "Shift";
    if (lower === "super") return "Super";
    if (lower === "meta") return "Super";
    return m;
  });
  mods.sort();
  const normalizedKey = key.length === 1 ? key.toUpperCase() : key;
  return [...mods, normalizedKey].join("+");
}

/**
 * Validate whether a shortcut can be used:
 * 1. Must have at least one modifier
 * 2. Not in the static reserved list
 * 3. Not conflicting with any other ScreenLink action
 * 4. Electron can register it
 *
 * Returns null when valid, or an error message string.
 */
export interface ShortcutValidation {
  valid: boolean;
  error?: string;
  normalized: string;
}

/**
 * GroupShortcutManager — Manages per-group global keyboard shortcuts
 * for Quick Share and Quick Join.
 *
 * Architecture:
 * - One authoritative registry mapping: normalized shortcut → { groupId, action }
 * - All operations go through register/unregister which use Electron's globalShortcut
 * - When a shortcut fires, sends an IPC event to the renderer window
 *
 * Lifecycle:
 * - Shortcuts are registered at startup from all saved group configs
 * - Changes (add/modify/clear) re-register immediately
 * - Group deletion removes its shortcut registrations
 * - Clean shutdown unregisters everything
 */
export class GroupShortcutManager {
  /**
   * Map: "groupId:action" -> { groupId, action }
   * Used to look up what to do when a shortcut fires.
   */
  private entries = new Map<string, ShortcutEntry>();

  /**
   * Map: "groupId:action" -> normalized accelerator string
   * Tracks what is currently registered with Electron.
   */
  private registeredKeys = new Map<string, string>();

  /**
   * Reverse map: normalized accelerator -> "groupId:action"
   * Used for duplicate detection across all registered shortcuts.
   */
  private acceleratorToEntry = new Map<string, string>();

  private getWindow: () => BrowserWindow | null;

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
  }

  private entryKey(groupId: string, action: ShortcutAction): string {
    return `${groupId}:${action}`;
  }

  /**
   * Get all currently registered entries for diagnostics.
   */
  getEntries(): Array<{ groupId: string; action: ShortcutAction; accelerator: string }> {
    const result: Array<{ groupId: string; action: ShortcutAction; accelerator: string }> = [];
    for (const [key, entry] of this.entries) {
      const accel = this.registeredKeys.get(key) ?? null;
      if (accel) {
        result.push({ ...entry, accelerator: accel });
      }
    }
    return result;
  }

  /**
   * Validate a shortcut without registering it.
   * Checks: modifiers present, reserved list, duplicates across existing
   * entries. Does NOT attempt Electron registration (call validateAndRegister
   * for that).
   *
   * @param shortcut - raw shortcut string (e.g. "Ctrl+Shift+S")
   * @param groupId - the group that wants this shortcut
   * @param action - quick-share or quick-join
   * @param excludeSelf - if true, exclude this exact group+action from duplicate check
   */
  validate(
    shortcut: string,
    groupId: string,
    action: ShortcutAction,
    excludeSelf?: boolean,
  ): ShortcutValidation {
    const normalized = normalizeShortcut(shortcut);

    // Must have at least one modifier
    const parts = normalized.split("+");
    const hasModifier = parts.some((p) =>
      ["Ctrl", "Alt", "Shift", "Super"].includes(p),
    );
    if (!hasModifier) {
      return { valid: false, error: "A modifier key (Ctrl, Alt, Shift, or Win) is required", normalized };
    }

    // Reserved key check — compare against the normalized reserved list
    if (RESERVED_SHORTCUTS.has(normalized)) {
      const displayForm = normalized.replace(/\bSuper\b/g, "Win");
      return { valid: false, error: `"${displayForm}" is reserved by Windows and cannot be used`, normalized };
    }

    // Duplicate check across all currently registered entries
    const skipKey = excludeSelf ? this.entryKey(groupId, action) : null;
    for (const [existingKey, existingAccel] of this.registeredKeys) {
      if (skipKey === existingKey) continue;
      if (existingAccel === normalized) {
        const displayForm_ = normalized.replace(/\bSuper\b/g, "Win");
        const entry = this.entries.get(existingKey);
        const groupLabel = entry ? `group ${entry.groupId.slice(0, 8)}` : "another action";
        return {
          valid: false,
          error: `"${displayForm_}" is already assigned to ${groupLabel}`,
          normalized,
        };
      }
    }

    return { valid: true, normalized };
  }

  /**
   * Register a shortcut for a group action.
   * 1. Unregisters any previous shortcut for this exact group+action
   * 2. Normalizes, validates, checks for duplicate/reserved
   * 3. Attempts Electron globalShortcut registration
   * 4. If registration succeeds, saves the new entry
   * 5. If registration fails, restores the previous shortcut if any
   *
   * @returns { success: true } or { success: false, error: string }
   */
  register(
    groupId: string,
    action: ShortcutAction,
    rawShortcut: string | null,
  ): { success: boolean; error?: string } {
    const key = this.entryKey(groupId, action);

    // Unregister previous shortcut for this group+action
    this.unregister(groupId, action);

    // Clearing the shortcut
    if (!rawShortcut) {
      this.entries.delete(key);
      this.registeredKeys.delete(key);
      // Clean up reverse map for any stale entry
      for (const [accel, entryKey] of this.acceleratorToEntry) {
        if (entryKey === key) {
          this.acceleratorToEntry.delete(accel);
          break;
        }
      }
      return { success: true };
    }

    const normalized = normalizeShortcut(rawShortcut);

    // Validate syntax and reserved/duplicate
    const validation = this.validate(rawShortcut, groupId, action, true);
    if (!validation.valid) {
      return { success: false, error: validation.error! };
    }

    // Attempt Electron registration
    const accelerator = normalizeAccelerator(normalized);
    const ok = globalShortcut.register(accelerator, () => {
      const win = this.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send("group-shortcut:execute", { groupId, action });
      }
    });

    if (!ok) {
      const alreadyRegistered = globalShortcut.isRegistered(accelerator);
      const msg = alreadyRegistered
        ? `"${normalized.replace(/\bSuper\b/g, "Win")}" is already registered by another application`
        : `Failed to register "${normalized.replace(/\bSuper\b/g, "Win")}"`;
      return { success: false, error: msg };
    }

    // Save the entry
    this.entries.set(key, { groupId, action });
    this.registeredKeys.set(key, normalized);
    this.acceleratorToEntry.set(normalized, key);

    return { success: true };
  }

  /**
   * Unregister a specific group+action shortcut.
   */
  unregister(groupId: string, action: ShortcutAction): void {
    const key = this.entryKey(groupId, action);
    const oldAccel = this.registeredKeys.get(key);
    if (oldAccel) {
      const electronAccel = normalizeAccelerator(oldAccel);
      globalShortcut.unregister(electronAccel);
      this.registeredKeys.delete(key);
      this.acceleratorToEntry.delete(oldAccel);
    }
    this.entries.delete(key);
  }

  /**
   * Unregister all shortcuts. Call on app shutdown.
   */
  unregisterAll(): void {
    for (const [, accel] of this.registeredKeys) {
      const electronAccel = normalizeAccelerator(accel);
      globalShortcut.unregister(electronAccel);
    }
    this.registeredKeys.clear();
    this.entries.clear();
    this.acceleratorToEntry.clear();
  }

  /**
   * Full lifecycle cleanup. Call on app shutdown.
   */
  destroy(): void {
    this.unregisterAll();
  }
}
