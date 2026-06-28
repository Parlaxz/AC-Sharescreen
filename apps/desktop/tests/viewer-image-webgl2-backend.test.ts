// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { WebGL2ViewerImageBackend } from "@/services/viewer-image-processing/webgl2-viewer-image-backend";
import type { ViewerImageEnhancementSettings } from "@/services/viewer-image-processing/viewer-image-settings";

type BackendInternals = WebGL2ViewerImageBackend & Record<string, unknown>;

function createFakeGl() {
  let nextId = 0;
  const uniformCalls: Array<{ location: string; value: unknown }> = [];
  const gl = {
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812f,
    RGBA8: 0x8058,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    TRIANGLES: 0x0004,
    QUERY_RESULT_AVAILABLE: 0x8867,
    QUERY_RESULT: 0x8866,
    UNPACK_FLIP_Y_WEBGL: 0x9240,
    createTexture: vi.fn(() => ({ kind: "texture", id: ++nextId })),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    texImage2D: vi.fn(),
    texSubImage2D: vi.fn(),
    pixelStorei: vi.fn(),
    deleteTexture: vi.fn(),
    createFramebuffer: vi.fn(() => ({ kind: "framebuffer", id: ++nextId })),
    bindFramebuffer: vi.fn(),
    framebufferTexture2D: vi.fn(),
    checkFramebufferStatus: vi.fn(() => 0x8cd5),
    deleteFramebuffer: vi.fn(),
    activeTexture: vi.fn(),
    viewport: vi.fn(),
    useProgram: vi.fn(),
    drawArrays: vi.fn(),
    uniform1i: vi.fn((location: string, value: unknown) => uniformCalls.push({ location, value })),
    uniform1f: vi.fn((location: string, value: unknown) => uniformCalls.push({ location, value })),
    uniform2f: vi.fn((location: string, x: number, y: number) => uniformCalls.push({ location, value: [x, y] })),
    getParameter: vi.fn(() => false),
    createQuery: vi.fn(() => ({ kind: "query", id: ++nextId })),
    beginQuery: vi.fn(),
    endQuery: vi.fn(),
    getQueryParameter: vi.fn(() => false),
    deleteQuery: vi.fn(),
    getTexLevelParameter: vi.fn(() => {
      throw new Error("getTexLevelParameter must not be used");
    }),
    uniformCalls,
  };
  return gl;
}

function createReadyVideo(width = 100, height = 50): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "videoWidth", { value: width, configurable: true });
  Object.defineProperty(video, "videoHeight", { value: height, configurable: true });
  Object.defineProperty(video, "readyState", {
    value: HTMLMediaElement.HAVE_CURRENT_DATA,
    configurable: true,
  });
  return video;
}

const allControls: ViewerImageEnhancementSettings = {
  enabled: true,
  enhancedScaling: true,
  sharpeningStrength: 0.77,
  chromaContribution: 0.66,
  artifactClamp: 0.55,
  textureNoiseSharpening: 0.44,
  antiRinging: 0.33,
  chromaCleanup: 0.22,
  deblocking: 0.11,
};

describe("WebGL2ViewerImageBackend resource tracking", () => {
  it("allocates upscale resources using tracked dimensions without getTexLevelParameter", () => {
    const backend = new WebGL2ViewerImageBackend() as BackendInternals;
    const gl = createFakeGl();
    backend.outputWidth = 200;
    backend.outputHeight = 100;

    (backend.ensureUpscaleResources as (gl: unknown) => void)(gl);

    expect(gl.getTexLevelParameter).not.toHaveBeenCalled();
    expect(gl.texImage2D).toHaveBeenCalledTimes(1);
    expect(backend.lastUpscaleWidth).toBe(200);
    expect(backend.lastUpscaleHeight).toBe(100);
  });

  it("reuses same-size upscale resources and recreates them when dimensions change", () => {
    const backend = new WebGL2ViewerImageBackend() as BackendInternals;
    const gl = createFakeGl();
    backend.outputWidth = 200;
    backend.outputHeight = 100;

    (backend.ensureUpscaleResources as (gl: unknown) => void)(gl);
    (backend.ensureUpscaleResources as (gl: unknown) => void)(gl);
    expect(gl.texImage2D).toHaveBeenCalledTimes(1);

    backend.outputWidth = 220;
    backend.outputHeight = 120;
    (backend.ensureUpscaleResources as (gl: unknown) => void)(gl);

    expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
    expect(gl.deleteFramebuffer).toHaveBeenCalledTimes(1);
    expect(gl.texImage2D).toHaveBeenCalledTimes(2);
    expect(backend.lastUpscaleWidth).toBe(220);
    expect(backend.lastUpscaleHeight).toBe(120);
  });
});

