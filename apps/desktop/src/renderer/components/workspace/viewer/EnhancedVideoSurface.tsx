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
import { getImageProcessingCapabilities } from "@/services/viewer-image-processing/viewer-image-capabilities";

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
}: EnhancedVideoSurfaceProps): ReactElement | null {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const processorRef = useRef<ViewerImageProcessor | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const prevEnabledRef = useRef<boolean>(enabled);

  const [processorState, setProcessorState] = useState<ProcessorState>("idle");
  const [fallback, setFallback] = useState<boolean>(false);
  const [firstFrameReceived, setFirstFrameReceived] = useState(false);

  // ─── Capabilities check on mount ──────────────────────────────────────

  useEffect(() => {
    try {
      const caps = getImageProcessingCapabilities();
      if (!caps.webgl2Available) {
        setFallback(true);
        onProcessingError?.("WebGL2 is not available in this browser");
      }
    } catch {
      setFallback(true);
      onProcessingError?.("Failed to detect image processing capabilities");
    }
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

  // ─── Processor initialisation ─────────────────────────────────────────

  useEffect(() => {
    if (!enabled || fallback || !videoElement || !canvasRef.current) return;

    const processor = new ViewerImageProcessor(
      canvasRef.current,
      videoElement,
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

    return () => {
      processor.destroy();
      processorRef.current = null;
    };
  }, [enabled, fallback, videoElement]); // intentionally limited deps

  // ─── Live settings update ─────────────────────────────────────────────

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
