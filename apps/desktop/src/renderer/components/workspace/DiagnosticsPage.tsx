import { useState, useEffect, useCallback, useId } from "react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { useStore } from "@/stores/main-store";
import { cn } from "@/lib/utils";
import type { ScreenLinkAPI, ReadRecentLogsResult } from "../../../preload/api-types.js";

// ─── Types ─────────────────────────────────────────────────────────────────

interface AppInfo {
  version: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
}

interface HelperProvenance {
  state: string;
  uptimeMs: number;
  generation: number;
  helperBinaryPath?: string;
  helperBinarySize?: number;
  helperBinaryMtime?: string;
}

interface DiagnosticsData {
  appInfo: AppInfo | null;
  appInfoError: string | null;
  audioState: string | null;
  audioStateError: string | null;
  helperProvenance: HelperProvenance | null;
  helperProvenanceError: string | null;
  nvidiaCapability: { available: boolean; reason: string } | null;
  nvidiaCapabilityError: string | null;
  videoHelperDiag: Record<string, unknown> | null;
  videoHelperDiagError: string | null;
}

type LoadState = "loading" | "unavailable" | "loaded" | "error";

// ─── Helpers ───────────────────────────────────────────────────────────────

function getApi(): ScreenLinkAPI | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { screenlink?: ScreenLinkAPI }).screenlink ?? null;
}

function formatUptime(ms: number | undefined | null): string {
  if (ms == null) return "—";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatBytes(bytes: number | undefined | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── DisclosureSection ─────────────────────────────────────────────────────

function DisclosureSection({
  title,
  open,
  onToggle,
  id,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  id: string;
  children: React.ReactNode;
}) {
  const contentId = `${id}-content`;
  return (
    <div>
      <button
        onClick={onToggle}
        className="flex items-center gap-2 w-full text-left py-2 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-compact px-1"
        aria-expanded={open}
        aria-controls={contentId}
      >
        <motion.svg
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ duration: 0.15 }}
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="flex-shrink-0"
        >
          <polyline points="9 18 15 12 9 6" />
        </motion.svg>
        {title}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div id={contentId} className="pt-1 pb-2" role="region" aria-label={title}>
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── InfoRow ───────────────────────────────────────────────────────────────

function InfoRow({
  label,
  value,
  mono,
  copyable,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copyable?: boolean;
}) {
  const handleCopy = useCallback(() => {
    const api = getApi();
    if (api?.clipboardWriteText) {
      api.clipboardWriteText(value).then((result) => {
        if (result.success) {
          toast("Copied: " + value);
        } else {
          toast("Failed to copy");
        }
      }).catch(() => {
        toast("Failed to copy");
      });
    } else {
      toast("Clipboard API not available");
    }
  }, [value]);

  return (
    <div className="flex items-center justify-between py-1 border-b border-border-subtle last:border-b-0">
      <span className="text-xs text-text-secondary">{label}</span>
      {copyable ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleCopy}
              aria-label={`Copy ${label}`}
              className="font-mono text-xs text-text-primary hover:text-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
            >
              {value || "—"}
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">Click to copy</TooltipContent>
        </Tooltip>
      ) : (
        <span
          className={cn(
            "text-xs text-text-primary",
            mono && "font-mono",
          )}
        >
          {value || "—"}
        </span>
      )}
    </div>
  );
}

// ─── SkeletonRow ───────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <div className="flex items-center justify-between py-1 border-b border-border-subtle last:border-b-0">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-3 w-24" />
    </div>
  );
}

// ─── DiagnosticsPage ───────────────────────────────────────────────────────

