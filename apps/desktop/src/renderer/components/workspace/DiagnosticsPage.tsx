import { useState, useEffect, useCallback } from "react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { useStore } from "@/stores/main-store";
import { cn } from "@/lib/utils";

/**
 * DiagnosticsPage — Application diagnostics (Section 16.7).
 */
export function DiagnosticsPage() {
  // ── Disclosure state ─────────────────────────────────────────────
  const [showWebrtc, setShowWebrtc] = useState(false);
  const [showNetwork, setShowNetwork] = useState(false);
  const [showCaptures, setShowCaptures] = useState(true);

  // ── App info ─────────────────────────────────────────────────────
  const [appVersion] = useState("1.0.0");
  const [electronVersion] = useState("32.0.0");
  const [vdoVersion] = useState("2.5.0");
  const [osInfo] = useState("Windows 11 23H2");
  const [buildInfo] = useState("2026-06-25T12:00:00Z");
  const [hostname] = useState("desktop-win11");

  // ── Connection ───────────────────────────────────────────────────
  const [rendezvousHealth] = useState<"healthy" | "degraded" | "down">("healthy");
  const [shareStatus] = useState("idle");
  const [lastHeartbeat] = useState("—");
  const [lastReconnect] = useState("—");
  const [webrtcStats] = useState("{\n  \"iceState\": \"connected\",\n  \"dtlsState\": \"connected\",\n  \"bytesSent\": 2456789,\n  \"packetsSent\": 12345,\n  \"nackCount\": 3\n}");

  // ── Captures ─────────────────────────────────────────────────────
  const [captureLog] = useState<{ time: string; source: string; error?: string }[]>([
    { time: "12:34:56", source: "Screen 1 (1920×1080)" },
    { time: "12:30:22", source: "Screen 1 (1920×1080)" },
    { time: "12:25:10", source: "Window: Chrome", error: "Permission denied" },
    { time: "12:20:05", source: "Screen 2 (2560×1440)" },
    { time: "12:15:00", source: "Screen 1 (1920×1080)" },
  ]);

  // ── Logs ─────────────────────────────────────────────────────────
  const [logLines] = useState<string[]>(() =>
    Array.from({ length: 200 }, (_, i) => {
      const d = new Date(Date.now() - (200 - i) * 60000);
      const ts = d.toISOString();
      const tags = ["INFO", "WARN", "DEBUG", "INFO", "INFO", "ERROR"];
      const tag = tags[i % tags.length];
      const msgs = [
        "App initialized",
        "Helper process spawned (pid: 12345)",
        "Rendezvous connected",
        "Group sync completed",
        "Stream started (session: abcdef12)",
        "Capture stopped",
        "WebRTC ICE state: connected",
        "Audio pipeline started",
        "Encoder initialized: H264",
        "Peer connection established",
      ];
      const msg = msgs[i % msgs.length];
      return `[${ts}] [${tag}] ${msg}`;
    }),
  );

  const handleCopyLogs = useCallback(() => {
    navigator.clipboard.writeText(logLines.join("\n")).then(
      () => toast("Logs copied to clipboard"),
      () => toast("Failed to copy logs"),
    );
  }, [logLines]);

  const handleOpenLogFolder = useCallback(() => {
    toast("Log folder opened");
    // In production: api.openLogFolder()
  }, []);

  // ── Network ──────────────────────────────────────────────────────
  const [packetLoss] = useState("0.02%");
  const [jitter] = useState("4ms");
  const [rtt] = useState("28ms");

  // ── Disclosure toggle ────────────────────────────────────────────
  const DisclosureSection = ({
    title,
    open,
    onToggle,
    children,
  }: {
    title: string;
    open: boolean;
    onToggle: () => void;
    children: React.ReactNode;
  }) => (
    <div>
      <button
        onClick={onToggle}
        className="flex items-center gap-2 w-full text-left py-2 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-compact px-1"
        aria-expanded={open}
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
            <div className="pt-1 pb-2">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  // ── Info row ─────────────────────────────────────────────────────
  const InfoRow = ({
    label,
    value,
    mono,
    copyable,
  }: {
    label: string;
    value: string;
    mono?: boolean;
    copyable?: boolean;
  }) => {
    const content = (
      <span
        className={cn(
          "font-mono text-xs text-text-primary",
          mono && "font-mono",
        )}
      >
        {value}
      </span>
    );

    return (
      <div className="flex items-center justify-between py-1 border-b border-border-subtle last:border-b-0">
        <span className="text-xs text-text-secondary">{label}</span>
        {copyable ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(value);
                  toast("Copied: " + value);
                }}
                className="font-mono text-xs text-text-primary hover:text-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
              >
                {value}
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">Click to copy</TooltipContent>
          </Tooltip>
        ) : (
          content
        )}
      </div>
    );
  };

  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      {/* ─── Page header ─────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Diagnostics</h1>
      </div>

      {/* ─── System info ─────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>System info</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-0">
            <InfoRow label="App version" value={appVersion} mono copyable />
            <InfoRow label="Electron version" value={electronVersion} mono copyable />
            <InfoRow label="VDO SDK version" value={vdoVersion} mono copyable />
            <InfoRow label="OS" value={osInfo} copyable />
            <InfoRow label="Build" value={buildInfo} mono copyable />
            <InfoRow label="Hostname" value={hostname} mono copyable />
          </div>
        </CardContent>
      </Card>

      {/* ─── Connection ───────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between py-1">
            <span className="text-xs text-text-secondary">Rendezvous health</span>
            <Badge
              variant={
                rendezvousHealth === "healthy"
                  ? "success"
                  : rendezvousHealth === "degraded"
                    ? "warning"
                    : "destructive"
              }
              className="text-[10px]"
            >
              {rendezvousHealth}
            </Badge>
          </div>
          <InfoRow label="Share status" value={shareStatus || "Idle"} />
          <InfoRow label="Last heartbeat" value={lastHeartbeat} mono />
          <InfoRow label="Last reconnect" value={lastReconnect} mono />

          <Separator />
          <DisclosureSection
            title="WebRTC stats"
            open={showWebrtc}
            onToggle={() => setShowWebrtc(!showWebrtc)}
          >
            <pre className="font-mono text-[11px] text-text-secondary bg-surface-3 p-2 rounded-compact overflow-x-auto whitespace-pre-wrap">
              {webrtcStats}
            </pre>
          </DisclosureSection>
        </CardContent>
      </Card>

      {/* ─── Captures ────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Captures</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1">
            {captureLog.map((entry, i) => (
              <div
                key={i}
                className="flex items-center gap-3 py-1 text-xs border-b border-border-subtle last:border-b-0"
              >
                <span className="font-mono text-text-muted flex-shrink-0">
                  {entry.time}
                </span>
                <span className="text-text-primary flex-1 truncate">
                  {entry.source}
                </span>
                {entry.error && (
                  <Badge variant="destructive" className="text-[10px] flex-shrink-0">
                    {entry.error}
                  </Badge>
                )}
              </div>
            ))}
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
            <Button variant="outline" size="sm" onClick={handleCopyLogs}>
              Copy to clipboard
            </Button>
            <Button variant="outline" size="sm" onClick={handleOpenLogFolder}>
              Open log folder
            </Button>
          </div>
          <ScrollArea className="h-64 rounded-compact border border-border-subtle">
            <pre className="font-mono text-[11px] text-text-secondary p-3 leading-relaxed whitespace-pre-wrap select-text">
              {logLines.join("\n")}
            </pre>
          </ScrollArea>
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
          >
            <div className="space-y-1">
              <InfoRow label="Packet loss" value={packetLoss} mono />
              <InfoRow label="Jitter" value={jitter} mono />
              <InfoRow label="RTT" value={rtt} mono />
            </div>
          </DisclosureSection>
        </CardContent>
      </Card>
    </div>
  );
}
