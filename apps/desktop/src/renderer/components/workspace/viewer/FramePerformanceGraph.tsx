/**
 * FramePerformanceGraph — Tabbed Recharts graph for viewer frame timing.
 *
 * Tabs:
 *   Frame rate  — primary displayed FPS, secondary decoded FPS
 *   Frame time  — primary frame interval ms, secondary decode time ms
 *
 * Accepts frame performance samples as props (no internal polling).
 * Null values during pauses/reconnects produce graph gaps.
 */
import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// ─── Sample type ────────────────────────────────────────────────────────────

export interface FramePerformanceSample {
  /** Epoch ms */
  timestamp: number;
  /** Displayed FPS from frame callbacks (primary frame-rate metric) */
  displayedFps: number | null;
  /** Decoded FPS from inbound-rtp stats (secondary frame-rate metric) */
  decodedFps: number | null;
  /** Frame interval in ms (primary frame-time metric; e.g. 1000/displayedFps) */
  frameIntervalMs: number | null;
  /** Decode time in ms (secondary frame-time metric) */
  decodeTimeMs: number | null;
  /** Connection state — non-"playing" yields graph gaps */
  state: "playing" | "paused" | "reconnecting";
}

// ─── Props ──────────────────────────────────────────────────────────────────

interface FramePerformanceGraphProps {
  samples: FramePerformanceSample[];
  /** Max samples to render (default 120 ≈ 120s at 1s intervals) */
  maxSamples?: number;
}

// ─── Chart data point types ─────────────────────────────────────────────────

interface FrameRatePoint {
  time: number;
  displayedFps: number | null;
  decodedFps: number | null;
}

interface FrameTimePoint {
  time: number;
  frameIntervalMs: number | null;
  decodeTimeMs: number | null;
}

// ─── Data preparation (pure, exported for testability) ──────────────────────

export function prepareFrameRateData(
  samples: FramePerformanceSample[],
  maxSamples: number,
): FrameRatePoint[] {
  const recent = samples.slice(-maxSamples);
  return recent.map((s) => ({
    time: s.timestamp,
    displayedFps: s.state === "playing" ? s.displayedFps : null,
    decodedFps: s.state === "playing" ? s.decodedFps : null,
  }));
}

export function prepareFrameTimeData(
  samples: FramePerformanceSample[],
  maxSamples: number,
): FrameTimePoint[] {
  const recent = samples.slice(-maxSamples);
  return recent.map((s) => ({
    time: s.timestamp,
    frameIntervalMs: s.state === "playing" ? s.frameIntervalMs : null,
    decodeTimeMs: s.state === "playing" ? s.decodeTimeMs : null,
  }));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTimeAxis(_timestampMs: number): string {
  return ""; // auto-formatted by Recharts with number type
}

function formatTooltipTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString();
}

function formatFpsTick(fps: number): string {
  return fps >= 10 ? String(Math.round(fps)) : fps.toFixed(1);
}

