import { useEffect, useState, useCallback } from "react";
import { Monitor, ExternalLink, Github } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageSection } from "@/components/layout/PageSection";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { ScreenLinkAPI, UpdateStatusDTO } from "../../preload/api-types.js";

// ─── Types ─────────────────────────────────────────────────────────────────

interface AppInfo {
  version: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function getApi(): ScreenLinkAPI | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { screenlink?: ScreenLinkAPI }).screenlink ?? null;
}

// ─── About Page ────────────────────────────────────────────────────────────

export function About() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusDTO | null>(null);
  const [updateLoading, setUpdateLoading] = useState(false);

  // ── Load app info ────────────────────────────────────────────────
  useEffect(() => {
    const api = getApi();
    if (!api) return;

    let cancelled = false;

    api.getAppInfo().then((info) => {
      if (cancelled || !info) return;
      setAppInfo({
        version: info.version,
        electronVersion: info.electronVersion,
        chromeVersion: info.chromeVersion,
        nodeVersion: info.nodeVersion ?? "unknown",
      });
    }).catch(() => {
      // Silently fail — app info card will show "?"
    });

    // Load update status
    if (api.getUpdateStatus) {
      api.getUpdateStatus().then((status) => {
        if (!cancelled) setUpdateStatus(status);
      }).catch(() => {});
    }

    return () => {
      cancelled = true;
    };
  }, []);

  // ── Subscribe to update status changes ──────────────────────────
  useEffect(() => {
    const api = getApi();
    if (!api?.onUpdateStatusChanged) return;
    const unsub = api.onUpdateStatusChanged((status) => {
      setUpdateStatus(status);
    });
    return () => {
      if (typeof unsub === "function") unsub();
    };
  }, []);

  // ── External link handler ───────────────────────────────────────
  const handleOpenExternal = useCallback((url: string) => {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      const api = getApi();
      if (api?.openExternal) {
        api.openExternal(url).catch(() => toast.error("Failed to open link"));
      } else {
        // Fallback: open in new window if API not available
        window.open(url, "_blank", "noopener,noreferrer");
      }
    };
  }, []);

  // ── Check for updates handler ───────────────────────────────────
  const handleCheckUpdates = useCallback(() => {
    const api = getApi();
    if (!api?.checkForUpdates) return;
    setUpdateLoading(true);
    api.checkForUpdates()
      .then((status) => {
        if (status) setUpdateStatus(status);
      })
      .catch(() => toast.error("Failed to check for updates"))
      .finally(() => setUpdateLoading(false));
  }, []);

  // ── Update phase badge ──────────────────────────────────────────
  const updateBadge = updateStatus ? (
    <Badge
      variant={
        updateStatus.phase === "up-to-date" || updateStatus.phase === "idle"
          ? "success"
          : updateStatus.phase === "error" || updateStatus.phase === "unsupported"
            ? "destructive"
            : updateStatus.phase === "update-available"
              ? "warning"
              : "secondary"
      }
      className="text-[10px]"
    >
      {updateStatus.phase === "up-to-date"
        ? "Up to date"
        : updateStatus.phase === "update-available"
          ? "Update available"
          : updateStatus.phase === "downloading"
            ? "Downloading..."
            : updateStatus.phase === "downloaded"
              ? "Ready to install"
              : updateStatus.phase === "checking"
                ? "Checking..."
                : updateStatus.phase === "error"
                  ? "Update error"
                  : updateStatus.phase === "unsupported"
                    ? "Unsupported"
                    : updateStatus.phase}
    </Badge>
  ) : null;

  // ── Info row ────────────────────────────────────────────────────
  const InfoRow = ({ label, value }: { label: string; value: string }) => (
    <div className="flex items-center justify-between py-1 border-b border-border-subtle last:border-b-0">
      <span className="text-xs text-text-secondary">{label}</span>
      <span className="font-mono text-xs text-text-primary">{value}</span>
    </div>
  );

  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      {/* ─── Page header ─────────────────────────────────────── */}
      <PageHeader
        title="About ScreenLink"
        description="Version, licensing, and update information"
        status={updateBadge}
      />

      {/* ─── Application ─────────────────────────────────────── */}
      <PageSection title="Application" description="ScreenLink version and technology stack">
        <div className="rounded-standard border border-border-subtle overflow-hidden">
          <div className="flex flex-col items-center py-6 space-y-3 bg-surface-2">
            <div className="flex items-center justify-center h-14 w-14 rounded-dialog bg-accent-muted">
              <Monitor className="h-7 w-7 text-accent" />
            </div>
            <h2 className="text-base font-semibold text-text-primary">ScreenLink</h2>
            <p className="font-mono text-sm text-text-secondary">
              v{appInfo?.version ?? "?"}
            </p>
            <p className="text-xs text-text-muted">
              Private screen sharing with permanent links
            </p>
          </div>
          <Separator />
          <div className="px-4 py-2 space-y-0">
            <InfoRow label="Application" value={appInfo?.version ?? "?"} />
            <InfoRow label="Electron" value={appInfo?.electronVersion ?? "?"} />
            <InfoRow label="Chromium" value={appInfo?.chromeVersion ?? "?"} />
            <InfoRow label="Node.js" value={appInfo?.nodeVersion ?? "?"} />
          </div>
        </div>
      </PageSection>

      {/* ─── Updates ─────────────────────────────────────────── */}
      <PageSection title="Updates" description="Check for new versions of ScreenLink">
        <div className="rounded-standard border border-border-subtle p-4 space-y-3">
          {updateStatus ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">Current version</span>
                <span className="font-mono text-xs text-text-primary">
                  {updateStatus.currentVersion}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">Status</span>
                <span className="text-xs text-text-primary">
                  {updateStatus.userMessage}
                </span>
              </div>
              {updateStatus.phase === "update-available" && updateStatus.availableVersion && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-secondary">Available version</span>
                  <span className="font-mono text-xs text-text-primary">
                    {updateStatus.availableVersion}
                  </span>
                </div>
              )}
              {updateStatus.phase === "error" && updateStatus.errorMessage && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-danger">Error</span>
                  <span className="text-xs text-danger">{updateStatus.errorMessage}</span>
                </div>
              )}
              <div className="pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCheckUpdates}
                  disabled={updateLoading || updateStatus.phase === "checking"}
                >
                  {updateLoading || updateStatus.phase === "checking"
                    ? "Checking..."
                    : "Check for updates"}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-xs text-text-muted">
              Update status unavailable. Updates are only available in packaged builds.
            </p>
          )}
        </div>
      </PageSection>

      {/* ─── License ─────────────────────────────────────────── */}
      <PageSection title="License" description="Terms under which ScreenLink is distributed">
        <div className="rounded-standard border border-border-subtle p-4 space-y-2">
          <p className="text-sm text-text-secondary">
            ScreenLink is provided under the terms of the ISC License.
          </p>
          <p className="text-xs text-text-muted">
            The VDO SDK component is licensed under AGPL-3.0.
            See the LICENSE file in the repository for full details.
          </p>
        </div>
      </PageSection>

      {/* ─── Links ───────────────────────────────────────────── */}
      <PageSection title="Links" description="Useful resources for ScreenLink">
        <div className="rounded-standard border border-border-subtle p-4 space-y-3">
          <a
            href="https://github.com/Parlaxz/AC-Sharescreen"
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleOpenExternal("https://github.com/Parlaxz/AC-Sharescreen")}
            className="flex items-center gap-2 text-sm text-accent hover:text-accent-hover transition-colors cursor-pointer"
          >
            <Github className="h-4 w-4" />
            Source code on GitHub
          </a>
          <a
            href="https://screenlink.app"
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleOpenExternal("https://screenlink.app")}
            className="flex items-center gap-2 text-sm text-accent hover:text-accent-hover transition-colors cursor-pointer"
          >
            <ExternalLink className="h-4 w-4" />
            ScreenLink website
          </a>
        </div>
      </PageSection>
    </div>
  );
}