export function DiagnosticsPage() {
  // ── Disclosure state ─────────────────────────────────────────────
  const [showVideoHelper, setShowVideoHelper] = useState(false);
  const [showNetwork, setShowNetwork] = useState(false);

  // ── IDs for disclosure sections ──────────────────────────────────
  const videoHelperId = useId();
  const networkId = useId();

  // ── Data ─────────────────────────────────────────────────────────
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [data, setData] = useState<DiagnosticsData>({
    appInfo: null,
    appInfoError: null,
    audioState: null,
    audioStateError: null,
    helperProvenance: null,
    helperProvenanceError: null,
    nvidiaCapability: null,
    nvidiaCapabilityError: null,
    videoHelperDiag: null,
    videoHelperDiagError: null,
  });

  // ── Log state ────────────────────────────────────────────────────
  const [logResult, setLogResult] = useState<ReadRecentLogsResult | null>(null);
  const [logLoading, setLogLoading] = useState(true);

  // ── Browser info (renderer-side only) ────────────────────────────
  const browserInfo = typeof navigator !== "undefined" ? {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: (navigator as unknown as { deviceMemory?: number }).deviceMemory,
    maxTouchPoints: navigator.maxTouchPoints,
  } : null;

  const webrtcSupport = typeof navigator !== "undefined" ? {
    rtcPeerConnection: typeof RTCPeerConnection !== "undefined",
    rtcDataChannel: typeof RTCDataChannel !== "undefined",
    getDisplayMedia: typeof navigator.mediaDevices?.getDisplayMedia !== "undefined",
    enumerateDevices: typeof navigator.mediaDevices?.enumerateDevices !== "undefined",
    canvasCapture: typeof HTMLCanvasElement.prototype.captureStream !== "undefined",
    webCodecs:
      typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined",
  } : null;

  // ── Load diagnostics data ────────────────────────────────────────
  useEffect(() => {
    const api = getApi();
    if (!api) {
      setLoadState("unavailable");
      return;
    }

    const screenlink: ScreenLinkAPI = api;
    let cancelled = false;

    async function loadAll() {
      setLoadState("loading");

      // Load app info
      let appInfo: AppInfo | null = null;
      let appInfoError: string | null = null;
      try {
        const info = await screenlink.getAppInfo();
        if (!cancelled && info) {
          appInfo = {
            version: info.version,
            electronVersion: info.electronVersion,
            chromeVersion: info.chromeVersion,
            nodeVersion: info.nodeVersion ?? "unknown",
          };
        }
      } catch (err) {
        appInfoError = err instanceof Error ? err.message : String(err);
      }

      // Load audio state
      let audioState: string | null = null;
      let audioStateError: string | null = null;
      try {
        const state = await screenlink.getAudioState();
        if (!cancelled) audioState = state ?? "disabled";
      } catch (err) {
        audioStateError = err instanceof Error ? err.message : String(err);
      }

      // Load helper provenance from pipeline snapshot
      let helperProvenance: HelperProvenance | null = null;
      let helperProvenanceError: string | null = null;
      try {
        const snap = await screenlink.getPipelineSnapshot();
        if (!cancelled && snap) {
          helperProvenance = {
            state: (snap as any).helperState ?? "unknown",
            uptimeMs: (snap as any).helperUptimeMs ?? 0,
            generation: (snap as any).streamGeneration ?? 0,
            helperBinaryPath: (snap as any).helperBinaryPath,
            helperBinarySize: (snap as any).helperBinarySize,
            helperBinaryMtime: (snap as any).helperBinaryMtime,
          };
        }
      } catch (err) {
        helperProvenanceError = err instanceof Error ? err.message : String(err);
      }

      // Load NVIDIA capability
      let nvidiaCapability: { available: boolean; reason: string } | null = null;
      let nvidiaCapabilityError: string | null = null;
      try {
        const cap = await screenlink.probeNvidiaVsrCapability();
        if (!cancelled) nvidiaCapability = cap ?? { available: false, reason: "unknown" };
      } catch (err) {
        nvidiaCapabilityError = err instanceof Error ? err.message : String(err);
      }

      // Load video helper diagnostics
      let videoHelperDiag: Record<string, unknown> | null = null;
      let videoHelperDiagError: string | null = null;
      try {
        const diag = await screenlink.videoHelperGetDiagnostics();
        if (!cancelled) videoHelperDiag = diag;
      } catch (err) {
        videoHelperDiagError = err instanceof Error ? err.message : String(err);
      }

      if (cancelled) return;

      setData({
        appInfo,
        appInfoError,
        audioState,
        audioStateError,
        helperProvenance,
        helperProvenanceError,
        nvidiaCapability,
        nvidiaCapabilityError,
        videoHelperDiag,
        videoHelperDiagError,
      });

      if (appInfoError && !appInfo) {
        setLoadState("error");
      } else {
        setLoadState("loaded");
      }
    }

    loadAll();

    return () => {
      cancelled = true;
    };
  }, []);

  // ── Load logs ────────────────────────────────────────────────────
  useEffect(() => {
    const api = getApi();
    if (!api) return;

    let cancelled = false;

    api.readRecentLogs().then((result) => {
      if (!cancelled) {
        setLogResult(result);
        setLogLoading(false);
      }
    }).catch(() => {
      if (!cancelled) {
        setLogResult({
          success: false,
          data: "",
          byteCount: 0,
          lineCount: 0,
          truncated: false,
          error: "Failed to load logs",
        });
        setLogLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // ── Copy logs handler ────────────────────────────────────────────
  const handleCopyLogs = useCallback(() => {
    const api = getApi();
    if (!api?.clipboardWriteText) {
      toast("Clipboard API not available");
      return;
    }

    if (!logResult?.success || !logResult.data) {
      toast("No log content to copy");
      return;
    }

    api.clipboardWriteText(logResult.data).then((result) => {
      if (result.success) {
        toast("Logs copied to clipboard");
      } else {
        toast("Failed to copy logs");
      }
    }).catch(() => {
      toast("Failed to copy logs");
    });
  }, [logResult]);

  const handleOpenLogFolder = useCallback(() => {
    const api = getApi();
    if (api?.openLogFolder) {
      api.openLogFolder().then((result) => {
        if (result.success) {
          toast("Log folder opened");
        } else {
          toast("Failed to open log folder: " + (result.error ?? "unknown"));
        }
      }).catch(() => {
        toast("Failed to open log folder");
      });
    } else {
      toast("Log folder API not available");
    }
  }, []);

  // ── Render: API unavailable ──────────────────────────────────────
  if (loadState === "unavailable") {
    return (
      <div className="h-full overflow-auto p-6">
        <div role="alert" className="flex flex-col items-center justify-center h-full space-y-4">
          <div className="text-text-muted text-4xl">⚡</div>
          <h2 className="text-lg font-semibold text-text-primary">API not available</h2>
          <p className="text-sm text-text-secondary text-center max-w-md">
            The ScreenLink preload API is not available. This page requires
            running inside the ScreenLink Electron app.
          </p>
          <p className="text-xs text-text-muted">
            Running outside Electron? The diagnostics data cannot be loaded.
          </p>
        </div>
      </div>
    );
  }

  // ── Render: Loading ──────────────────────────────────────────────
  if (loadState === "loading") {
    return (
      <div className="h-full overflow-auto p-6 space-y-6" role="status" aria-busy="true">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-text-primary">Diagnostics</h1>
        </div>

        <Card>
          <CardHeader><CardTitle>Application</CardTitle></CardHeader>
          <CardContent className="space-y-0">
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Audio Helper</CardTitle></CardHeader>
          <CardContent className="space-y-0">
            <SkeletonRow />
            <SkeletonRow />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Video Enhancement</CardTitle></CardHeader>
          <CardContent className="space-y-0">
            <SkeletonRow />
            <SkeletonRow />
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Render: Error ────────────────────────────────────────────────
  if (loadState === "error") {
    return (
      <div className="h-full overflow-auto p-6">
        <div role="alert" className="flex flex-col items-center justify-center h-full space-y-4">
          <h2 className="text-lg font-semibold text-danger">Failed to load diagnostics</h2>
          <p className="text-sm text-text-secondary text-center max-w-md">
            {data.appInfoError || "An unexpected error occurred while loading diagnostics data."}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.location.reload()}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // ── Render: Loaded ───────────────────────────────────────────────
  return (
    <div className="h-full overflow-auto p-6 space-y-6" data-testid="diagnostics-page-root">
      {/* ─── Page header ─────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Diagnostics</h1>
      </div>

      {/* ─── Application info ────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Application</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-0">
            <InfoRow
              label="App version"
              value={data.appInfo?.version ?? "—"}
              mono
              copyable
            />
            <InfoRow
              label="Electron"
              value={data.appInfo?.electronVersion ?? "—"}
              mono
              copyable
            />
            <InfoRow
              label="Chromium"
              value={data.appInfo?.chromeVersion ?? "—"}
              mono
              copyable
            />
            <InfoRow
              label="Node.js"
              value={data.appInfo?.nodeVersion ?? "—"}
              mono
              copyable
            />
          </div>
        </CardContent>
      </Card>

      {/* ─── Renderer Environment ────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Renderer Environment</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-0">
            <InfoRow label="User Agent" value={browserInfo?.userAgent ?? "—"} />
            <InfoRow label="Platform" value={browserInfo?.platform ?? "—"} />
            <InfoRow label="Language" value={browserInfo?.language ?? "—"} />
            <InfoRow
              label="Logical cores"
              value={String(browserInfo?.hardwareConcurrency ?? "—")}
              mono
            />
            <InfoRow
              label="Device memory"
              value={browserInfo?.deviceMemory ? `${browserInfo.deviceMemory} GiB` : "unknown"}
            />
            <InfoRow
              label="Max touch points"
              value={String(browserInfo?.maxTouchPoints ?? "—")}
              mono
            />
          </div>
        </CardContent>
      </Card>

      {/* ─── WebRTC / Media Support ──────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>WebRTC &amp; Media Support</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-0">
            {webrtcSupport && Object.entries(webrtcSupport).map(([key, supported]) => (
              <div
                key={key}
                className="flex items-center justify-between py-1 border-b border-border-subtle last:border-b-0"
              >
                <span className="text-xs text-text-secondary">{key}</span>
                <Badge
                  variant={supported ? "success" : "destructive"}
                  className="text-[10px]"
                >
                  {supported ? "Yes" : "No"}
                </Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ─── Audio Helper ────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Audio Helper</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-0">
            <InfoRow label="Audio state" value={data.audioState ?? "disabled"} />
            {data.helperProvenance && (
              <>
                <InfoRow
                  label="Helper state"
                  value={data.helperProvenance.state}
                  mono
                />
                <InfoRow
                  label="Uptime"
                  value={formatUptime(data.helperProvenance.uptimeMs)}
                  mono
                />
                <InfoRow
                  label="Stream generation"
                  value={String(data.helperProvenance.generation ?? "—")}
                  mono
                />
                {data.helperProvenance.helperBinaryPath && (
                  <InfoRow
                    label="Binary path"
                    value={data.helperProvenance.helperBinaryPath}
                  />
                )}
                {data.helperProvenance.helperBinarySize != null && (
                  <InfoRow
                    label="Binary size"
                    value={formatBytes(data.helperProvenance.helperBinarySize)}
                    mono
                  />
                )}
              </>
            )}
            {!data.helperProvenance && !data.helperProvenanceError && (
              <p className="text-xs text-text-muted py-1">No audio helper data available</p>
            )}
            {data.helperProvenanceError && (
              <p className="text-xs text-danger py-1">
                Helper load error: {data.helperProvenanceError}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ─── Video Enhancement ───────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Video Enhancement</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-0">
            {data.nvidiaCapability ? (
              <div className="flex items-center justify-between py-1 border-b border-border-subtle">
                <span className="text-xs text-text-secondary">NVIDIA VSR</span>
                <Badge
                  variant={data.nvidiaCapability.available ? "success" : "secondary"}
                  className="text-[10px]"
                >
                  {data.nvidiaCapability.available ? "Available" : "Unavailable"}
                </Badge>
              </div>
            ) : (
              <p className="text-xs text-text-muted py-1">No capability data</p>
            )}
            {data.nvidiaCapability?.reason && (
              <InfoRow label="Reason" value={data.nvidiaCapability.reason} mono />
            )}
            {data.nvidiaCapabilityError && (
              <p className="text-xs text-danger py-1">
                Probe error: {data.nvidiaCapabilityError}
              </p>
            )}
            {data.videoHelperDiag && (
              <DisclosureSection
                title="Video Helper Diagnostics"
                open={showVideoHelper}
                onToggle={() => setShowVideoHelper(!showVideoHelper)}
                id={videoHelperId}
              >
                <pre className="font-mono text-[11px] text-text-secondary bg-surface-3 p-2 rounded-compact overflow-x-auto whitespace-pre-wrap">
                  {JSON.stringify(data.videoHelperDiag, null, 2)}
                </pre>
              </DisclosureSection>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ─── Logs ────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Logs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyLogs}
              disabled={!logResult?.success || !logResult.data}
            >
              Copy to clipboard
            </Button>
            <Button variant="outline" size="sm" onClick={handleOpenLogFolder}>
              Open log folder
            </Button>
          </div>
          {logLoading ? (
            <div className="h-32 rounded-compact border border-border-subtle p-3">
              <Skeleton className="h-3 w-full mb-2" />
              <Skeleton className="h-3 w-3/4 mb-2" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ) : !logResult?.success ? (
            <div className="h-32 rounded-compact border border-border-subtle p-3 flex items-center justify-center">
              <p className="text-xs text-danger">
                {logResult?.error || "Failed to load logs"}
              </p>
            </div>
          ) : !logResult.data ? (
            <div className="h-32 rounded-compact border border-border-subtle p-3 flex items-center justify-center">
              <p className="text-xs text-text-muted">No log content available</p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-text-muted">
                  {logResult.lineCount} lines ({logResult.byteCount} bytes)
                  {logResult.truncated && " — truncated"}
                </span>
              </div>
              <ScrollArea className="h-64 rounded-compact border border-border-subtle">
                <pre
                  role="log"
                  tabIndex={0}
                  aria-label="Application log content"
                  className="font-mono text-[11px] text-text-secondary p-3 leading-relaxed whitespace-pre-wrap select-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {logResult.data}
                </pre>
              </ScrollArea>
            </>
          )}
        </CardContent>
      </Card>

      {/* ─── Network ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Network</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <DisclosureSection
            title="Advanced network metrics"
            open={showNetwork}
            onToggle={() => setShowNetwork(!showNetwork)}
            id={networkId}
          >
            <p className="text-xs text-text-muted py-1">
              Network diagnostics require an active stream session.
            </p>
          </DisclosureSection>
        </CardContent>
      </Card>
    </div>
  );
}
