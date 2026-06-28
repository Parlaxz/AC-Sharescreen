export type ImageProcessingBackend = "webgl2" | "native" | "unavailable";

export interface ImageProcessingCapabilities {
  backend: ImageProcessingBackend;
  webgl2Available: boolean;
  webgl2MaxTextureSize: number;
  webgl2MaxRenderbufferSize: number;
  webgl2Extensions: string[];
  requestVideoFrameCallbackAvailable: boolean;
  extDisjointTimerQueryAvailable: boolean;
  /** Whether NVIDIA RTX VSR is available (Windows x64 with RTX GPU) */
  nvidiaVsrAvailable: boolean;
  /** Human-readable reason when NVIDIA VSR is unavailable */
  nvidiaVsrReason?: string;
  /** GPU adapter name when detectable */
  adapterName?: string;
}

let cachedCapabilities: ImageProcessingCapabilities | null = null;

/**
 * Augment the cached capabilities with NVIDIA RTX VSR availability
 * probed from the main process via IPC.
 *
 * This is an async augmentation — the IPC round-trip happens after
 * the synchronous capability detection. The result is merged into
 * the cached capabilities object so subsequent factory calls see it.
 *
 * Safe to call even if IPC is unavailable (no-op in that case).
 */
export async function augmentWithNvidiaCapability(): Promise<void> {
  try {
    const api = (globalThis as Record<string, unknown>).screenlink as
      | { probeNvidiaVsrCapability?: () => Promise<{ available: boolean; reason: string; adapterName?: string }> }
      | undefined;
    if (!api?.probeNvidiaVsrCapability) return;

    const result = await api.probeNvidiaVsrCapability();

    if (cachedCapabilities) {
      cachedCapabilities.nvidiaVsrAvailable = result.available;
      cachedCapabilities.nvidiaVsrReason = result.reason;
      if (result.adapterName) {
        cachedCapabilities.adapterName = result.adapterName;
      }
    }
  } catch {
    // IPC unavailable — NVIDIA VSR stays at default (false)
  }
}

/**
 * Detects the image processing capabilities of the current browser environment.
 * Creates a hidden canvas and attempts to acquire a WebGL2 context to probe
 * GPU limits and extension support. Safe to call multiple times — results are
 * memoized after the first invocation.
 */
export function detectViewerImageCapabilities(): ImageProcessingCapabilities {
  if (cachedCapabilities !== null) {
    return cachedCapabilities;
  }

  const capabilities = probeCapabilities();
  cachedCapabilities = capabilities;
  return capabilities;
}

/**
 * Singleton accessor for the cached capabilities result.
 */
export function getImageProcessingCapabilities(): ImageProcessingCapabilities {
  return detectViewerImageCapabilities();
}

function probeCapabilities(): ImageProcessingCapabilities {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");

  if (!gl) {
    return {
      backend: "unavailable",
      webgl2Available: false,
      webgl2MaxTextureSize: 0,
      webgl2MaxRenderbufferSize: 0,
      webgl2Extensions: [],
      requestVideoFrameCallbackAvailable:
        typeof HTMLVideoElement.prototype.requestVideoFrameCallback === "function",
      extDisjointTimerQueryAvailable: false,
      nvidiaVsrAvailable: false,
      nvidiaVsrReason: "WebGL2 unavailable on this device",
    };
  }

  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number;
  const extensions = gl.getSupportedExtensions() ?? [];

  const extDisjointTimerQuery =
    gl.getExtension("EXT_disjoint_timer_query_webgl2") !== null;

  // Clean up the test context
  const loseContextExt = gl.getExtension("WEBGL_lose_context");
  loseContextExt?.loseContext();

  // Attempt to get GPU adapter name for NVIDIA VSR detection hint
  let adapterName: string | undefined;

  return {
    backend: "webgl2",
    webgl2Available: true,
    webgl2MaxTextureSize: maxTextureSize,
    webgl2MaxRenderbufferSize: maxRenderbufferSize,
    webgl2Extensions: extensions,
    requestVideoFrameCallbackAvailable:
      typeof HTMLVideoElement.prototype.requestVideoFrameCallback === "function",
    extDisjointTimerQueryAvailable: extDisjointTimerQuery,
    // NVIDIA VSR detection will be enhanced in Phase 4 via IPC/GPU adapter query
    nvidiaVsrAvailable: false,
    nvidiaVsrReason:
      "NVIDIA VSR detection requires native IPC probe (Phase 4)",
    adapterName,
  };
}


