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
    NEAREST: 0x2600,
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
    COLOR_BUFFER_BIT: 0x4000,
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
    clearColor: vi.fn(),
    clear: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    scissor: vi.fn(),
    uniform1i: vi.fn((location: string, value: unknown) => uniformCalls.push({ location, value })),
    uniform1f: vi.fn((location: string, value: unknown) => uniformCalls.push({ location, value })),
    uniform2f: vi.fn((location: string, x: number, y: number) => uniformCalls.push({ location, value: [x, y] })),
    uniform4fv: vi.fn((location: string, value: Float32Array) => uniformCalls.push({ location, value: Array.from(value) })),
    getParameter: vi.fn(() => false),
    createQuery: vi.fn(() => ({ kind: "query", id: ++nextId })),
    beginQuery: vi.fn(),
    endQuery: vi.fn(),
    getQueryParameter: vi.fn(() => false),
    deleteQuery: vi.fn(),
    getTexLevelParameter: vi.fn(() => {
      throw new Error("getTexLevelParameter must not be used");
    }),
    getExtension: vi.fn(() => null),
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
  scalingAlgorithm: "bicubic",
  sharpeningStrength: 0.77,
  chromaContribution: 0.66,
  artifactClamp: 0.55,
  textureNoiseSharpening: 0.44,
  antiRinging: 0.33,
  chromaCleanup: 0.22,
  compressionSmoothing: 0.11,
};

describe("WebGL2ViewerImageBackend resource tracking", () => {
  it("allocates scale resources using render dimensions without getTexLevelParameter", () => {
    const backend = new WebGL2ViewerImageBackend() as BackendInternals;
    const gl = createFakeGl();
    backend.renderWidth = 200;
    backend.renderHeight = 100;

    (backend.ensureScaleResources as (gl: unknown) => void)(gl);

    expect(gl.getTexLevelParameter).not.toHaveBeenCalled();
    expect(gl.texImage2D).toHaveBeenCalledTimes(1);
    expect(backend.lastScaleWidth).toBe(200);
    expect(backend.lastScaleHeight).toBe(100);
  });

  it("reuses same-size scale resources and recreates them when dimensions change", () => {
    const backend = new WebGL2ViewerImageBackend() as BackendInternals;
    const gl = createFakeGl();
    backend.renderWidth = 200;
    backend.renderHeight = 100;

    (backend.ensureScaleResources as (gl: unknown) => void)(gl);
    (backend.ensureScaleResources as (gl: unknown) => void)(gl);
    expect(gl.texImage2D).toHaveBeenCalledTimes(1);

    backend.renderWidth = 220;
    backend.renderHeight = 120;
    (backend.ensureScaleResources as (gl: unknown) => void)(gl);

    expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
    expect(gl.deleteFramebuffer).toHaveBeenCalledTimes(1);
    expect(gl.texImage2D).toHaveBeenCalledTimes(2);
    expect(backend.lastScaleWidth).toBe(220);
    expect(backend.lastScaleHeight).toBe(120);
  });
});

