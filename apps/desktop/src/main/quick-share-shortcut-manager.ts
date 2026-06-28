import { globalShortcut, BrowserWindow } from "electron";
import { normalizeAccelerator } from "./shortcut-sender.js";

/**
 * QuickShareShortcutManager — Dedicated global shortcut for Quick Share.
 *
 * Behavior:
 * - Registers after app ready with accelerator + enabled state from settings
 * - Skips registration in multi-instance/dev-profile unless SCREENLINK_ENABLE_GLOBAL_SHORTCUT=1
 * - Unregisters on shutdown
 * - Reports nonfatal conflicts via console.warn
 * - Emits `quick-share:open` event to the renderer when triggered
 * - Shows/restores/focuses existing window (no second BrowserWindow)
 *
 * Registration ownership:
 * - `configuredAccelerator` is the value the manager has been told to
 *   use. It is updated synchronously by `updateConfig`.
 * - `registeredAccelerator` is the value that is currently registered
 *   with the OS. It is null when nothing is registered.
 * - `registered` is a convenience boolean.
 *
 * On update from accelerator A to B:
 *   - First unregister the exact previously registered accelerator (A).
 *   - Then register the new accelerator (B).
 * On disable: unregister the currently registered accelerator.
 * On failed registration: leave no stale internal registered state.
 * On destroy: unregister the exact active accelerator.
 */
export class QuickShareShortcutManager {
  private configuredAccelerator: string = "Super+Alt+S";
  private enabled = false;
  private registeredAccelerator: string | null = null;

  constructor(
    private getWindow: () => BrowserWindow | null,
    settings: {
      getQuickShareEnabled: () => boolean;
      getQuickShareAccelerator: () => string;
    },
  ) {
    this.configuredAccelerator = settings.getQuickShareAccelerator();
    this.enabled = settings.getQuickShareEnabled();
  }

  /**
   * Register the global shortcut if conditions are met.
   * Returns a status string for diagnostics.
   */
  register(): { success: boolean; error?: string } {
    // Always unregister any previously registered accelerator first so
    // a stale registration is never leaked.
    this.unregister();

    // Skip registration in multi-instance/dev-profile unless env var is set
    const isMultiInstance = process.argv.includes("--multi-instance");
    const hasDevProfile = process.argv.some((a) => a.startsWith("--dev-profile="));
    const envOverride = process.env.SCREENLINK_ENABLE_GLOBAL_SHORTCUT === "1";
    if ((isMultiInstance || hasDevProfile) && !envOverride) {
      return {
        success: false,
        error: "Skipped: multi-instance/dev-profile without SCREENLINK_ENABLE_GLOBAL_SHORTCUT=1",
      };
    }

    if (!this.enabled) {
      return { success: false, error: "Quick share shortcut is disabled in settings" };
    }

    const accel = normalizeAccelerator(this.configuredAccelerator);
    const ok = globalShortcut.register(accel, () => {
      const win = this.getWindow();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        win.webContents.send("quick-share:open");
      }
    });

    if (!ok) {
      const isRegistered = globalShortcut.isRegistered(accel);
      const msg = isRegistered
        ? `Shortcut "${accel}" is already registered by another application`
        : `Failed to register shortcut "${accel}"`;
      console.warn(`[QuickShareShortcutManager] ${msg}`);
      // Failed registration — clear any stale internal state.
      this.registeredAccelerator = null;
      return { success: false, error: msg };
    }

    this.registeredAccelerator = accel;
    return { success: true };
  }

  /**
   * Update the shortcut configuration and re-register.
   * The exact previously registered accelerator (if any) is
   * unregistered before the new one is registered.
   */
  updateConfig(enabled: boolean, accelerator: string): { success: boolean; error?: string } {
    this.enabled = enabled;
    this.configuredAccelerator = accelerator;
    return this.register();
  }

  /**
   * Unregister the global shortcut using the exact value that was
   * registered. This is the only place globalShortcut.unregister is
   * called, ensuring we always pass the precise string we previously
   * handed to globalShortcut.register.
   */
  unregister(): void {
    if (this.registeredAccelerator !== null) {
      globalShortcut.unregister(this.registeredAccelerator);
      this.registeredAccelerator = null;
    }
  }

  /**
   * Get current registration state for diagnostics.
   */
  getStatus(): {
    registered: boolean;
    accelerator: string;
    enabled: boolean;
    registeredAccelerator: string | null;
  } {
    return {
      registered: this.registeredAccelerator !== null,
      accelerator: this.configuredAccelerator,
      enabled: this.enabled,
      registeredAccelerator: this.registeredAccelerator,
    };
  }

  /**
   * Clean up on shutdown. Unregisters the exact active accelerator.
   */
  destroy(): void {
    this.unregister();
  }
}
