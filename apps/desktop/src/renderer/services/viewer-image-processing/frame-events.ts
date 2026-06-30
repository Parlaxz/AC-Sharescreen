// SPDX-License-Identifier: MIT
/**
 * frame-events.ts
 *
 * Immutable per-frame event type owned by the processing layer.
 * Emitted by ViewerImageProcessor for each frame lifecycle event
 * (completion, presentation, drop) and consumed by the benchmark
 * service for event-driven scenario collection.
 *
 * All fields are readonly — once emitted, events are immutable.
 */

import type { BackendKind } from "./viewer-image-backend";
import type { NvidiaProcessingMode } from "@screenlink/shared";

// ─── Frame event ─────────────────────────────────────────────────────────────

export interface FrameEvent {
  /** Client identity (from NVIDIA client lease, if available). */
  readonly clientId?: string;

  /** Monotonic generation counter (incremented on start/restart/stream switch). */
  readonly generation: number;

  /** Monotonic frame sequence number within generation. */
  readonly sequence: number;

  /** Source media time (video.currentTime at capture start), if available. */
  readonly sourceMediaTime?: number;

  /** Configuration identity from applied config. 0 when unknown/unavailable. */
  readonly configurationId: number;

  /** Active processing backend. */
  readonly backend: BackendKind;

  /** NVIDIA processing mode (only meaningful when backend is nvidia-vsr). */
  readonly nvidiaMode?: NvidiaProcessingMode;

  /** Canonical QualityLevel integer. null for non-NVIDIA backends. */
  readonly canonicalQualityLevel: number | null;

  /** Input (source) pixel dimensions at capture time. */
  readonly inputWidth: number;

  /** Input (source) pixel dimensions at capture time. */
  readonly inputHeight: number;

  /** Output (processed) pixel dimensions. */
  readonly outputWidth: number;

  /** Output (processed) pixel dimensions. */
  readonly outputHeight: number;

  /** How the frame was captured from the video source. */
  readonly capturePath: "canvas-2d-drawimage" | "webgl-texsubimage2d" | "message-port";

  /** How the frame was transported to the native processor. */
  readonly transportPath: "invoke" | "message-port" | "none";

  /** How the result was presented to the display. */
  readonly presentationPath: "webgl-texture-upload" | "native-presenter" | "fallback-cpu";

  // ─── Absolute timestamps (performance.now) ───────────────────────────
  /** When the frame capture started (renderer-side). */
  readonly captureStartedAt: number;

  /** When the frame was submitted to the native processor. */
  readonly submittedAt?: number;

  /** When native processing completed (from frame header or renderer-observed). */
  readonly nativeCompletedAt?: number;

  /** When the frame was presented (WebGL draw or native presenter ack). */
  readonly presentedAt?: number;

  // ─── Per-stage durations (ms) ────────────────────────────────────────
  /** Duration of the capture phase (drawImage + getImageData or texSubImage2D). */
  readonly captureDurationMs: number;

  /** Duration of IPC transport to native processor. */
  readonly transportDurationMs?: number;

  /** Duration of native VSR processing (renderer-observed round-trip or header). */
  readonly nativeProcessingDurationMs?: number;

  /** Duration of the presentation / upload phase. */
  readonly presentationDurationMs?: number;

  /** Total latency from capture start to presentation (ms). */
  readonly totalLatencyMs?: number;

  // ─── Lifecycle flags ─────────────────────────────────────────────────
  /** True when the frame was fully processed and (for WebGL) presented. */
  readonly completed: boolean;

  /** True when the frame was presented to the display. */
  readonly presented: boolean;

  /** True when this frame belongs to a stale generation. */
  readonly stale: boolean;

  /** Human-readable reason when the frame was skipped/dropped. */
  readonly dropReason?: "backpressure" | "stale-generation" | "stale-config" | "transient" | "failure";

  /** Raw timing breakdown from backend, if available. */
  readonly timingBreakdown?: Record<string, number | undefined>;
}

// ─── Listener type ───────────────────────────────────────────────────────────

export type FrameEventListener = (event: FrameEvent) => void;

// ─── Config-applied event ────────────────────────────────────────────────────

export interface ConfigAppliedEvent {
  /** The configuration id that was applied. */
  readonly configurationId: number;

  /** Active backend after config application. */
  readonly backend: BackendKind;

  /** NVIDIA processing mode (only when backend is nvidia-vsr). */
  readonly nvidiaMode?: NvidiaProcessingMode;

  /** Canonical QualityLevel from the applied config. */
  readonly canonicalQualityLevel: number | null;

  /** Output width from the applied config. */
  readonly outputWidth: number;

  /** Output height from the applied config. */
  readonly outputHeight: number;

  /** The generation counter at the time of config application. */
  readonly generation: number;
}

export type ConfigAppliedListener = (event: ConfigAppliedEvent) => void;