describe("WebGL2ViewerImageBackend output dimension tracking", () => {
  it("tracks output dimensions with lastOutputWidth/lastOutputHeight", () => {
    const backend = new WebGL2ViewerImageBackend() as BackendInternals;
    const gl = createFakeGl();
    backend.renderWidth = 200;
    backend.renderHeight = 100;

    (backend.ensureOutputResources as (gl: unknown) => void)(gl);

    expect(backend.lastOutputWidth).toBe(200);
    expect(backend.lastOutputHeight).toBe(100);
    expect(gl.getTexLevelParameter).not.toHaveBeenCalled();
  });

  it("recreates output FBO when output dimensions change", () => {
    const backend = new WebGL2ViewerImageBackend() as BackendInternals;
    const gl = createFakeGl();
    backend.renderWidth = 200;
    backend.renderHeight = 100;

    (backend.ensureOutputResources as (gl: unknown) => void)(gl);
    const texCallsAfterFirst = gl.texImage2D.mock.calls.length;
    expect(texCallsAfterFirst).toBeGreaterThan(0);

    (backend.ensureOutputResources as (gl: unknown) => void)(gl);
    expect(gl.texImage2D).toHaveBeenCalledTimes(texCallsAfterFirst);

    backend.renderWidth = 400;
    backend.renderHeight = 300;
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
    backend.lastScaleWidth = 1280;
    backend.lastScaleHeight = 720;
    backend.lastOutputWidth = 1920;
    backend.lastOutputHeight = 1080;

    (backend.releaseResources as () => void)();

    expect(backend.lastCleanupWidth).toBe(0);
    expect(backend.lastCleanupHeight).toBe(0);
    expect(backend.lastScaleWidth).toBe(0);
    expect(backend.lastScaleHeight).toBe(0);
    expect(backend.lastOutputWidth).toBe(0);
    expect(backend.lastOutputHeight).toBe(0);
  });

  it("ensureOutputResources does not use getTexLevelParameter", () => {
    const backend = new WebGL2ViewerImageBackend() as BackendInternals;
    const gl = createFakeGl();
    backend.renderWidth = 200;
    backend.renderHeight = 100;

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
    backend.sharpenProgram = "sharpen";
    // For scaling, set bicubic as the active program path
    backend.bicubicProgram = "bicubic";
    backend.cleanupUniforms = {
      u_sourceTexture: "cleanup.source",
      u_chromaCleanup: "cleanup.chromaCleanup",
      u_compressionSmoothing: "cleanup.compressionSmoothing",
      u_texSize: "cleanup.texSize",
    };
    backend.bicubicUniforms = {
      u_sourceTexture: "scale.source",
      u_sourceSize: "scale.sourceSize",
      u_outputSize: "scale.outputSize",
      u_antiRinging: "scale.antiRinging",
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
        { location: "cleanup.compressionSmoothing", value: 0.11 },
        { location: "scale.antiRinging", value: 0.33 },
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
      scalingAlgorithm: "native",
      sharpeningStrength: 0,
      chromaCleanup: 0,
      compressionSmoothing: 0,
    });

    const result = backend.processFrame(createReadyVideo());

    expect(result.success).toBe(true);
    expect(gl.uniformCalls.map((call) => call.location)).not.toEqual(
      expect.arrayContaining([
        "cleanup.chromaCleanup",
        "cleanup.compressionSmoothing",
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

describe("WebGL2ViewerImageBackend scaling algorithm routing", () => {
  it("routes to nearest program when algorithm is nearest", () => {
    const backend = new WebGL2ViewerImageBackend() as BackendInternals;
    const gl = createFakeGl();
    backend.gl = gl;
    backend.outputWidth = 200;
    backend.outputHeight = 100;
    backend.fullscreenProgram = "fullscreen";
    backend.nearestProgram = "nearestProg";
    backend.bicubicProgram = "bicubicProg";
    backend.lanczosProgram = "lanczosProg";
    backend.easuProgram = "easuProg";
    backend.nearestUniforms = {
      u_sourceTexture: "scale.source",
      u_sourceSize: "scale.sourceSize",
      u_outputSize: "scale.outputSize",
      u_antiRinging: "scale.antiRinging",
    };
    backend.easuUniforms = {
      u_sourceTexture: "easu.source",
      u_sourceSize: "easu.sourceSize",
      u_outputSize: "easu.outputSize",
      u_antiRinging: "easu.antiRinging",
      u_easuCon0: null,
      u_easuCon1: null,
      u_easuCon2: null,
      u_easuCon3: null,
    };
    backend.fullscreenUniforms = { u_sourceTexture: "fullscreen.source" };
    backend.updateSettings({
      ...allControls,
      scalingAlgorithm: "nearest",
      chromaCleanup: 0,
      compressionSmoothing: 0,
      sharpeningStrength: 0,
    });

    const result = backend.processFrame(createReadyVideo(50, 25));
    expect(result.success).toBe(true);
    expect(gl.useProgram).toHaveBeenCalledWith("nearestProg");
  });

  it("routes to bicubic program when algorithm is bicubic", () => {
    const backend = new WebGL2ViewerImageBackend() as BackendInternals;
    const gl = createFakeGl();
    backend.gl = gl;
    backend.outputWidth = 200;
    backend.outputHeight = 100;
    backend.fullscreenProgram = "fullscreen";
    backend.bicubicProgram = "bicubicProg";
    backend.bicubicUniforms = {
      u_sourceTexture: "scale.source",
      u_sourceSize: "scale.sourceSize",
      u_outputSize: "scale.outputSize",
      u_antiRinging: "scale.antiRinging",
    };
    backend.fullscreenUniforms = { u_sourceTexture: "fullscreen.source" };
    backend.updateSettings({
      ...allControls,
      scalingAlgorithm: "bicubic",
      chromaCleanup: 0,
      compressionSmoothing: 0,
      sharpeningStrength: 0,
    });

    const result = backend.processFrame(createReadyVideo(50, 25));
    expect(result.success).toBe(true);
    expect(gl.useProgram).toHaveBeenCalledWith("bicubicProg");
  });

  it("routes to lanczos program when algorithm is lanczos", () => {
    const backend = new WebGL2ViewerImageBackend() as BackendInternals;
    const gl = createFakeGl();
    backend.gl = gl;
    backend.outputWidth = 200;
    backend.outputHeight = 100;
    backend.fullscreenProgram = "fullscreen";
    backend.lanczosProgram = "lanczosProg";
    backend.lanczosUniforms = {
      u_sourceTexture: "scale.source",
      u_sourceSize: "scale.sourceSize",
      u_outputSize: "scale.outputSize",
      u_antiRinging: "scale.antiRinging",
    };
    backend.fullscreenUniforms = { u_sourceTexture: "fullscreen.source" };
    backend.updateSettings({
      ...allControls,
      scalingAlgorithm: "lanczos",
      chromaCleanup: 0,
      compressionSmoothing: 0,
      sharpeningStrength: 0,
    });

    const result = backend.processFrame(createReadyVideo(50, 25));
    expect(result.success).toBe(true);
    expect(gl.useProgram).toHaveBeenCalledWith("lanczosProg");
  });

  it("routes to EASU program and uploads official dimension constants", () => {
    const backend = new WebGL2ViewerImageBackend() as BackendInternals;
    const gl = createFakeGl();
    backend.gl = gl;
    backend.outputWidth = 200;
    backend.outputHeight = 100;
    backend.fullscreenProgram = "fullscreen";
    backend.easuProgram = "easuProg";
    backend.easuUniforms = {
      u_sourceTexture: "easu.source",
      u_sourceSize: "easu.sourceSize",
      u_outputSize: "easu.outputSize",
      u_antiRinging: "easu.antiRinging",
      u_easuCon0: "easu.con0",
      u_easuCon1: "easu.con1",
      u_easuCon2: "easu.con2",
      u_easuCon3: "easu.con3",
    };
    backend.fullscreenUniforms = { u_sourceTexture: "fullscreen.source" };
    backend.updateSettings({
      ...allControls,
      scalingAlgorithm: "fsr1-easu",
      chromaCleanup: 0,
      compressionSmoothing: 0,
      sharpeningStrength: 0,
    });

    const result = backend.processFrame(createReadyVideo(50, 25));
    expect(result.success).toBe(true);
    expect(gl.useProgram).toHaveBeenCalledWith("easuProg");
    const byLocation = new Map(gl.uniformCalls.map((call) => [call.location, call.value as number[]]));
    expect(byLocation.get("easu.con0")).toEqual([0.25, 0.25, -0.375, -0.375]);
    expect(byLocation.get("easu.con1")?.[0]).toBeCloseTo(0.02);
    expect(byLocation.get("easu.con1")?.[1]).toBeCloseTo(0.04);
    expect(byLocation.get("easu.con1")?.[2]).toBeCloseTo(0.02);
    expect(byLocation.get("easu.con1")?.[3]).toBeCloseTo(-0.04);
    expect(byLocation.get("easu.con2")?.[0]).toBeCloseTo(-0.02);
    expect(byLocation.get("easu.con2")?.[1]).toBeCloseTo(0.08);
    expect(byLocation.get("easu.con2")?.[2]).toBeCloseTo(0.02);
    expect(byLocation.get("easu.con2")?.[3]).toBeCloseTo(0.08);
    expect(byLocation.get("easu.con3")?.[0]).toBeCloseTo(0);
    expect(byLocation.get("easu.con3")?.[1]).toBeCloseTo(0.16);
    expect(byLocation.get("easu.con3")?.[2]).toBeCloseTo(0);
    expect(byLocation.get("easu.con3")?.[3]).toBeCloseTo(0);
  });
});

describe("WebGL2ViewerImageBackend getStats", () => {
  it("includes scalingAlgorithm in stats", () => {
    const backend = new WebGL2ViewerImageBackend() as BackendInternals;
    backend.gl = createFakeGl();
    backend.updateSettings({
      ...allControls,
      scalingAlgorithm: "lanczos",
    });

    const stats = backend.getStats();
    expect(stats.scalingAlgorithm).toBe("lanczos");
    expect(stats.backend).toBe("webgl2");
  });
});

describe("computeContainedRect", () => {
  it("produces a centered rect for wider source", () => {
    // Source is wider (16:9), output is square (1:1)
    // Source: 160x90, Output: 200x200
    // renderW = 200 (width-constrained), renderH = 200 * 90/160 = 112.5 -> 112
    // x = (200 - 200) / 2 = 0, y = (200 - 112) / 2 = 44
    const backend = new WebGL2ViewerImageBackend() as BackendInternals;
    backend.inputWidth = 160;
    backend.inputHeight = 90;
    backend.outputWidth = 200;
    backend.outputHeight = 200;

    // Trigger processFrame with a video
    const gl = createFakeGl();
    backend.gl = gl;
    backend.fullscreenProgram = "fullscreen";
    backend.fullscreenUniforms = { u_sourceTexture: "fullscreen.source" };
    backend.updateSettings({
      ...allControls,
      scalingAlgorithm: "native",
      chromaCleanup: 0,
      compressionSmoothing: 0,
      sharpeningStrength: 0,
    });

    backend.processFrame(createReadyVideo(160, 90));

    // Render rect should be width-constrained: W=200, H=200*90/160=112
    expect(backend.renderWidth).toBe(200);
    expect(backend.renderHeight).toBe(112);
    expect(backend.renderX).toBe(0);
    expect(backend.renderY).toBe(44);
  });

  it("produces a centered rect for taller source", () => {
    // Source is taller (9:16), output is landscape (16:9)
    // Source: 90x160, Output: 320x180
    const backend = new WebGL2ViewerImageBackend() as BackendInternals;
    const gl = createFakeGl();
    backend.gl = gl;
    backend.fullscreenProgram = "fullscreen";
    backend.fullscreenUniforms = { u_sourceTexture: "fullscreen.source" };
    backend.outputWidth = 320;
    backend.outputHeight = 180;
    backend.updateSettings({
      ...allControls,
      scalingAlgorithm: "native",
      chromaCleanup: 0,
      compressionSmoothing: 0,
      sharpeningStrength: 0,
    });

    backend.processFrame(createReadyVideo(90, 160));

    // Height-constrained: H=180, W=180*90/160=101
    expect(backend.renderWidth).toBe(101);
    expect(backend.renderHeight).toBe(180);
    expect(backend.renderX).toBe(109);
    expect(backend.renderY).toBe(0);
  });
});
