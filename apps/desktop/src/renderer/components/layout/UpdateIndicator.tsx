/**
 * UpdateIndicator — Title-bar control surfacing the real updater state.
 *
 * This component is a pure view onto the `UpdateStatusDTO` produced by the
 * main-process `UpdateManager`. It never invents a version, never fakes
 * release notes, and never mutates the underlying updater state from the
 * "Later" button.
 *
 * State machine (driven by `status.phase`):
 *
 *   unsupported  → indicator hidden; no badge.
 *   idle         → indicator hidden; no badge.
 *   up-to-date   → indicator hidden; no badge.
 *   checking     → subtle spinner in the title bar.
 *   update-available → "Update" badge; popover offers Download / Later.
 *   downloading  → progress bar with real percent, sizes, and speed.
 *   downloaded   → "Restart" badge; popover offers Restart and install / Later.
 *   installing   → spinner; controls disabled.
 *   error        → "Update" badge; popover offers Retry check / Later.
 *
 * "Later" closes the popover locally; it does NOT clear the underlying
 * updater state. Reopening the popover shows the same real status.
 */
import { useCallback, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { CheckCircle2, Download, RefreshCw, RotateCw, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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

function formatBytesPerSecond(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  return `${formatBytes(n)}/s`;
}

export function UpdateIndicator() {
  const {
    status,
    actionInFlight,
    error: hookError,
    check,
    download,
    restartAndInstall,
  } = useUpdateStatus();

  // Popover-local "Later" close state. This is the ONLY renderer-side
  // override of visibility; the underlying updater state is unchanged.
  const [popoverOpen, setPopoverOpen] = useState(false);

  const handleLater = useCallback(() => {
    setPopoverOpen(false);
  }, []);

  // ── No status yet: render nothing. We do not invent an update. ─────
  if (!status) {
    return null;
  }

  // ── Phases that intentionally suppress the indicator. ─────────────
  if (
    status.phase === "unsupported" ||
    status.phase === "idle" ||
    status.phase === "up-to-date"
  ) {
    return null;
  }

  // ── Visual variants per phase. ─────────────────────────────────────
  const isChecking = status.phase === "checking";
  const isAvailable = status.phase === "update-available";
  const isDownloading = status.phase === "downloading";
  const isDownloaded = status.phase === "downloaded";
  const isInstalling = status.phase === "installing";
  const isError = status.phase === "error";

  const showBadge = isAvailable || isDownloaded || isError;
  const showChecking = isChecking;

  const percent =
    typeof status.downloadPercent === "number"
      ? Math.max(0, Math.min(100, status.downloadPercent))
      : 0;

  const transferred = status.transferredBytes ?? 0;
  const total = status.totalBytes ?? 0;
  const speed = status.bytesPerSecond ?? 0;

  const errorMessage = hookError ?? status.errorMessage ?? status.userMessage;

  return (
    <AnimatePresence>
      <motion.div
        key="update-indicator"
        initial={{ y: -8, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: -8, opacity: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="flex items-center"
      >
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-text-secondary hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
              aria-label={
                isDownloaded
                  ? "Update ready to install"
                  : isError
                    ? "Update error"
                    : "Update available"
              }
              data-testid="update-indicator-trigger"
            >
              {showChecking && (
                <>
                  <RefreshCw className="h-3 w-3 animate-spin" />
                  <span>Checking</span>
                </>
              )}
              {isAvailable && (
                <>
                  <Download className="h-3 w-3" />
                  <span>Update</span>
                </>
              )}
              {isDownloading && (
                <>
                  <Download className="h-3 w-3" />
                  <span>{Math.round(percent)}%</span>
                </>
              )}
              {isDownloaded && (
                <>
                  <RotateCw className="h-3 w-3" />
                  <span>Restart</span>
                </>
              )}
              {isInstalling && (
                <>
                  <RefreshCw className="h-3 w-3 animate-spin" />
                  <span>Installing</span>
                </>
              )}
              {isError && (
                <>
                  <AlertTriangle className="h-3 w-3" />
                  <span>Update</span>
                </>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent side="bottom" align="end" className="w-72">
            <div className="space-y-3">
              {isAvailable && status.availableVersion && (
                <>
                  <div>
                    <p className="text-sm font-semibold text-text-primary">
                      Version {status.availableVersion} available
                    </p>
                    <p className="text-[11px] text-text-muted mt-0.5">
                      You have {status.currentVersion}. A new version of
                      ScreenLink is ready to download.
                    </p>
                  </div>
                  <Separator />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="flex-1"
                      onClick={() => void download()}
                      disabled={actionInFlight === "download"}
                      data-testid="update-download-button"
                    >
                      <Download className="h-3.5 w-3.5 mr-1" />
                      Download update
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleLater}
                      data-testid="update-later-button"
                    >
                      Later
                    </Button>
                  </div>
                </>
              )}

              {isDownloading && (
                <>
                  <div>
                    <p className="text-sm font-semibold text-text-primary">
                      Downloading update
                    </p>
                    <p className="text-[11px] text-text-muted mt-0.5">
                      {status.availableVersion
                        ? `Installing ${status.availableVersion} will start when the download finishes.`
                        : "The update will install when the download finishes."}
                    </p>
                  </div>
                  <Progress value={percent} />
                  <div className="flex items-center justify-between text-[11px] text-text-muted">
                    <span>
                      {formatBytes(transferred)}
                      {total > 0 ? ` / ${formatBytes(total)}` : ""}
                    </span>
                    <span>{Math.round(percent)}%</span>
                  </div>
                  {speed > 0 && (
                    <p className="text-[11px] text-text-muted">
                      {formatBytesPerSecond(speed)}
                    </p>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled
                    className="w-full"
                  >
                    <Download className="h-3.5 w-3.5 mr-1" />
                    Downloading…
                  </Button>
                </>
              )}

              {isDownloaded && (
                <>
                  <div>
                    <p className="text-sm font-semibold text-text-primary">
                      Update ready to install
                    </p>
                    <p className="text-[11px] text-text-muted mt-0.5">
                      {status.downloadedVersion
                        ? `Version ${status.downloadedVersion} has been downloaded. Restart ScreenLink to install it.`
                        : "The update has been downloaded. Restart ScreenLink to install it."}
                    </p>
                  </div>
                  <Separator />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="flex-1"
                      onClick={() => void restartAndInstall()}
                      disabled={actionInFlight === "restartAndInstall"}
                      data-testid="update-restart-button"
                    >
                      <RotateCw className="h-3.5 w-3.5 mr-1" />
                      Restart and install
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleLater}
                    >
                      Later
                    </Button>
                  </div>
                </>
              )}

              {isInstalling && (
                <>
                  <div>
                    <p className="text-sm font-semibold text-text-primary">
                      Restarting to install update
                    </p>
                    <p className="text-[11px] text-text-muted mt-0.5">
                      ScreenLink will close and reopen with the new version.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled
                    className="w-full"
                  >
                    <RefreshCw className="h-3.5 w-3.5 mr-1 animate-spin" />
                    Installing…
                  </Button>
                </>
              )}

              {isError && (
                <>
                  <div>
                    <p className="text-sm font-semibold text-text-primary">
                      Update error
                    </p>
                    <p className="text-[11px] text-text-muted mt-0.5">
                      {errorMessage}
                    </p>
                  </div>
                  <Separator />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="flex-1"
                      onClick={() => void check()}
                      disabled={actionInFlight === "check"}
                    >
                      <RefreshCw className="h-3.5 w-3.5 mr-1" />
                      Retry check
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleLater}
                    >
                      Later
                    </Button>
                  </div>
                </>
              )}

              {(isAvailable || isDownloaded || isDownloading || isError) && (
                <p className="text-[10px] text-text-muted flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  Current version: {status.currentVersion}
                </p>
              )}
            </div>
          </PopoverContent>
        </Popover>
      </motion.div>
    </AnimatePresence>
  );
}
