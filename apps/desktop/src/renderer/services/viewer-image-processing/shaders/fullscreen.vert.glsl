#version 300 es
precision highp float;

// SPDX-License-Identifier: MIT
// Generic fullscreen quad vertex shader

out vec2 v_texCoord;

void main() {
    // Generate a fullscreen triangle from vertex ID (no buffers needed)
    // gl_VertexID: 0->(-1,-1), 1->(3,-1), 2->(-1,3)
    float x = float((gl_VertexID & 1) << 2) - 1.0;
    float y = float((gl_VertexID & 2) << 1) - 1.0;
    v_texCoord = vec2((x + 1.0) * 0.5, (y + 1.0) * 0.5);
    gl_Position = vec4(x, y, 0.0, 1.0);
}