describe("WebGL2ViewerImageBackend output dimension tracking", () => {
  it("tracks output dimensions with lastOutputWidth/lastOutputHeight", () => {
    const backend = new WebGL2ViewerImageBackend() as BackendInternals;
    const gl = createFakeGl();
    backend.outputWidth = 200;
    backend.outputHeight = 100;

    // Simulate sharpen pass path — ensureOutputResources
    (backend.ensureOutputResources as (gl: unknown) => void)(gl);

    expect(backend.lastOutputWidth).toBe(200);
    expect(backend.lastOutputHeight).toBe(100);
    expect(gl.getTexLevelParameter).not.toHaveBeenCalled();
  });

  it("recreates output FBO when output dimensions change", () => {
    const backend = new WebGL2ViewerImageBackend() as BackendInternals;
    const gl = createFakeGl();
    backend.outputWidth = 200;
    backend.outputHeight = 100;

    // First allocation
    (backend.ensureOutputResources as (gl: unknown) => void)(gl);
    const texCallsAfterFirst = gl.texImage2D.mock.calls.length;
    expect(texCallsAfterFirst).toBeGreaterThan(0);

    // Same dimensions — no reallocation
    (backend.ensureOutputResources as (gl: unknown) => void)(gl);
    expect(gl.texImage2D).toHaveBeenCalledTimes(texCallsAfterFirst);

    // Different dimensions — should reallocate
    backend.outputWidth = 400;
    backend.outputHeight = 300;
    (backend.ensureOutputResources as (gl: unknown) => void)(gl);
    expect(gl.texImage2D).toHaveBeenCalledTimes(texCallsAfterFirst + 1);
    expect(backend.lastOutputWidth).toBe(400);
    expect(backend.lastOutputHeight).toBe(300);
  });

  it("releaseResources resets cleanup dimension trackers in GL branch", () => {
    const backend = new WebGL2ViewerImageBackend() as BackendInternals;
    const gl = createFakeGl();
    backend.gl = gl;
    backend.lastCleanupWidth = 640;
    backend.lastCleanupHeight = 480;
    backend.lastUpscaleWidth = 1280;
    backend.lastUpscaleHeight = 720;
    backend.lastOutputWidth = 1920;
    backend.lastOutputHeight = 1080;

    (backend.releaseResources as () => void)();

    expect(backend.lastCleanupWidth).toBe(0);
    expect(backend.lastCleanupHeight).toBe(0);
    expect(backend.lastUpscaleWidth).toBe(0);
    expect(backend.lastUpscaleHeight).toBe(0);
    expect(backend.lastOutputWidth).toBe(0);
    expect(backend.lastOutputHeight).toBe(0);
  });

  it("ensureOutputResources does not use getTexLevelParameter", () => {
    const backend = new WebGL2ViewerImageBackend() as BackendInternals;
    const gl = createFakeGl();
    backend.outputWidth = 200;
    backend.outputHeight = 100;

    (backend.ensureOutputResources as (gl: unknown) => void)(gl);

    expect(gl.getTexLevelParameter).not.toHaveBeenCalled();
  });
});

