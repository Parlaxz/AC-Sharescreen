// SPDX-License-Identifier: MIT
/**
 * EnhancedVideoSurface — React component that owns the WebGL2 canvas and
 * coordinates the GPU image enhancement pipeline.
 *
 * When the environment does not support WebGL2 or the pipeline encounters
 * an unrecoverable error, the component renders nothing (null), allowing
 * the parent to fall back to a native <video> element.
 */

import {
  useRef,
  useEffect,
  useState,
  useCallback,
  type ReactElement,
} from "react";
import { cn } from "@/lib/utils";
import type { ViewerImageEnhancementSettings } from "@/services/viewer-image-processing/viewer-image-settings";
import type {
  ProcessorState,
  ProcessorStats,
} from "@/services/viewer-image-processing/viewer-image-processor";
import { ViewerImageProcessor } from "@/services/viewer-image-processing/viewer-image-processor";
import { getImageProcessingCapabilities, augmentWithNvidiaCapability } from "@/services/viewer-image-processing/viewer-image-capabilities";
import { createImageProcessingBackend } from "@/services/viewer-image-processing/viewer-image-backend-factory";

// ─── Props ───────────────────────────────────────────────────────────────────

export interface EnhancedVideoSurfaceProps {
  /** The source <video> element to capture frames from */
  videoElement: HTMLVideoElement | null;
  /** Master toggle — when false the pipeline is paused / hidden */
  enabled: boolean;
  /** Current enhancement settings (updated live via effect) */
  settings: ViewerImageEnhancementSettings;
  /** Optional CSS class names forwarded to the container */
  className?: string;
  /** Fired when the processor state changes */
  onProcessorStateChange?: (state: ProcessorState) => void;
  /** Fired on unrecoverable processing error */
  onProcessingError?: (reason: string) => void;
  /** Fired after a WebGL context restore so the parent can retry */
  onContextRestored?: () => void;
  /** Fired on the first successfully processed frame */
  onFirstFrame?: () => void;
  /** Fired periodically (~500 ms) with processing statistics */
  onStatsUpdate?: (stats: ProcessorStats) => void;
  /** Called when the active backend changes (including fallback) */
  onBackendChange?: (effective: string, fallbackReason?: string) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function EnhancedVideoSurface({
  videoElement,
  enabled,
  settings,
  className,
  onProcessorStateChange,
  onProcessingError,
  onContextRestored,
  onFirstFrame,
  onStatsUpdate,
  onBackendChange,
}: EnhancedVideoSurfaceProps): ReactElement | null {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const processorRef = useRef<ViewerImageProcessor | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const prevEnabledRef = useRef<boolean>(enabled);
  const prevSettingsRef = useRef<ViewerImageEnhancementSettings | null>(null);

  const [processorState, setProcessorState] = useState<ProcessorState>("idle");
  const [fallback, setFallback] = useState<boolean>(false);
  const [firstFrameReceived, setFirstFrameReceived] = useState(false);

  // ─── Capabilities check on mount (async IPC probe) ────────────────────

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const caps = getImageProcessingCapabilities();
        if (!caps.webgl2Available) {
          if (!cancelled) {
            setFallback(true);
            onProcessingError?.("WebGL2 is not available in this browser");
          }
          return;
        }

        // Probe NVIDIA VSR availability from main process
        await augmentWithNvidiaCapability();
      } catch {
        if (!cancelled) {
          setFallback(true);
          onProcessingError?.("Failed to detect image processing capabilities");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Reset fallback / first-frame state when re-enabled ──────────────

  useEffect(() => {
    setFirstFrameReceived(false);
    if (enabled) {
      setFallback(false);
    }
  }, [enabled]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleContextRestored = () => {
      setFirstFrameReceived(false);
      setFallback(false);
      onContextRestored?.();
    };

    canvas.addEventListener("webglcontextrestored", handleContextRestored);
    return () => {
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
    };
  }, [onContextRestored]);

  // ─── Processor initialisation (async, with backend factory) ──────────

  useEffect(() => {
    if (!enabled || fallback || !videoElement || !canvasRef.current) return;

    let processor: ViewerImageProcessor | null = null;
    let cancelled = false;

    (async () => {
      try {
        // Create the appropriate backend based on settings + capabilities
        const { backend, effective, fallbackReason } =
          createImageProcessingBackend(settings);

        // Notify parent of backend selection
        onBackendChange?.(effective, fallbackReason);

        if (cancelled) {
          await backend.destroy();
          return;
        }

        processor = new ViewerImageProcessor(
          canvasRef.current!,
          videoElement,
          backend,
        );

        const handleFirstFrame = () => {
          setFirstFrameReceived(true);
          onFirstFrame?.();
        };

        processor.setCallbacks({
          onStateChange: (state: ProcessorState) => {
            setProcessorState(state);
            onProcessorStateChange?.(state);
          },
          onError: (reason: string) => {
            setFirstFrameReceived(false);
            setFallback(true);
            onProcessingError?.(reason);
          },
          onFirstFrame: handleFirstFrame,
          onStatsUpdate: (stats: ProcessorStats) => {
            onStatsUpdate?.(stats);
          },
        });

        processor.start(settings);
        processorRef.current = processor;
      } catch (err) {
        if (!cancelled) {
          setFallback(true);
          onProcessingError?.(
            err instanceof Error
              ? err.message
              : "Failed to create processing backend",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      if (processor) {
        processor.destroy();
        processorRef.current = null;
      }
    };
  }, [enabled, fallback, videoElement]); // intentionally limited deps

  // ─── Backend switching on processingBackend change ────────────────────

  useEffect(() => {
    const prev = prevSettingsRef.current;
    prevSettingsRef.current = settings;

    if (!processorRef.current || !prev) return;

    if (prev.processingBackend !== settings.processingBackend) {
      const proc = processorRef.current;
      try {
        const { backend, effective, fallbackReason } =
          createImageProcessingBackend(settings);
        onBackendChange?.(effective, fallbackReason);
        proc.setBackend(backend);
        proc.updateSettings(settings);
      } catch (err) {
        onProcessingError?.(
          err instanceof Error
            ? err.message
            : "Failed to switch backend",
        );
      }
    }
  }, [settings]);

  // ─── Live settings update (non-backend changes) ───────────────────────

  useEffect(() => {
    if (!processorRef.current) return;
    processorRef.current.updateSettings(settings);
  }, [settings]);

  // ─── Pause / resume on enabled toggle ─────────────────────────────────

  useEffect(() => {
    const wasEnabled = prevEnabledRef.current;
    prevEnabledRef.current = enabled;

    const proc = processorRef.current;
    if (!proc) return;

    if (enabled && !wasEnabled) {
      if (proc.getState() === "paused") {
        proc.resume();
      }
    } else if (!enabled && wasEnabled) {
      if (proc.getState() === "running") {
        proc.pause();
      }
    }
  }, [enabled]);

  // ─── ResizeObserver for container sizing ──────────────────────────────

  const handleResize = useCallback(() => {
    const proc = processorRef.current;
    const container = containerRef.current;
    if (!proc || !container) return;

    const { width, height } = container.getBoundingClientRect();
    if (width > 0 && height > 0) {
      proc.resizeOutput(width, height);
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      handleResize();
    });

    observer.observe(container);
    resizeObserverRef.current = observer;

    // Initial sizing
    handleResize();

    return () => {
      observer.disconnect();
      resizeObserverRef.current = null;
    };
  }, [handleResize]);

  // ─── Render ───────────────────────────────────────────────────────────

  const canvasVisible =
    enabled &&
    !fallback &&
    firstFrameReceived &&
    (processorState === "running" || processorState === "paused");

  return (
    <div
      ref={containerRef}
      className={cn("absolute inset-0 overflow-hidden", className)}
    >
      <canvas
        ref={canvasRef}
        data-enhanced-canvas
        className="h-full w-full object-contain"
        style={{
          display: canvasVisible ? "block" : "none",
        }}
      />
    </div>
  );
}
