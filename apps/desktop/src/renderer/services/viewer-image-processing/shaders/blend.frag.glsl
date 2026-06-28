#version 300 es
precision highp float;

// SPDX-License-Identifier: MIT
// Custom ScreenLink FSR/Bicubic blend shader.
// Blends two scaled textures: textureA (bicubic) and textureB (FSR EASU).
// blendFactor=0 → pure bicubic, blendFactor=1 → pure FSR EASU.
// This is NOT an official AMD FSR setting — it is a ScreenLink custom control
// that lets users reduce aggressive EASU reconstruction on heavily compressed
// or extremely low-resolution streams.

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_textureA;
uniform sampler2D u_textureB;
uniform float u_blendFactor;

void main() {
    vec3 a = texture(u_textureA, v_texCoord).rgb;
    vec3 b = texture(u_textureB, v_texCoord).rgb;
    fragColor = vec4(mix(a, b, clamp(u_blendFactor, 0.0, 1.0)), 1.0);
}
