#!/usr/bin/env python3
"""Apply the ScreenLink 0.5.0 viewer post-processing fixes.

Run from the AC-Sharescreen repository root:
    python path/to/screenlink-postprocessing-fix.py

The edit is transactional: all expected source patterns must match before any file is written.
Target audited commit: c2c7585fda370219d2f56929b6ba34a276d5bcc2
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

AUDITED_COMMIT = "c2c7585fda370219d2f56929b6ba34a276d5bcc2"

BACKEND = Path(
    "apps/desktop/src/renderer/services/viewer-image-processing/"
    "webgl2-viewer-image-backend.ts"
)
PROCESSOR = Path(
    "apps/desktop/src/renderer/services/viewer-image-processing/"
    "viewer-image-processor.ts"
)
SURFACE = Path(
    "apps/desktop/src/renderer/components/workspace/viewer/EnhancedVideoSurface.tsx"
)
WORKSPACE = Path(
    "apps/desktop/src/renderer/components/workspace/ViewerWorkspace.tsx"
)
SHARPEN = Path(
    "apps/desktop/src/renderer/services/viewer-image-processing/shaders/"
    "sharpen.frag.glsl"
)

FILES = [BACKEND, PROCESSOR, SURFACE, WORKSPACE, SHARPEN]


class PatchError(RuntimeError):
    pass


def replace_exact(text: str, old: str, new: str, label: str, count: int = 1) -> str:
    actual = text.count(old)
    if actual != count:
        raise PatchError(f"{label}: expected {count} exact match(es), found {actual}")
    return text.replace(old, new, count)


def replace_regex(
    text: str,
    pattern: str,
    replacement: str,
    label: str,
    *,
    flags: int = re.MULTILINE | re.DOTALL,
) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise PatchError(f"{label}: expected 1 regex match, found {count}")
    return updated


def current_commit() -> str | None:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def patch_backend(text: str) -> str:
    text = replace_exact(
        text,
        "export interface FrameProcessResult {\n  success: boolean;\n  gpuTimeMs?: number;\n}",
        "export interface FrameProcessResult {\n"
        "  success: boolean;\n"
        "  /** Normal startup/not-ready frame; keep scheduling instead of falling back. */\n"
        "  skipped?: boolean;\n"
        "  gpuTimeMs?: number;\n"
        "  reason?: string;\n"
        "}",
        "FrameProcessResult",
    )

    text = replace_exact(
        text,
        "private vao: WebGLVertexArrayOES | null = null;",
        "private vao: WebGLVertexArrayObject | null = null;",
        "WebGL2 VAO type",
    )

    text = replace_exact(
        text,
        "  private upscaleTexture: WebGLTexture | null = null;\n"
        "  private upscaleFBO: WebGLFramebuffer | null = null;",
        "  private upscaleTexture: WebGLTexture | null = null;\n"
        "  private upscaleFBO: WebGLFramebuffer | null = null;\n"
        "  private upscaleWidth = 0;\n"
        "  private upscaleHeight = 0;",
        "upscale dimension cache fields",
    )

    text = replace_exact(
        text,
        "  private activeTimerIndex = 0;\n"
        "  private lastGpuTimeMs: number | null = null;\n"
        "  private pendingTimerAvailable = false;",
        "  private activeTimerIndex = 0;\n"
        "  private timerQueryPending = [false, false];\n"
        "  private timerQueryActive = false;\n"
        "  private currentTimerIndex: number | null = null;\n"
        "  private lastGpuTimeMs: number | null = null;",
        "timer query state",
    )

    text = replace_exact(
        text,
        "    if (!gl) {\n      return { success: false };\n    }",
        "    if (!gl) {\n"
        "      return { success: false, reason: \"WebGL2 context unavailable\" };\n"
        "    }",
        "missing-context result",
    )

    text = replace_exact(
        text,
        "return { success: false, gpuTimeMs: 0 };",
        "return { success: true, skipped: true, gpuTimeMs: 0 };",
        "normal video-not-ready results",
        count=2,
    )

    text = replace_exact(
        text,
        "      return {\n        success: false,\n      };",
        "      return {\n"
        "        success: false,\n"
        "        reason: err instanceof Error ? err.message : \"Unknown frame processing error\",\n"
        "      };",
        "frame processing error reason",
    )

    text = replace_regex(
        text,
        r"  private ensureUpscaleResources\(gl: WebGL2RenderingContext\): void \{.*?\n  \}\n  private ensureOutputResources",
        "  private ensureUpscaleResources(gl: WebGL2RenderingContext): void {\n"
        "    if (this.outputWidth <= 0 || this.outputHeight <= 0) return;\n\n"
        "    if (\n"
        "      this.upscaleTexture &&\n"
        "      this.upscaleFBO &&\n"
        "      this.upscaleWidth === this.outputWidth &&\n"
        "      this.upscaleHeight === this.outputHeight\n"
        "    ) {\n"
        "      return;\n"
        "    }\n\n"
        "    deleteTexture(gl, this.upscaleTexture);\n"
        "    deleteFramebuffer(gl, this.upscaleFBO);\n"
        "    this.upscaleTexture = createTexture(gl, this.outputWidth, this.outputHeight);\n"
        "    this.upscaleFBO = createFramebuffer(gl, this.upscaleTexture);\n"
        "    this.upscaleWidth = this.outputWidth;\n"
        "    this.upscaleHeight = this.outputHeight;\n"
        "  }\n\n"
        "  private ensureOutputResources",
        "replace unsupported getTexLevelParameter path",
    )

    text = replace_regex(
        text,
        r"  private allocateUpscaleFBO\(gl: WebGL2RenderingContext\): void \{.*?\n  \}\n\n  // ─── Private: Uniform caching",
        "  private allocateUpscaleFBO(gl: WebGL2RenderingContext): void {\n"
        "    const needsUpscale =\n"
        "      this.outputWidth > 0 &&\n"
        "      this.outputHeight > 0 &&\n"
        "      (this.outputWidth !== this.inputWidth ||\n"
        "        this.outputHeight !== this.inputHeight);\n\n"
        "    if (!needsUpscale) {\n"
        "      deleteTexture(gl, this.upscaleTexture);\n"
        "      deleteFramebuffer(gl, this.upscaleFBO);\n"
        "      this.upscaleTexture = null;\n"
        "      this.upscaleFBO = null;\n"
        "      this.upscaleWidth = 0;\n"
        "      this.upscaleHeight = 0;\n"
        "      return;\n"
        "    }\n\n"
        "    this.ensureUpscaleResources(gl);\n"
        "  }\n\n"
        "  // ─── Private: Uniform caching",
        "upscale framebuffer allocation",
    )

    text = replace_regex(
        text,
        r"  private beginTimer\(gl: WebGL2RenderingContext\): void \{.*?\n  \}\n\n  // ─── Private: Resource teardown",
        "  private beginTimer(gl: WebGL2RenderingContext): void {\n"
        "    this.frameStartTime = performance.now();\n"
        "    if (!this.timerExt || this.timerQueries.length < 2) return;\n\n"
        "    this.readTimerResult();\n\n"
        "    const firstIndex = this.activeTimerIndex;\n"
        "    const secondIndex = firstIndex === 0 ? 1 : 0;\n"
        "    const queryIndex = !this.timerQueryPending[firstIndex]\n"
        "      ? firstIndex\n"
        "      : !this.timerQueryPending[secondIndex]\n"
        "        ? secondIndex\n"
        "        : null;\n"
        "    if (queryIndex === null) return;\n\n"
        "    try {\n"
        "      gl.beginQuery(\n"
        "        this.timerExt.TIME_ELAPSED_EXT,\n"
        "        this.timerQueries[queryIndex],\n"
        "      );\n"
        "      this.currentTimerIndex = queryIndex;\n"
        "      this.timerQueryActive = true;\n"
        "    } catch {\n"
        "      this.timerExt = null;\n"
        "      this.timerQueries = [];\n"
        "      this.timerQueryPending = [false, false];\n"
        "      this.timerQueryActive = false;\n"
        "      this.currentTimerIndex = null;\n"
        "    }\n"
        "  }\n\n"
        "  private endTimer(gl: WebGL2RenderingContext): void {\n"
        "    if (\n"
        "      !this.timerExt ||\n"
        "      !this.timerQueryActive ||\n"
        "      this.currentTimerIndex === null\n"
        "    ) {\n"
        "      return;\n"
        "    }\n\n"
        "    try {\n"
        "      gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);\n"
        "      this.timerQueryPending[this.currentTimerIndex] = true;\n"
        "      this.activeTimerIndex = this.currentTimerIndex === 0 ? 1 : 0;\n"
        "    } catch {\n"
        "      this.timerExt = null;\n"
        "      this.timerQueries = [];\n"
        "      this.timerQueryPending = [false, false];\n"
        "    } finally {\n"
        "      this.timerQueryActive = false;\n"
        "      this.currentTimerIndex = null;\n"
        "    }\n"
        "  }\n\n"
        "  private readTimerResult(): void {\n"
        "    const gl = this.gl;\n"
        "    if (!gl || !this.timerExt || this.timerQueries.length < 2) return;\n\n"
        "    try {\n"
        "      for (let index = 0; index < this.timerQueries.length; index++) {\n"
        "        if (!this.timerQueryPending[index]) continue;\n\n"
        "        const available = gl.getQueryParameter(\n"
        "          this.timerQueries[index],\n"
        "          gl.QUERY_RESULT_AVAILABLE,\n"
        "        ) as boolean;\n"
        "        if (!available) continue;\n\n"
        "        const disjoint = gl.getParameter(\n"
        "          this.timerExt.GPU_DISJOINT_EXT,\n"
        "        ) as boolean;\n"
        "        if (!disjoint) {\n"
        "          const timeNs = gl.getQueryParameter(\n"
        "            this.timerQueries[index],\n"
        "            gl.QUERY_RESULT,\n"
        "          ) as number;\n"
        "          this.lastGpuTimeMs = timeNs / 1_000_000;\n"
        "        }\n"
        "        this.timerQueryPending[index] = false;\n"
        "      }\n"
        "    } catch {\n"
        "      this.timerExt = null;\n"
        "      this.timerQueries = [];\n"
        "      this.timerQueryPending = [false, false];\n"
        "      this.timerQueryActive = false;\n"
        "      this.currentTimerIndex = null;\n"
        "    }\n"
        "  }\n\n"
        "  // ─── Private: Resource teardown",
        "WebGL2 timer-query API",
    )

    text, reset_count = re.subn(
        r"(?m)^(\s*)this\.upscaleTexture = null;\n\1this\.upscaleFBO = null;\n\1this\.outputTexture = null;",
        lambda match: (
            f"{match.group(1)}this.upscaleTexture = null;\n"
            f"{match.group(1)}this.upscaleFBO = null;\n"
            f"{match.group(1)}this.upscaleWidth = 0;\n"
            f"{match.group(1)}this.upscaleHeight = 0;\n"
            f"{match.group(1)}this.outputTexture = null;"
        ),
        text,
    )
    if reset_count != 2:
        raise PatchError(
            f"upscale cache reset: expected 2 matches, found {reset_count}"
        )

    text = replace_regex(
        text,
        r"(\s*)this\.timerQueries = \[\];\n\1return;",
        r"\1this.timerQueries = [];\n"
        r"\1this.timerQueryPending = [false, false];\n"
        r"\1this.timerQueryActive = false;\n"
        r"\1this.currentTimerIndex = null;\n"
        r"\1return;",
        "timer state reset without context",
    )

    text = replace_regex(
        text,
        r"(?m)^(\s*)this\.timerQueries = \[\];\n"
        r"\1this\.activeTimerIndex = 0;\n"
        r"\1this\.pendingTimerAvailable = false;\n"
        r"\1this\.lastGpuTimeMs = null;",
        r"\1this.timerQueries = [];\n"
        r"\1this.activeTimerIndex = 0;\n"
        r"\1this.timerQueryPending = [false, false];\n"
        r"\1this.timerQueryActive = false;\n"
        r"\1this.currentTimerIndex = null;\n"
        r"\1this.lastGpuTimeMs = null;",
        "timer state reset with context",
    )

    return text


def patch_processor(text: str) -> str:
    return replace_regex(
        text,
        r"  private processCurrentFrame\(\): void \{.*?\n  \}\n\n  // ─── Helpers",
        "  private processCurrentFrame(): void {\n"
        "    const result = this.backend.processFrame(this.videoElement);\n\n"
        "    if (result.skipped) {\n"
        "      return;\n"
        "    }\n\n"
        "    if (!result.success) {\n"
        "      this.callbacks.onError?.(result.reason ?? \"Frame processing failed\");\n"
        "      this.state = \"error\";\n"
        "      this.cancelFrame();\n"
        "      this.callbacks.onStateChange?.(\"error\");\n"
        "      return;\n"
        "    }\n\n"
        "    this.framesProcessed++;\n\n"
        "    if (!this.firstFrameFired) {\n"
        "      this.firstFrameFired = true;\n"
        "      this.callbacks.onFirstFrame?.();\n"
        "    }\n\n"
        "    const now = performance.now();\n"
        "    if (now - this.lastStatsTime > 500) {\n"
        "      this.lastStatsTime = now;\n"
        "      this.callbacks.onStatsUpdate?.(this.getStats());\n"
        "    }\n"
        "  }\n\n"
        "  // ─── Helpers",
        "processor skipped-frame handling",
    )


def patch_surface(text: str) -> str:
    text = replace_exact(
        text,
        "  const prevEnabledRef = useRef<boolean>(enabled);\n",
        "",
        "remove redundant enabled ref",
    )

    text = replace_exact(
        text,
        "  const [fallback, setFallback] = useState<boolean>(false);\n\n"
        "  // ─── Capabilities check on mount",
        "  const [fallback, setFallback] = useState<boolean>(false);\n\n"
        "  // Turning the feature off clears a runtime fallback so the next enable retries.\n"
        "  useEffect(() => {\n"
        "    if (!enabled) {\n"
        "      setFallback(false);\n"
        "      setProcessorState(\"idle\");\n"
        "    }\n"
        "  }, [enabled]);\n\n"
        "  // ─── Capabilities check on mount",
        "fallback reset on disable",
    )

    text = replace_exact(
        text,
        "      onFirstFrame: () => {\n        onFirstFrame?.();\n      },",
        "      onFirstFrame: () => {\n"
        "        setFallback(false);\n"
        "        onFirstFrame?.();\n"
        "      },",
        "successful frame clears fallback",
    )

    text = replace_regex(
        text,
        r"\n  // ─── Pause / resume on enabled toggle.*?\n  // ─── ResizeObserver for container sizing",
        "\n  // ─── ResizeObserver for container sizing",
        "remove redundant pause/resume effect",
    )

    return text


def patch_workspace(text: str) -> str:
    text = replace_regex(
        text,
        r"  const handleEnhancementChange = useCallback\(\(partial: Partial<ViewerImageEnhancementSettings>\) => \{\s*setEnhancementSettings\(\(prev\) => \(\{ \.\.\.prev, \.\.\.partial \}\)\);\s*\}, \[\]\);",
        "  const handleEnhancementChange = useCallback(\n"
        "    (partial: Partial<ViewerImageEnhancementSettings>) => {\n"
        "      if (partial.enabled !== undefined) {\n"
        "        setEnhancementFallback(false);\n"
        "        setEnhancementStats(null);\n"
        "      }\n"
        "      setEnhancementSettings((prev) => ({ ...prev, ...partial }));\n"
        "    },\n"
        "    [],\n"
        "  );",
        "workspace enhancement toggle retry",
    )

    text = replace_regex(
        text,
        r"  const handleEnhancementReset = useCallback\(\(\) => \{\s*setEnhancementSettings\(resetImageEnhancementSettings\(\)\);\s*\}, \[\]\);",
        "  const handleEnhancementReset = useCallback(() => {\n"
        "    setEnhancementFallback(false);\n"
        "    setEnhancementStats(null);\n"
        "    setEnhancementSettings(resetImageEnhancementSettings());\n"
        "  }, []);",
        "workspace enhancement reset retry",
    )

    text = replace_regex(
        text,
        r"onFirstFrame=\{\(\) => \{\s*// First enhanced frame successfully rendered\s*\}\}",
        "onFirstFrame={() => {\n"
        "                  setEnhancementFallback(false);\n"
        "                }}",
        "workspace first frame fallback reset",
    )

    return text


def patch_sharpen(text: str) -> str:
    text = replace_exact(
        text,
        "vec3 lumaSharp = center + lumaDetail * effectiveStrength * LUMA;",
        "vec3 lumaSharp = center + vec3(lumaDetail * effectiveStrength);",
        "luminance-only sharpening",
    )
    text = replace_exact(
        text,
        "float clampStrength = clamp(u_artifactClamp, 0.0, 1.0) * u_sharpeningStrength;",
        "float clampStrength = clamp(u_artifactClamp, 0.0, 1.0);",
        "independent artifact clamp",
    )
    return text


def main() -> int:
    root = Path.cwd()
    missing = [str(path) for path in FILES if not (root / path).is_file()]
    if missing:
        print("Run this script from the AC-Sharescreen repository root.", file=sys.stderr)
        print("Missing files:", file=sys.stderr)
        for path in missing:
            print(f"  - {path}", file=sys.stderr)
        return 2

    commit = current_commit()
    if commit and commit != AUDITED_COMMIT:
        print(
            f"Note: audited {AUDITED_COMMIT[:7]}, current checkout is {commit[:7]}. "
            "Pattern checks will prevent unsafe partial edits."
        )

    original = {path: (root / path).read_text(encoding="utf-8") for path in FILES}
    updated = dict(original)

    try:
        updated[BACKEND] = patch_backend(updated[BACKEND])
        updated[PROCESSOR] = patch_processor(updated[PROCESSOR])
        updated[SURFACE] = patch_surface(updated[SURFACE])
        updated[WORKSPACE] = patch_workspace(updated[WORKSPACE])
        updated[SHARPEN] = patch_sharpen(updated[SHARPEN])
    except PatchError as exc:
        print(f"Patch aborted before writing: {exc}", file=sys.stderr)
        return 1

    changed = [path for path in FILES if updated[path] != original[path]]
    if not changed:
        print("No changes needed; the audited fixes appear to be present already.")
        return 0

    for path in changed:
        destination = root / path
        temporary = destination.with_suffix(destination.suffix + ".screenlink-fix-tmp")
        temporary.write_text(updated[path], encoding="utf-8", newline="\n")
        temporary.replace(destination)

    print("Applied ScreenLink post-processing fixes:")
    for path in changed:
        print(f"  - {path}")
    print("\nRecommended validation:")
    print("  pnpm --filter @screenlink/desktop typecheck")
    print("  pnpm --filter @screenlink/desktop test")
    print("  pnpm --filter @screenlink/desktop build")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
