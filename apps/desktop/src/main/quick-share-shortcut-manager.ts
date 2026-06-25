import { globalShortcut, BrowserWindow } from "electron";

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
 */
export class QuickShareShortcutManager {
  private registered = false;
  private accelerator: string = "Super+Alt+S";
  private enabled = false;

  constructor(
    private getWindow: () => BrowserWindow | null,
    settings: {
      getQuickShareEnabled: () => boolean;
      getQuickShareAccelerator: () => string;
    },
  ) {
    // Read initial config from settings
    this.accelerator = settings.getQuickShareAccelerator();
    this.enabled = settings.getQuickShareEnabled();
  }

  /**
   * Register the global shortcut if conditions are met.
   * Returns a status string for diagnostics.
   */
  register(): { success: boolean; error?: string } {
    if (this.registered) {
      this.unregister();
    }

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

    const accel = this.accelerator;
    const ok = globalShortcut.register(accel, () => {
      // Show/restore/focus existing window
      const win = this.getWindow();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        // Send the quick-share:open event to the renderer
        win.webContents.send("quick-share:open");
      }
    });

    if (!ok) {
      // Check for conflicts
      const isRegistered = globalShortcut.isRegistered(accel);
      const msg = isRegistered
        ? `Shortcut "${accel}" is already registered by another application`
        : `Failed to register shortcut "${accel}"`;
      console.warn(`[QuickShareShortcutManager] ${msg}`);
      this.registered = false;
      return { success: false, error: msg };
    }

    this.registered = true;
    return { success: true };
  }

  /**
   * Update the shortcut configuration and re-register.
   */
  updateConfig(enabled: boolean, accelerator: string): { success: boolean; error?: string } {
    this.enabled = enabled;
    this.accelerator = accelerator;
    return this.register();
  }

  /**
   * Unregister the global shortcut.
   */
  unregister(): void {
    if (this.registered) {
      globalShortcut.unregister(this.accelerator);
      this.registered = false;
    }
  }

  /**
   * Get current registration state for diagnostics.
   */
  getStatus(): { registered: boolean; accelerator: string; enabled: boolean } {
    return {
      registered: this.registered,
      accelerator: this.accelerator,
      enabled: this.enabled,
    };
  }

  /**
   * Clean up on shutdown.
   */
  destroy(): void {
    this.unregister();
  }
}
