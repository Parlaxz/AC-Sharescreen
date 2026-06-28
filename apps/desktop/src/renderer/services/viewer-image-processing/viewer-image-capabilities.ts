export type ImageProcessingBackend = "webgl2" | "native" | "unavailable";

export interface ImageProcessingCapabilities {
  backend: ImageProcessingBackend;
  webgl2Available: boolean;
  webgl2MaxTextureSize: number;
  webgl2MaxRenderbufferSize: number;
  webgl2Extensions: string[];
  requestVideoFrameCallbackAvailable: boolean;
  extDisjointTimerQueryAvailable: boolean;
}

let cachedCapabilities: ImageProcessingCapabilities | null = null;

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

  return {
    backend: "webgl2",
    webgl2Available: true,
    webgl2MaxTextureSize: maxTextureSize,
    webgl2MaxRenderbufferSize: maxRenderbufferSize,
    webgl2Extensions: extensions,
    requestVideoFrameCallbackAvailable:
      typeof HTMLVideoElement.prototype.requestVideoFrameCallback === "function",
    extDisjointTimerQueryAvailable: extDisjointTimerQuery,
  };
}
