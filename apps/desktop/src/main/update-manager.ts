/**
 * update-manager.ts
 *
 * Owns all electron-updater configuration, event subscriptions, state,
 * and automatic-check timers. Broadcasts state changes to the renderer.
 *
 * The manager is independently unit-testable through dependency injection
 * of the updater adapter and logger adapter.
 */

import { app } from "electron";
import { compareVersions } from "./version-compare.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export type UpdatePhase =
  | "unsupported"
  | "idle"
  | "checking"
  | "up-to-date"
  | "update-available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  downloadedVersion?: string;
  checkStartedAt?: number;
  lastCheckedAt?: number;
  downloadPercent?: number;
  transferredBytes?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  userMessage: string;
  errorCode?: string;
  errorMessage?: string;
  isPackaged: boolean;
  isPortable: boolean;
  updaterSupported: boolean;
}

export type ErrorCode =
  | "network-unavailable"
  | "invalid-update-metadata"
  | "missing-release-artifact"
  | "checksum-failure"
  | "download-failure"
  | "updater-unsupported"
  | "unknown-updater-failure";

// ─── Adapter interfaces (for DI / testing) ────────────────────────────────

export interface UpdaterAdapter {
  on(event: string, callback: (...args: any[]) => void): void;
  removeAllListeners(event?: string): void;
  checkForUpdates(): Promise<any>;
  downloadUpdate(): Promise<any>;
  quitAndInstall(): void;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  disableDifferentialDownload: boolean;
  currentVersion: { version: string };
  channel: string | null;
  previousBlockmapBaseUrlOverride: string | null;
  logger: any;
  setFeedURL(options: Record<string, any>): void;
}

export interface LoggerAdapter {
  log(level: "debug" | "info" | "warn" | "error", component: string, event: string, details?: Record<string, unknown>): void;
}

export type PrepareForQuitCallback = () => void;
export type StatusBroadcastCallback = (status: UpdateStatus) => void;

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatUserMessage(phase: UpdatePhase, availableVersion?: string, errorMessage?: string): string {
  switch (phase) {
    case "unsupported":
      return "";
    case "idle":
      return "No update check performed yet.";
    case "checking":
      return "Checking for updates...";
    case "up-to-date":
      return "ScreenLink is up to date.";
    case "update-available":
      return `ScreenLink ${availableVersion ?? ""} is available.`.trim();
    case "downloading":
      return "Downloading update...";
    case "downloaded":
      return "Update ready to install.";
    case "installing":
      return "Restarting to install update...";
    case "error":
      return errorMessage ?? "An update error occurred.";
  }
}

function getErrorCode(err: unknown): { code: ErrorCode; safeMessage: string } {
  const msg = String(err);

  if (!err) {
    return { code: "unknown-updater-failure", safeMessage: "Unknown update error." };
  }

  if (msg.includes("net::ERR_INTERNET_DISCONNECTED") ||
      msg.includes("net::ERR_CONNECTION") ||
      msg.includes("net::ERR_NAME_NOT_RESOLVED") ||
      msg.includes("net::ERR_TIMEOUT") ||
      msg.includes("getaddrinfo") ||
      msg.includes("ENOTFOUND") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("ECONNRESET")) {
    return { code: "network-unavailable", safeMessage: "Unable to connect to the update server. Please check your internet connection." };
  }

  if (msg.includes("No valid updates") || msg.includes("update metadata") || msg.includes("is not yet available")) {
    return { code: "invalid-update-metadata", safeMessage: "No update information available at this time." };
  }

  if (msg.includes("blockmap") || msg.includes("checksum") || msg.includes("integrity")) {
    return { code: "checksum-failure", safeMessage: "Update verification failed. Please try again." };
  }

  if (msg.includes("download") || msg.includes("404") || msg.includes("not found")) {
    return { code: "missing-release-artifact", safeMessage: "Update artifact could not be found. The release may still be processing." };
  }

  return { code: "unknown-updater-failure", safeMessage: "An unexpected update error occurred. Please try again later." };
}

