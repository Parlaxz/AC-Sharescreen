/**
 * UpdatesSettingsSection — User Settings panel for the real updater.
 *
 * This is a thin consumer of `useUpdateStatus()`. It must display exactly:
 *  - Current version
 *  - Updater support state
 *  - Last checked time when available
 *  - Check for updates action
 *  - Available version when real
 *  - Download progress when downloading
 *  - Restart and install when downloaded
 *  - Safe error and retry state
 *
 * It must NOT add update channels, prerelease toggles, automatic-install
 * settings, fake release notes, or a fake latest version.
 */
import { useEffect, useState } from "react";
import { Download, RefreshCw, RotateCw, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { useUpdateStatus } from "@/hooks/use-update-status";

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatLastChecked(ts: number | undefined): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "Never";
  const d = new Date(ts);
  return d.toLocaleString();
}

export function UpdatesSettingsSection() {
  const {
    status,
    actionInFlight,
    error: hookError,
    check,
    download,
    restartAndInstall,
    checkDownloadAndInstall,
  } = useUpdateStatus();

  // Mounted guard to keep UI stable across React strict-mode double-render.
  const [, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!status) {
    return (
      <p className="text-xs text-text-muted">Loading update information…</p>
    );
  }

  const percent =
    typeof status.downloadPercent === "number"
      ? Math.max(0, Math.min(100, status.downloadPercent))
      : 0;

  const errorMessage = hookError ?? status.errorMessage ?? status.userMessage;

  return (
    <div className="space-y-3" data-testid="updates-settings-section">
      <div className="flex flex-col gap-1">
        <span className="text-sm text-text-primary">Current version</span>
        <span className="text-xs text-text-muted">{status.currentVersion}</span>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-sm text-text-primary">Updater support</span>
        <span className="text-xs text-text-muted" data-testid="updates-support-state">
          {!status.updaterSupported
            ? status.isPortable
              ? "Portable build — cannot self-update. Install the NSIS Setup version to receive updates."
              : !status.isPackaged
                ? "Development build — updates are only available in an installed packaged build."
                : "Updates are not supported on this platform."
            : "Supported (installed packaged build)"}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-sm text-text-primary">Last checked</span>
        <span className="text-xs text-text-muted">
          {formatLastChecked(status.lastCheckedAt)}
        </span>
      </div>

      <Separator />

      {status.phase === "update-available" && status.availableVersion && (
        <div className="space-y-2">
          <p className="text-sm text-text-primary">
            <span className="font-semibold">Available version:</span>{" "}
            <span data-testid="updates-available-version">{status.availableVersion}</span>
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => void download()}
              disabled={actionInFlight === "download"}
              data-testid="updates-download-button"
            >
              <Download className="h-3.5 w-3.5 mr-1" />
              Download update
            </Button>
          </div>
        </div>
      )}

      {status.phase === "downloading" && (
        <div className="space-y-2">
          <p className="text-sm text-text-primary">Downloading update…</p>
          <Progress value={percent} />
          <div className="flex items-center justify-between text-xs text-text-muted">
            <span>
              {formatBytes(status.transferredBytes ?? 0)}
              {(status.totalBytes ?? 0) > 0
                ? ` / ${formatBytes(status.totalBytes ?? 0)}`
                : ""}
            </span>
            <span>{Math.round(percent)}%</span>
          </div>
        </div>
      )}

      {status.phase === "downloaded" && (
        <div className="space-y-2">
          <p className="text-sm text-text-primary flex items-center gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-accent" />
            Update ready to install
            {status.downloadedVersion ? ` (${status.downloadedVersion})` : ""}
          </p>
          <Button
            size="sm"
            onClick={() => void restartAndInstall()}
            disabled={actionInFlight === "restartAndInstall"}
            data-testid="updates-restart-button"
          >
            <RotateCw className="h-3.5 w-3.5 mr-1" />
            Restart and install
          </Button>
        </div>
      )}

      {status.phase === "installing" && (
        <p className="text-sm text-text-primary flex items-center gap-2">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          Restarting to install update…
        </p>
      )}

      {status.phase === "error" && (
        <div className="space-y-2">
          <p className="text-sm text-text-primary flex items-center gap-2" data-testid="updates-error-message">
            <AlertTriangle className="h-3.5 w-3.5 text-danger" />
            {errorMessage}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void check()}
            disabled={actionInFlight === "check"}
            data-testid="updates-retry-button"
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            Retry check
          </Button>
        </div>
      )}

      {(status.phase === "idle" ||
        status.phase === "checking" ||
        status.phase === "up-to-date") && (
        <div className="space-y-2">
          {status.phase === "checking" && (
            <p className="text-sm text-text-muted flex items-center gap-2">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              Checking for updates…
            </p>
          )}
          {status.phase === "up-to-date" && (
            <p className="text-sm text-text-muted">ScreenLink is up to date.</p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void check()}
              disabled={actionInFlight === "check"}
              data-testid="updates-check-button"
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1" />
              Check for updates
            </Button>
            <Button
              size="sm"
              onClick={() => void checkDownloadAndInstall()}
              disabled={actionInFlight !== null}
              data-testid="updates-full-update-button"
            >
              <Download className="h-3.5 w-3.5 mr-1" />
              {actionInFlight === "fullUpdate"
                ? "Checking…"
                : "Check, download, and install"}
            </Button>
          </div>
        </div>
      )}

      {status.phase === "unsupported" && (
        <p className="text-xs text-text-muted">
          You can manually download the latest release from the project page.
        </p>
      )}
    </div>
  );
}
