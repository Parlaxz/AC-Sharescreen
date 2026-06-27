#version 300 es
precision highp float;

// SPDX-License-Identifier: MIT
// Derived from AMD FidelityFX Contrast Adaptive Sharpening concepts
// Copyright (c) 2021 Advanced Micro Devices, Inc.

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_sourceTexture;
uniform float u_chromaCleanup;
uniform float u_deblocking;
uniform vec2 u_texSize;

// Rec. 709 luminance coefficients
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Chroma conversion: RGB -> YCbCr
vec3 rgb2ycbcr(vec3 rgb) {
    float y = dot(rgb, LUMA);
    float cb = (rgb.b - y) * 0.5643;
    float cr = (rgb.r - y) * 0.7133;
    return vec3(y, cb, cr);
}

// Chroma conversion: YCbCr -> RGB
vec3 ycbcr2rgb(vec3 ycbcr) {
    float r = ycbcr.x + 1.402 * ycbcr.z;
    float g = ycbcr.x - 0.3441 * ycbcr.y - 0.7141 * ycbcr.z;
    float b = ycbcr.x + 1.772 * ycbcr.y;
    return vec3(r, g, b);
}

void main() {
    vec3 center = texture(u_sourceTexture, v_texCoord).rgb;

    // Bypass if both effects are zero
    if (u_chromaCleanup <= 0.0 && u_deblocking <= 0.0) {
        fragColor = vec4(center, 1.0);
        return;
    }

    vec2 step = 1.0 / u_texSize;

    // -- Chroma cleanup -----------------------------------------------
    // Sample neighborhood for edge-aware chroma smoothing
    vec3 ycbcrCenter = rgb2ycbcr(center);

    if (u_chromaCleanup > 0.0) {
        // Sample luma in 3x3
        float lumaN  = dot(texture(u_sourceTexture, v_texCoord + vec2(0.0, -step.y)).rgb, LUMA);
        float lumaS  = dot(texture(u_sourceTexture, v_texCoord + vec2(0.0,  step.y)).rgb, LUMA);
        float lumaW  = dot(texture(u_sourceTexture, v_texCoord + vec2(-step.x, 0.0)).rgb, LUMA);
        float lumaE  = dot(texture(u_sourceTexture, v_texCoord + vec2( step.x, 0.0)).rgb, LUMA);

        float lumaDiff = max(abs(lumaN - lumaE), abs(lumaS - lumaW));
        lumaDiff = max(lumaDiff, abs(lumaN - lumaS));
        lumaDiff = max(lumaDiff, abs(lumaW - lumaE));

        // Edge weight: high luma contrast -> weak chroma smoothing
        float edgeWeight = exp(-lumaDiff * lumaDiff * 50.0);
        float chromaBlend = u_chromaCleanup * edgeWeight;

        // Bilinear chroma sampling
        vec2 tc = v_texCoord;
        vec4 chromaSum = vec4(0.0);
        float chromaW = 0.0;
        for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
                vec3 samp = rgb2ycbcr(texture(u_sourceTexture, tc + vec2(float(x), float(y)) * step).rgb);
                float lumaSamp = samp.x;
                float weight = exp(-abs(lumaSamp - ycbcrCenter.x) * 10.0);
                chromaSum += vec4(samp, 0.0) * weight;
                chromaW += weight;
            }
        }
        vec3 smoothed = chromaSum.rgb / max(chromaW, 0.001);
        ycbcrCenter.yz = mix(ycbcrCenter.yz, smoothed.yz, chromaBlend);
    }

    // -- Deblocking ---------------------------------------------------
    if (u_deblocking > 0.0) {
        vec3 ycbcr0 = rgb2ycbcr(texture(u_sourceTexture, v_texCoord + vec2(0.0, -step.y)).rgb);
        vec3 ycbcr1 = rgb2ycbcr(texture(u_sourceTexture, v_texCoord + vec2(0.0,  step.y)).rgb);
        vec3 ycbcr2 = rgb2ycbcr(texture(u_sourceTexture, v_texCoord + vec2(-step.x, 0.0)).rgb);
        vec3 ycbcr3 = rgb2ycbcr(texture(u_sourceTexture, v_texCoord + vec2( step.x, 0.0)).rgb);

        float lumaCenter = ycbcrCenter.x;
        float gradH = abs(ycbcr0.x - ycbcr1.x);
        float gradV = abs(ycbcr2.x - ycbcr3.x);

        // Detect weak block boundaries (small gradient = likely compression artifact)
        float blockStrengthH = 1.0 / (1.0 + gradH * gradH * 100.0);
        float blockStrengthV = 1.0 / (1.0 + gradV * gradV * 100.0);

        // Only smooth when gradient is small (flat region with potential blocking)
        float smoothStrength = min(blockStrengthH, blockStrengthV) * u_deblocking;

        // Conservative: only smooth luma slightly at block boundaries
        vec3 smoothedLuma = (ycbcr0 + ycbcr1 + ycbcr2 + ycbcr3) * 0.25;
        ycbcrCenter.x = mix(lumaCenter, smoothedLuma.x, smoothStrength * 0.5);
        // Also smooth chroma slightly at boundaries
        ycbcrCenter.yz = mix(ycbcrCenter.yz, (ycbcr0.yz + ycbcr1.yz + ycbcr2.yz + ycbcr3.yz) * 0.25, smoothStrength * 0.25);
    }

    vec3 result = clamp(ycbcr2rgb(ycbcrCenter), 0.0, 1.0);
    fragColor = vec4(result, 1.0);
}
