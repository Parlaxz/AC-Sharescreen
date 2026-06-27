// SPDX-License-Identifier: MIT
/**
 * Minimal WebGL2 resource management helpers.
 * No external dependencies — pure WebGL2 wrappers for shader compilation,
 * program linking, texture allocation, and framebuffer creation.
 */

/**
 * Compile a WebGL2 shader from source.
 * @throws with the info log on compilation failure.
 */
export function createShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Failed to create shader object");

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "unknown error";
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${log}`);
  }

  return shader;
}

/**
 * Link a vertex + fragment shader into a WebGL2 program.
 * Shader objects are freed (detached + deleted) on success.
 * @throws with the info log on link failure.
 */
export function createProgram(
  gl: WebGL2RenderingContext,
  vertSrc: string,
  fragSrc: string,
): WebGLProgram {
  const vert = createShader(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = createShader(gl, gl.FRAGMENT_SHADER, fragSrc);

  const program = gl.createProgram();
  if (!program) throw new Error("Failed to create program object");

  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "unknown error";
    gl.deleteProgram(program);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    throw new Error(`Program link error: ${log}`);
  }

  // Shaders are no longer needed after successful link
  gl.detachShader(program, vert);
  gl.detachShader(program, frag);
  gl.deleteShader(vert);
  gl.deleteShader(frag);

  return program;
}

/**
 * Create a 2D texture with the given dimensions, initialised to zero.
 * Filtering: LINEAR min/mag. Wrapping: CLAMP_TO_EDGE both axes.
 */
export function createTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Failed to create texture");

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null,
  );

  return texture;
}

/**
 * Create a framebuffer object backed by the given texture at COLOR_ATTACHMENT0.
 * Verifies completeness before returning.
 * @throws on incompleteness.
 */
export function createFramebuffer(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
): WebGLFramebuffer {
  const fb = gl.createFramebuffer();
  if (!fb) throw new Error("Failed to create framebuffer");

  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0,
  );

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(fb);
    throw new Error(`Framebuffer incomplete (status: ${status})`);
  }

  return fb;
}

/**
 * Delete a program and its attached shaders.
 * Null-safe — no-op when program is null.
 */
export function deleteProgram(
  gl: WebGL2RenderingContext,
  program: WebGLProgram | null,
): void {
  if (!program) return;

  const attached = gl.getAttachedShaders(program);
  if (attached) {
    for (const shader of attached) {
      gl.detachShader(program, shader);
      gl.deleteShader(shader);
    }
  }
  gl.deleteProgram(program);
}

/**
 * Delete a texture object. Null-safe.
 */
export function deleteTexture(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture | null,
): void {
  if (texture) gl.deleteTexture(texture);
}

/**
 * Delete a framebuffer object. Null-safe.
 */
export function deleteFramebuffer(
  gl: WebGL2RenderingContext,
  fb: WebGLFramebuffer | null,
): void {
  if (fb) gl.deleteFramebuffer(fb);
}
