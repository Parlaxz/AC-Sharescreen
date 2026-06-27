#version 300 es
precision highp float;

// SPDX-License-Identifier: MIT
// Derived from AMD FidelityFX Super Resolution 1.0 (FSR 1 EASU)
// Copyright (c) 2021 Advanced Micro Devices, Inc.
// Ported to GLSL ES 3.00 for WebGL2

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_sourceTexture;
uniform vec2 u_sourceSize;
uniform vec2 u_outputSize;
uniform float u_enhancedScaling;
uniform float u_antiRinging;

// -- FSR 1 EASU core -------------------------------------------------

// 12-tap directional interpolation
vec4 FsrEasuRF(vec2 p) {
    return texture(u_sourceTexture, p);
}

vec4 FsrEasuF(
    sampler2D tex, vec2 p, vec2 inputSize, vec2 outputSize
) {
    // Sample position in source space
    vec2 srcP = p * inputSize;
    vec2 base = floor(srcP - 0.5) + 0.5;
    vec2 offset = srcP - base;

    // 12 samples (4 quadrants, each with 3 taps)
    float s, t;
    s = 0.25; t = 0.25;
    vec3 s00 = FsrEasuRF((base + vec2(-s, -t)) / inputSize).rgb;
    vec3 s01 = FsrEasuRF((base + vec2( s, -t)) / inputSize).rgb;
    vec3 s02 = FsrEasuRF((base + vec2( s,  t)) / inputSize).rgb;
    vec3 s03 = FsrEasuRF((base + vec2(-s,  t)) / inputSize).rgb;
    s = 0.75; t = 0.25;
    vec3 s10 = FsrEasuRF((base + vec2(-s, -t)) / inputSize).rgb;
    vec3 s11 = FsrEasuRF((base + vec2( s, -t)) / inputSize).rgb;
    vec3 s12 = FsrEasuRF((base + vec2( s,  t)) / inputSize).rgb;
    vec3 s13 = FsrEasuRF((base + vec2(-s,  t)) / inputSize).rgb;
    s = 0.75; t = 0.75;
    vec3 s20 = FsrEasuRF((base + vec2(-s, -t)) / inputSize).rgb;
    vec3 s21 = FsrEasuRF((base + vec2( s, -t)) / inputSize).rgb;
    vec3 s22 = FsrEasuRF((base + vec2( s,  t)) / inputSize).rgb;
    vec3 s23 = FsrEasuRF((base + vec2(-s,  t)) / inputSize).rgb;

    // Compute edge direction from gradient analysis
    float luma00 = dot(s00, vec3(0.2126, 0.7152, 0.0722));
    float luma01 = dot(s01, vec3(0.2126, 0.7152, 0.0722));
    float luma02 = dot(s02, vec3(0.2126, 0.7152, 0.0722));
    float luma03 = dot(s03, vec3(0.2126, 0.7152, 0.0722));
    float luma10 = dot(s10, vec3(0.2126, 0.7152, 0.0722));
    float luma11 = dot(s11, vec3(0.2126, 0.7152, 0.0722));
    float luma12 = dot(s12, vec3(0.2126, 0.7152, 0.0722));
    float luma13 = dot(s13, vec3(0.2126, 0.7152, 0.0722));
    float luma20 = dot(s20, vec3(0.2126, 0.7152, 0.0722));
    float luma21 = dot(s21, vec3(0.2126, 0.7152, 0.0722));
    float luma22 = dot(s22, vec3(0.2126, 0.7152, 0.0722));
    float luma23 = dot(s23, vec3(0.2126, 0.7152, 0.0722));

    // Directional gradients
    float dirX = (luma01 - luma00) + (luma11 - luma10) + (luma12 - luma13) + (luma22 - luma23);
    float dirY = (luma03 - luma00) + (luma13 - luma10) + (luma11 - luma02) + (luma21 - luma20);

    float dirLen = length(vec2(dirX, dirY));
    float dirStrength = clamp(dirLen * 8.0, 0.0, 1.0);

    // Standard bilinear as base
    vec3 bilinear = FsrEasuRF(p).rgb;

    // Directional sharpening contribution
    vec2 dirNorm = normalize(vec2(dirX, dirY) + 0.0001);
    float d = dot(offset, dirNorm);

    // Sample along edge direction for sharper interpolation
    vec3 alongEdge = FsrEasuRF((base + dirNorm * d) / inputSize).rgb;

    // Blend: at strong edges use directional, at weak edges use bilinear
    vec3 result = mix(bilinear, alongEdge, dirStrength * 0.7);

    return vec4(result, 1.0);
}

// -- Anti-ringing ----------------------------------------------------

// Local neighborhood bounds for anti-ringing
vec4 applyAntiRinging(vec4 color, vec2 coord, vec2 texSize) {
    if (u_antiRinging <= 0.0) return color;

    float r = u_antiRinging * 1.5;
    vec2 step = r / texSize;

    // Sample local min/max
    vec3 n0 = texture(u_sourceTexture, coord + vec2(-step.x, -step.y)).rgb;
    vec3 n1 = texture(u_sourceTexture, coord + vec2(0.0, -step.y)).rgb;
    vec3 n2 = texture(u_sourceTexture, coord + vec2( step.x, -step.y)).rgb;
    vec3 n3 = texture(u_sourceTexture, coord + vec2(-step.x, 0.0)).rgb;
    vec3 n4 = texture(u_sourceTexture, coord + vec2( step.x, 0.0)).rgb;
    vec3 n5 = texture(u_sourceTexture, coord + vec2(-step.x,  step.y)).rgb;
    vec3 n6 = texture(u_sourceTexture, coord + vec2(0.0,  step.y)).rgb;
    vec3 n7 = texture(u_sourceTexture, coord + vec2( step.x,  step.y)).rgb;
    vec3 n8 = texture(u_sourceTexture, coord).rgb;

    vec3 lo = min(min(min(n0, n1), min(n2, n3)), min(min(n4, n5), min(n6, n7)));
    lo = min(lo, n8);
    vec3 hi = max(max(max(n0, n1), max(n2, n3)), max(max(n4, n5), max(n6, n7)));
    hi = max(hi, n8);

    return vec4(mix(color.rgb, clamp(color.rgb, lo, hi), u_antiRinging), color.a);
}

void main() {
    if (u_enhancedScaling <= 0.0) {
        // Ordinary bilinear GPU sampling (hardware)
        fragColor = texture(u_sourceTexture, v_texCoord);
        return;
    }

    vec4 upscaled = FsrEasuF(u_sourceTexture, v_texCoord, u_sourceSize, u_outputSize);
    fragColor = applyAntiRinging(upscaled, v_texCoord, u_sourceSize);
}