// ─── UpdateManager ─────────────────────────────────────────────────────────

export class UpdateManager {
  private state: UpdateStatus;
  private isDestroyed = false;
  private isDownloading = false;
  private isInstalling = false;
  /** Indicates whether a check is currently in flight (prevents duplicate clicks). */
  private checkInFlight = false;

  constructor(
    private updater: UpdaterAdapter,
    private broadcast: StatusBroadcastCallback,
    private logger: LoggerAdapter,
    private prepareForQuit: PrepareForQuitCallback,
  ) {
    const isPackaged = app.isPackaged;
    const isPortable = this.detectPortable();
    const updaterSupported = isPackaged && !isPortable && process.platform === "win32";

    this.state = this.createInitialState(isPackaged, isPortable, updaterSupported);
    this.bindEvents();
  }

  getStatus(): UpdateStatus {
    return { ...this.state };
  }

  /**
   * Initialize the updater: configure electron-updater and bind the
   * event listeners. NO automatic check is performed. NO timer is
   * scheduled. The only normal path that calls `updater.checkForUpdates()`
   * is the user clicking "Check for updates" in User Settings.
   */
  init(): void {
    if (this.isDestroyed) return;
    if (!this.state.updaterSupported) {
      this.logger.log("info", "updater", "updater_unsupported", {
        isPackaged: this.state.isPackaged,
        isPortable: this.state.isPortable,
      });
      return;
    }

    this.logger.log("info", "updater", "updater_initialized", {
      version: this.state.currentVersion,
      isPackaged: this.state.isPackaged,
      isPortable: this.state.isPortable,
    });

    // Set previous blockmap base URL dynamically from current version
    const currentVersion = this.state.currentVersion;
    this.updater.previousBlockmapBaseUrlOverride =
      `https://github.com/Parlaxz/AC-Sharescreen/releases/download/v${currentVersion}`;
    this.logger.log("info", "updater", "blockmap_base_url", {
      url: this.updater.previousBlockmapBaseUrlOverride,
    });
  }

  /**
   * Manually check for an update. Returns the current status.
   *
   * Only the user's explicit "Check for updates" click in Settings
   * should call this. Duplicate clicks while a check is in flight are
   * blocked. The method does NOT schedule any follow-up checks.
   */
  async checkForUpdates(): Promise<UpdateStatus> {
    if (this.isDestroyed) return this.getStatus();

    if (!this.state.updaterSupported) {
      return this.getStatus();
    }

    if (this.checkInFlight) {
      this.logger.log("info", "updater", "check_skipped", {
        reason: "check already in flight",
      });
      return this.getStatus();
    }

    if (this.state.phase === "downloading" || this.state.phase === "installing") {
      this.logger.log("info", "updater", "check_skipped", {
        reason: `phase is ${this.state.phase}`,
      });
      return this.getStatus();
    }

    // Don't let background errors disrupt a useful existing state
    if (this.state.phase === "update-available" || this.state.phase === "downloaded") {
      return this.getStatus();
    }

    this.checkInFlight = true;
    this.setState({
      phase: "checking",
      checkStartedAt: Date.now(),
      errorCode: undefined,
      errorMessage: undefined,
    });

    try {
      this.logger.log("info", "updater", "check_started", { manual: true });
      await this.updater.checkForUpdates();
      // Note: events from electron-updater will handle state transitions.
      return this.getStatus();
    } catch (err: unknown) {
      const { code, safeMessage } = getErrorCode(err);
      this.logger.log("error", "updater", "check_failed", {
        errorCode: code,
        errorDetail: String(err),
      });
      this.setState({
        phase: "error",
        errorCode: code,
        errorMessage: this.state.phase === "error" && this.state.errorMessage
          ? this.state.errorMessage
          : safeMessage,
      });
      return this.getStatus();
    } finally {
      this.checkInFlight = false;
    }
  }

