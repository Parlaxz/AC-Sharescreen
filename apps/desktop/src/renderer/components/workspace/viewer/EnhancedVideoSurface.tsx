// SPDX-License-Identifier: MIT
/**
 * EnhancedVideoSurface — React component that owns the WebGL2 canvas and
 * coordinates the GPU image enhancement pipeline.
 *
 * When the environment does not support WebGL2 or the pipeline encounters
 * an unrecoverable error, the component renders nothing (null), allowing
 * the parent to fall back to a native <video> element.
 *
 * DEV-only feature: holding the B key hides the enhanced canvas to reveal
 * the original video beneath (A/B compare). Release B to restore.
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
import type { ViewerImageBackend } from "@/services/viewer-image-processing/viewer-image-backend";
import type {
  ProcessorState,
  ProcessorStats,
} from "@/services/viewer-image-processing/viewer-image-processor";
import { ViewerImageProcessor } from "@/services/viewer-image-processing/viewer-image-processor";
import type { ProcessorAPI } from "@/services/viewer-image-processing/processor-api";
import { getImageProcessingCapabilities, augmentWithNvidiaCapability } from "@/services/viewer-image-processing/viewer-image-capabilities";
import { createImageProcessingBackend } from "@/services/viewer-image-processing/viewer-image-backend-factory";
import { FallbackChainController } from "@/services/viewer-image-processing/fallback-chain-controller";
import {
  nextMonotonicId,
  lifecycleLog,
  enableLifecycleLogging,
} from "@/services/viewer-image-processing/lifecycle-id";

// Enable lifecycle logging in dev builds
if (typeof import.meta !== "undefined" && import.meta.env.DEV) {
  enableLifecycleLogging();
}

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

  /**
   * Mutable ref filled in by the component when the processor is created.
   * Provides subscribeFrameEvents and waitForConfigApplied for benchmark
   * orchestration.  Cleared to null when the processor is destroyed.
   */
  processorApiRef?: React.MutableRefObject<ProcessorAPI | null>;
  presentationMode?: "default" | "dom-only";
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
  processorApiRef,
  presentationMode = "default",
}: EnhancedVideoSurfaceProps): ReactElement | null {
  const instanceId = useRef<number>(nextMonotonicId());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const processorRef = useRef<ViewerImageProcessor | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const prevVideoElementRef = useRef<HTMLVideoElement | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const prevEnabledRef = useRef<boolean>(enabled);
  const prevSettingsRef = useRef<ViewerImageEnhancementSettings | null>(null);
  const chainRef = useRef<FallbackChainController | null>(null);
  const backendSignalledRef = useRef(false);

  const [processorState, setProcessorState] = useState<ProcessorState>("idle");
  const [fallback, setFallback] = useState<boolean>(false);
  const [firstFrameReceived, setFirstFrameReceived] = useState(false);

  // ─── Cleanup reason detection refs (updated during render) ────────────
  // Must be declared AFTER useState calls to avoid temporal-dead-zone on fallback.
  const _mountedRef = useRef(true);
  const _renderEnabledRef = useRef(enabled);
  const _renderVideoRef = useRef<HTMLVideoElement | null>(null);
  const _renderFallbackRef = useRef(fallback);

  // Track current render-phase values so the old effect cleanup can compare
  // closure-captured values against the incoming values to determine exactly
  // which dependency caused the effect to re-run.
  _renderEnabledRef.current = enabled;
  _renderVideoRef.current = videoElement;
  _renderFallbackRef.current = fallback;

  // ─── Capabilities check on mount (async IPC probe) ────────────────────

  useEffect(() => {
    let cancelled = false;

    lifecycleLog("Surface", "mount", {
      instanceId: instanceId.current,
    });

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
      lifecycleLog("Surface", "unmount", {
        instanceId: instanceId.current,
      });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Reset fallback / first-frame state when re-enabled ──────────────

  useEffect(() => {
    setFirstFrameReceived(false);
    if (enabled) {
      setFallback(false);
    }
  }, [enabled]);

  // ─── Log fallback changes ────────────────────────────────────────────

  useEffect(() => {
    if (fallback) {
      lifecycleLog("Surface", "fallbackChange", {
        instanceId: instanceId.current,
        fallback: true,
      });
    }
  }, [fallback]);

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

  // ─── Mount status tracking for cleanup reason detection ───────────────
  // On component unmount this cleanup runs BEFORE the processor effect's cleanup
  // (declaration order), so _mountedRef is already false when the processor
  // cleanup checks it.
  useEffect(() => {
    _mountedRef.current = true;
    return () => {
      _mountedRef.current = false;
    };
  }, []);

  // ─── Processor initialisation (async, with backend factory) ──────────

  useEffect(() => {
    if (!enabled || fallback || !videoElement || !canvasRef.current) return;

    // Detect videoElement identity change
    const prevVideo = prevVideoElementRef.current;
    if (prevVideo !== videoElement) {
      lifecycleLog("Surface", "videoElementChange", {
        instanceId: instanceId.current,
        prevVideoElement: prevVideo !== null,
        newVideoElement: true,
      });
      prevVideoElementRef.current = videoElement;
    }

    let processor: ViewerImageProcessor | null = null;
    let cancelled = false;

    (async () => {
      try {
        // Create the appropriate backend based on settings + capabilities.
        // No retry loop: a single failure immediately falls back.
        const result = createImageProcessingBackend(settings, undefined, {
          preferDomPresentation: presentationMode === "dom-only",
        });
        const backend = result.backend;
        const effective = result.effective;
        const fallbackReason = result.fallbackReason;
        const chainController = result.chainController ?? null;

        chainRef.current = chainController;
        backendSignalledRef.current = false;

        processor = new ViewerImageProcessor(
          canvasRef.current!,
          videoElement,
          backend,
        );

        lifecycleLog("Surface", "processorCreated", {
          instanceId: instanceId.current,
          processorInstanceId: processor.instanceId,
          videoElementIdentity: videoElement !== null,
          backendKind: backend.kind,
        });

        const handleFirstFrame = () => {
          setFirstFrameReceived(true);
          onFirstFrame?.();
          // Signal backend only after first visible frame (audit item 17)
          onBackendChange?.(effective, fallbackReason);
          backendSignalledRef.current = true;
        };

        const handleError = (reason: string) => {
          setFirstFrameReceived(false);
          // Try advancing the fallback chain if available (audit item 19)
          if (chainRef.current && chainRef.current.activeStage !== "original") {
            chainRef.current.advance(reason).then(() => {
              const stage = chainRef.current!.activeStage;
              const nextBackend = chainRef.current!.activeBackend;
              onBackendChange?.(
                stage === "nvidia-vsr" ? "nvidia-vsr" : "webgl2",
                reason,
              );
              // Swap the processor's backend to the fallback (NVIDIA → WebGL2)
              if (processorRef.current && nextBackend) {
                processorRef.current
                  .setBackend(nextBackend)
                  .catch(() => {
                    setFallback(true);
                    onProcessingError?.(reason);
                  });
              }
            }).catch(() => {
              setFallback(true);
              onProcessingError?.(reason);
            });
          } else {
            setFallback(true);
            onProcessingError?.(reason);
          }
        };

        processor.setCallbacks({
          onStateChange: (state: ProcessorState) => {
            setProcessorState(state);
            onProcessorStateChange?.(state);
          },
          onError: handleError,
          onFirstFrame: handleFirstFrame,
          onStatsUpdate: (stats: ProcessorStats) => {
            if (chainRef.current && stats.framesDisplayed > 0) {
              chainRef.current.recordSuccess();
            }
            onStatsUpdate?.(stats);
          },
        });

        processor.start(settings);
        processorRef.current = processor;

        // Populate the processor API ref so the parent can subscribe
        // to frame events and config-applied events for benchmarks.
        if (processorApiRef) {
          processorApiRef.current = {
            subscribeFrameEvents: (listener) => processor!.subscribeFrameEvents(listener),
            waitForConfigApplied: (timeoutMs = 5000) => {
              return new Promise<import("@/services/viewer-image-processing/frame-events").ConfigAppliedEvent | null>((resolve) => {
                if (!processor) {
                  resolve(null);
                  return;
                }
                const unsub = processor.subscribeConfigApplied((event) => {
                  unsub();
                  clearTimeout(timer);
                  resolve(event);
                });
                const timer = setTimeout(() => {
                  unsub();
                  resolve(null);
                }, timeoutMs);
              });
            },
          };
        }
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
        // Compare closure-captured (old) values against render-phase refs (new)
        // to determine exactly which dependency caused the re-run.
        // _mountedRef is set to false by the mount-tracking effect's cleanup
        // on component unmount (runs before this cleanup due to declaration order).
        let destroyReason: string;
        if (!_mountedRef.current) {
          destroyReason = "component-unmount";
        } else if (videoElement !== _renderVideoRef.current) {
          destroyReason = "video-element-changed";
        } else if (enabled !== _renderEnabledRef.current) {
          destroyReason = "enabled-disabled";
        } else if (fallback !== _renderFallbackRef.current) {
          destroyReason = "fallback-activated";
        } else {
          destroyReason = "initialization-effect-cleanup";
        }

        lifecycleLog("Surface", "processorDestroy", {
          instanceId: instanceId.current,
          processorInstanceId: processor.instanceId,
          reason: destroyReason,
          prevEnabled: enabled,
          currEnabled: _renderEnabledRef.current,
          prevFallback: fallback,
          currFallback: _renderFallbackRef.current,
          prevVideoPresent: videoElement !== null,
          currVideoPresent: _renderVideoRef.current !== null,
        });
        processor.destroy(destroyReason).catch(() => {});
        processorRef.current = null;
        if (processorApiRef) {
          processorApiRef.current = null;
        }
      }
    };
  }, [enabled, fallback, videoElement]); // intentionally limited deps — no retryAttempt

  // ─── Backend switching on processingBackend change ────────────────────

  useEffect(() => {
    const prev = prevSettingsRef.current;
    prevSettingsRef.current = settings;

    if (!processorRef.current || !prev) return;

    if (prev.processingBackend !== settings.processingBackend) {
      const proc = processorRef.current;
      try {
        const { backend, effective, fallbackReason } =
          createImageProcessingBackend(settings, undefined, {
            preferDomPresentation: presentationMode === "dom-only",
          });
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
  }, [settings, presentationMode, onBackendChange, onProcessingError]);

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
      lifecycleLog("Surface", "enabledChange", {
        instanceId: instanceId.current,
        previous: false,
        current: true,
      });
      if (proc.getState() === "paused") {
        proc.resume();
      }
    } else if (!enabled && wasEnabled) {
      lifecycleLog("Surface", "enabledChange", {
        instanceId: instanceId.current,
        previous: true,
        current: false,
      });
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

  // ─── DEV-only hold-B compare (Phase 1) ──────────────────────────────────
  // Holding B hides only the enhanced canvas to reveal original video beneath.
  // Must not pause, reconfigure, recreate, destroy, or restart processor/backend.
  const [holdBCompare, setHoldBCompare] = useState(false);

  useEffect(() => {
    // Guard: only active in DEV mode
    if (typeof import.meta !== "undefined" && !import.meta.env.DEV) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "KeyB" && !e.repeat) {
        setHoldBCompare(true);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "KeyB") {
        setHoldBCompare(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  const isDevCompare =
    typeof import.meta !== "undefined" && import.meta.env.DEV && holdBCompare;

  // ─── Render ───────────────────────────────────────────────────────────

  const canvasVisible =
    enabled &&
    !fallback &&
    firstFrameReceived &&
    (processorState === "running" || processorState === "paused") &&
    !isDevCompare;

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
      {/* DEV-only hold-B indicator — does not affect lifecycle */}
      {isDevCompare && (
        <div
          className="absolute top-2 left-2 bg-black/70 text-white text-[11px] px-2 py-1 rounded pointer-events-none z-50"
        >
          Hold B: Original
        </div>
      )}
    </div>
  );
}
