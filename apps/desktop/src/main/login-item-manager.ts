import { app } from "electron";

/**
 * Manages the "launch at login" system setting.
 */
export class LoginItemManager {
  /**
   * Whether the app is currently configured to launch at login.
   */
  get isEnabled(): boolean {
    return app.getLoginItemSettings().openAtLogin;
  }

  /**
   * Enable or disable launch-at-login.
   * The --hidden flag prevents the window from showing on auto-start.
   */
  setEnabled(enabled: boolean): void {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      args: ["--hidden"],
    });
  }
}