  /**
   * Download the available update. Returns the current status.
   * Only allowed when phase is update-available.
   */
  async downloadUpdate(): Promise<UpdateStatus> {
    if (this.isDestroyed) return this.getStatus();

    if (this.state.phase !== "update-available") {
      this.logger.log("info", "updater", "download_skipped", {
        reason: `phase must be update-available, got ${this.state.phase}`,
      });
      return this.getStatus();
    }

    if (this.isDownloading) {
      return this.getStatus();
    }

    this.isDownloading = true;

    try {
      this.logger.log("info", "updater", "download_started", {
        version: this.state.availableVersion,
      });
      await this.updater.downloadUpdate();
      return this.getStatus();
    } catch (err: unknown) {
      const { code, safeMessage } = getErrorCode(err);
      this.logger.log("error", "updater", "download_failed", {
        errorCode: code,
        errorDetail: String(err),
      });
      this.setState({
        phase: "error",
        errorCode: code,
        errorMessage: safeMessage,
      });
      return this.getStatus();
    } finally {
      this.isDownloading = false;
    }
  }

  /**
   * Install the downloaded update. Only allowed when phase is downloaded.
   * Triggers the prepare-for-quit callback, then calls quitAndInstall.
   */
  restartAndInstallUpdate(): void {
    if (this.isDestroyed) return;

    if (this.state.phase !== "downloaded") {
      this.logger.log("info", "updater", "install_skipped", {
        reason: `phase must be downloaded, got ${this.state.phase}`,
      });
      return;
    }

    if (this.isInstalling) {
      return;
    }

    this.isInstalling = true;
    this.setState({ phase: "installing" });

    this.logger.log("info", "updater", "install_started", {
      version: this.state.downloadedVersion,
    });

    try {
      this.prepareForQuit();
      this.updater.quitAndInstall();
    } catch (err: unknown) {
      this.logger.log("error", "updater", "install_failed", {
        errorDetail: String(err),
      });
      this.isInstalling = false;
      this.setState({
        phase: "downloaded",
        errorMessage: "Installation failed. Please try again.",
      });
    }
  }

  /**
   * Clean up timers and event listeners. Call on app shutdown.
   */
  destroy(): void {
    this.isDestroyed = true;
    this.updater.removeAllListeners();
    this.logger.log("info", "updater", "updater_destroyed", {});
  }

  // ─── Private ───────────────────────────────────────────────────────────

  private createInitialState(isPackaged: boolean, isPortable: boolean, updaterSupported: boolean): UpdateStatus {
    if (!updaterSupported) {
      let userMessage: string;
      if (!isPackaged) {
        userMessage = "Update checks are only available in an installed packaged build.";
      } else if (isPortable) {
        userMessage = "The portable version cannot update itself. Install the ScreenLink Setup version to receive automatic updates.";
      } else {
        userMessage = "Updates are not supported on this platform.";
      }
      return {
        phase: "unsupported",
        currentVersion: app.getVersion(),
        userMessage,
        isPackaged,
        isPortable,
        updaterSupported: false,
      };
    }

    return {
      phase: "idle",
      currentVersion: app.getVersion(),
      userMessage: formatUserMessage("idle"),
      isPackaged: true,
      isPortable: false,
      updaterSupported: true,
    };
  }

  private detectPortable(): boolean {
    return (
      typeof process.env.PORTABLE_EXECUTABLE_DIR === "string" &&
      process.env.PORTABLE_EXECUTABLE_DIR.length > 0
    );
  }