describe("WebGL2ViewerImageBackend frame behavior", () => {
  it("marks zero-size startup frames as transient", () => {
    const backend = new WebGL2ViewerImageBackend() as BackendInternals;
    backend.gl = createFakeGl();

    const result = backend.processFrame(createReadyVideo(0, 0));

    expect(result).toMatchObject({ success: false, transient: true });
  });

  it("maps every exposed control to its expected live uniform", () => {
    const backend = new WebGL2ViewerImageBackend() as BackendInternals;
    const gl = createFakeGl();
    backend.gl = gl;
    backend.outputWidth = 200;
    backend.outputHeight = 100;
    backend.fullscreenProgram = "fullscreen";
    backend.cleanupProgram = "cleanup";
    backend.easuProgram = "easu";
    backend.sharpenProgram = "sharpen";
    backend.cleanupUniforms = {
      u_sourceTexture: "cleanup.source",
      u_chromaCleanup: "cleanup.chromaCleanup",
      u_deblocking: "cleanup.deblocking",
      u_texSize: "cleanup.texSize",
    };
    backend.easuUniforms = {
      u_sourceTexture: "easu.source",
      u_sourceSize: "easu.sourceSize",
      u_outputSize: "easu.outputSize",
      u_enhancedScaling: "easu.enhancedScaling",
      u_antiRinging: "easu.antiRinging",
    };
    backend.sharpenUniforms = {
      u_sourceTexture: "sharpen.source",
      u_sharpeningStrength: "sharpen.sharpeningStrength",
      u_chromaContribution: "sharpen.chromaContribution",
      u_artifactClamp: "sharpen.artifactClamp",
      u_textureNoiseSharpening: "sharpen.textureNoiseSharpening",
      u_texSize: "sharpen.texSize",
    };
    backend.fullscreenUniforms = { u_sourceTexture: "fullscreen.source" };
    backend.updateSettings(allControls);

    const result = backend.processFrame(createReadyVideo());

    expect(result.success).toBe(true);
    expect(gl.uniformCalls).toEqual(
      expect.arrayContaining([
        { location: "cleanup.chromaCleanup", value: 0.22 },
        { location: "cleanup.deblocking", value: 0.11 },
        { location: "easu.enhancedScaling", value: 1 },
        { location: "easu.antiRinging", value: 0.33 },
        { location: "sharpen.sharpeningStrength", value: 0.77 },
        { location: "sharpen.chromaContribution", value: 0.66 },
        { location: "sharpen.artifactClamp", value: 0.55 },
        { location: "sharpen.textureNoiseSharpening", value: 0.44 },
      ]),
    );
  });

  it("zero optional effects skip cleanup, upscale, and sharpen effect passes", () => {
    const backend = new WebGL2ViewerImageBackend() as BackendInternals;
    const gl = createFakeGl();
    backend.gl = gl;
    backend.outputWidth = 100;
    backend.outputHeight = 50;
    backend.fullscreenProgram = "fullscreen";
    backend.fullscreenUniforms = { u_sourceTexture: "fullscreen.source" };
    backend.updateSettings({
      ...allControls,
      enhancedScaling: false,
      sharpeningStrength: 0,
      chromaCleanup: 0,
      deblocking: 0,
    });

    const result = backend.processFrame(createReadyVideo());

    expect(result.success).toBe(true);
    expect(gl.uniformCalls.map((call) => call.location)).not.toEqual(
      expect.arrayContaining([
        "cleanup.chromaCleanup",
        "cleanup.deblocking",
        "easu.enhancedScaling",
        "sharpen.sharpeningStrength",
      ]),
    );
    expect(gl.uniformCalls).toContainEqual({ location: "fullscreen.source", value: 0 });
  });
});

describe("WebGL2ViewerImageBackend timer queries", () => {
  it("disables timing diagnostics when native WebGL2 timer methods fail", () => {
    const backend = new WebGL2ViewerImageBackend() as BackendInternals;
    const gl = createFakeGl();
    gl.beginQuery.mockImplementationOnce(() => {
      throw new Error("timer unavailable");
    });
    backend.timerExt = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };
    backend.timerQueries = [{}, {}];

    expect(() => (backend.beginTimer as (gl: unknown) => void)(gl)).not.toThrow();

    expect(backend.timerExt).toBeNull();
    expect(backend.timerQueries).toEqual([]);
  });
});