function formatMsTick(ms: number): string {
  return ms >= 1 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`;
}

// ─── Custom tooltips ────────────────────────────────────────────────────────

function FrameRateTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { payload: FrameRatePoint }[];
  label?: number;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-standard border border-border-subtle bg-surface-3 p-2 text-xs shadow-md">
      <div className="mb-1 text-text-muted">{formatTooltipTime(label ?? 0)}</div>
      <div className="space-y-0.5">
        <div className="flex justify-between gap-3">
          <span className="text-text-secondary">Displayed FPS</span>
          <span className="font-mono tabular-nums text-text-primary">
            {d.displayedFps != null ? `${d.displayedFps.toFixed(1)}` : "\u2014"}
          </span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-text-secondary">Decoded FPS</span>
          <span className="font-mono tabular-nums text-text-primary">
            {d.decodedFps != null ? `${d.decodedFps.toFixed(1)}` : "\u2014"}
          </span>
        </div>
      </div>
    </div>
  );
}

function FrameTimeTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { payload: FrameTimePoint }[];
  label?: number;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-standard border border-border-subtle bg-surface-3 p-2 text-xs shadow-md">
      <div className="mb-1 text-text-muted">{formatTooltipTime(label ?? 0)}</div>
      <div className="space-y-0.5">
        <div className="flex justify-between gap-3">
          <span className="text-text-secondary">Frame interval</span>
          <span className="font-mono tabular-nums text-text-primary">
            {d.frameIntervalMs != null ? `${d.frameIntervalMs.toFixed(1)} ms` : "\u2014"}
          </span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-text-secondary">Decode time</span>
          <span className="font-mono tabular-nums text-text-primary">
            {d.decodeTimeMs != null ? `${d.decodeTimeMs.toFixed(1)} ms` : "\u2014"}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Empty state ────────────────────────────────────────────────────────────

function EmptyGraph({ label }: { label: string }) {
  return (
    <div className="h-32 flex items-center justify-center text-sm text-text-muted">
      {label}
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export function FramePerformanceGraph({
  samples,
  maxSamples = 120,
}: FramePerformanceGraphProps) {
  const frameRateData = useMemo(
    () => prepareFrameRateData(samples, maxSamples),
    [samples, maxSamples],
  );
  const frameTimeData = useMemo(
    () => prepareFrameTimeData(samples, maxSamples),
    [samples, maxSamples],
  );

  const hasRateData = frameRateData.some((d) => d.displayedFps != null || d.decodedFps != null);
  const hasTimeData = frameTimeData.some((d) => d.frameIntervalMs != null || d.decodeTimeMs != null);

  return (
    <Tabs defaultValue="frame-rate">
      <TabsList className="mb-1">
        <TabsTrigger value="frame-rate">Frame rate</TabsTrigger>
        <TabsTrigger value="frame-time">Frame time</TabsTrigger>
      </TabsList>

      {/* ── Frame rate tab ── */}
      <TabsContent value="frame-rate">
        {!hasRateData ? (
          <EmptyGraph label="No frame rate data yet." />
        ) : (
          <div className="h-32">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={frameRateData}
                margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--color-border)"
                />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={formatTimeAxis}
                  tick={{ fontSize: 11 }}
                  stroke="var(--color-text-muted)"
                />
                <YAxis
                  tickFormatter={formatFpsTick}
                  tick={{ fontSize: 11 }}
                  stroke="var(--color-text-muted)"
                  label={{
                    value: "FPS",
                    angle: -90,
                    position: "insideLeft",
                    style: { fontSize: 11, fill: "var(--color-text-muted)" },
                  }}
                />
                <RechartsTooltip content={<FrameRateTooltip />} />

                {/* Primary: displayed FPS */}
                <Area
                  type="monotone"
                  dataKey="displayedFps"
                  name="Displayed FPS"
                  stroke="var(--color-accent)"
                  fill="var(--color-accent)"
                  fillOpacity={0.08}
                  isAnimationActive={false}
                  dot={false}
                  strokeWidth={2}
                  connectNulls={false}
                />

                {/* Secondary: decoded FPS */}
                <Area
                  type="monotone"
                  dataKey="decodedFps"
                  name="Decoded FPS"
                  stroke="var(--color-text-muted)"
                  fill="var(--color-text-muted)"
                  fillOpacity={0.04}
                  isAnimationActive={false}
                  dot={false}
                  strokeWidth={1}
                  strokeDasharray="4 3"
                  connectNulls={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </TabsContent>

      {/* ── Frame time tab ── */}
      <TabsContent value="frame-time">
        {!hasTimeData ? (
          <EmptyGraph label="No frame time data yet." />
        ) : (
          <div className="h-32">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={frameTimeData}
                margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--color-border)"
                />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={formatTimeAxis}
                  tick={{ fontSize: 11 }}
                  stroke="var(--color-text-muted)"
                />
                <YAxis
                  tickFormatter={formatMsTick}
                  tick={{ fontSize: 11 }}
                  stroke="var(--color-text-muted)"
                  label={{
                    value: "ms",
                    angle: -90,
                    position: "insideLeft",
                    style: { fontSize: 11, fill: "var(--color-text-muted)" },
                  }}
                />
                <RechartsTooltip content={<FrameTimeTooltip />} />

                {/* Primary: frame interval */}
                <Area
                  type="monotone"
                  dataKey="frameIntervalMs"
                  name="Frame interval"
                  stroke="var(--color-accent)"
                  fill="var(--color-accent)"
                  fillOpacity={0.08}
                  isAnimationActive={false}
                  dot={false}
                  strokeWidth={2}
                  connectNulls={false}
                />

                {/* Secondary: decode time */}
                <Area
                  type="monotone"
                  dataKey="decodeTimeMs"
                  name="Decode time"
                  stroke="var(--color-text-muted)"
                  fill="var(--color-text-muted)"
                  fillOpacity={0.04}
                  isAnimationActive={false}
                  dot={false}
                  strokeWidth={1}
                  strokeDasharray="4 3"
                  connectNulls={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}