  private bindEvents(): void {
    this.updater.on("checking-for-update", () => {
      this.logger.log("info", "updater", "checking_for_update", {});
    });

    this.updater.on("update-available", (info: any) => {
      const rawVersion = info?.version;
      const comparison = compareVersions(this.state.currentVersion, rawVersion);

      this.logger.log("info", "updater", "update_available_received", {
        rawVersion: rawVersion ?? null,
        normalizedAvailable: comparison.normalizedAvailable,
        normalizedCurrent: comparison.normalizedCurrent,
        reason: comparison.reason,
      });

      if (!comparison.isNewer) {
        // Stale, equal, lower, malformed, or missing versions are never
        // advertised as updates. We log the reason and fall through to
        // an up-to-date (or error) state so the renderer never displays
        // a misleading version.
        this.logger.log("info", "updater", "update_available_suppressed", {
          reason: comparison.reason,
          rawVersion: rawVersion ?? null,
        });

        if (comparison.normalizedAvailable === null) {
          // Malformed metadata: surface a safe error rather than
          // pretending the app is up to date.
          this.setState({
            phase: "error",
            availableVersion: undefined,
            lastCheckedAt: Date.now(),
            errorCode: "invalid-update-metadata",
            errorMessage:
              "Update metadata received from the server is invalid. Please try again later.",
          });
        } else {
          // Equal or lower: treat as up-to-date.
          this.setState({
            phase: "up-to-date",
            availableVersion: undefined,
            lastCheckedAt: Date.now(),
            errorCode: undefined,
            errorMessage: undefined,
          });
        }
        return;
      }

      this.setState({
        phase: "update-available",
        availableVersion: comparison.normalizedAvailable!,
        lastCheckedAt: Date.now(),
        errorCode: undefined,
        errorMessage: undefined,
      });
    });

    this.updater.on("update-not-available", (info: any) => {
      const version = info?.version ?? this.state.currentVersion;
      this.logger.log("info", "updater", "update_not_available", { latestVersion: version });
      this.setState({
        phase: "up-to-date",
        lastCheckedAt: Date.now(),
        errorCode: undefined,
        errorMessage: undefined,
      });
    });

    this.updater.on("download-progress", (progress: any) => {
      const rawPercent = progress?.percent;
      const percent = typeof rawPercent === "number" && isFinite(rawPercent)
        ? Math.max(0, Math.min(100, rawPercent))
        : 0;

      const transferredBytes = typeof progress?.transferred === "number" && isFinite(progress.transferred)
        ? Math.max(0, progress.transferred)
        : 0;

      const totalBytes = typeof progress?.total === "number" && isFinite(progress.total)
        ? Math.max(0, progress.total)
        : 0;

      const bytesPerSecond = typeof progress?.bytesPerSecond === "number" && isFinite(progress.bytesPerSecond)
        ? Math.max(0, progress.bytesPerSecond)
        : 0;

      this.setState({
        phase: "downloading",
        downloadPercent: percent,
        transferredBytes,
        totalBytes,
        bytesPerSecond,
      });
    });

    this.updater.on("update-downloaded", (info: any) => {
      const version = info?.version ?? this.state.availableVersion ?? "unknown";
      this.logger.log("info", "updater", "update_downloaded", { version });
      this.setState({
        phase: "downloaded",
        downloadedVersion: version,
        downloadPercent: 100,
        lastCheckedAt: Date.now(),
        errorCode: undefined,
        errorMessage: undefined,
      });
    });

    this.updater.on("error", (err: any) => {
      const { code, safeMessage } = getErrorCode(err);
      this.logger.log("error", "updater", "updater_error", {
        errorCode: code,
        errorDetail: String(err),
      });

      // If the user already has a useful state (update available or downloaded),
      // don't overwrite it with an automatic error
      if (this.state.phase === "update-available" || this.state.phase === "downloaded") {
        this.logger.log("info", "updater", "error_suppressed", {
          currentPhase: this.state.phase,
        });
        return;
      }

      // If we're downloading and the error is about blockmap/checksum,
      // electron-updater may fall back to full download — don't show error
      if (this.state.phase === "downloading" && code === "checksum-failure") {
        this.logger.log("info", "updater", "differential_fallback", {});
        return;
      }

      this.setState({
        phase: "error",
        errorCode: code,
        errorMessage: safeMessage,
      });
    });
  }

  private setState(partial: Partial<UpdateStatus>): void {
    if (this.isDestroyed) return;

    this.state = {
      ...this.state,
      ...partial,
      userMessage: partial.phase
        ? formatUserMessage(partial.phase, partial.availableVersion ?? this.state.availableVersion, partial.errorMessage)
        : this.state.userMessage,
    };

    this.broadcast(this.getStatus());
  }
}
