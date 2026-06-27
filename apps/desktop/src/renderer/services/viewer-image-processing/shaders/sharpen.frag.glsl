#version 300 es
precision highp float;

// SPDX-License-Identifier: MIT
// Derived from AMD FidelityFX Contrast Adaptive Sharpening (CAS)
// Copyright (c) 2021 Advanced Micro Devices, Inc.

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_sourceTexture;
uniform float u_sharpeningStrength;
uniform float u_chromaContribution;
uniform float u_artifactClamp;
uniform float u_textureNoiseSharpening;
uniform vec2 u_texSize;

// Rec. 709 luminance coefficients
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Contrast-adaptive sharpening (CAS-style)
void main() {
    vec2 step = 1.0 / u_texSize;
    vec3 center = texture(u_sourceTexture, v_texCoord).rgb;

    // Bypass when sharpening is zero
    if (u_sharpeningStrength <= 0.0) {
        fragColor = vec4(center, 1.0);
        return;
    }

    // -- Sample neighborhood (cross pattern for CAS) ------------------
    vec3 up    = texture(u_sourceTexture, v_texCoord + vec2(0.0, -step.y)).rgb;
    vec3 down  = texture(u_sourceTexture, v_texCoord + vec2(0.0,  step.y)).rgb;
    vec3 left  = texture(u_sourceTexture, v_texCoord + vec2(-step.x, 0.0)).rgb;
    vec3 right = texture(u_sourceTexture, v_texCoord + vec2( step.x, 0.0)).rgb;

    // -- Compute luminance --------------------------------------------
    float lumaCenter = dot(center, LUMA);
    float lumaUp    = dot(up, LUMA);
    float lumaDown  = dot(down, LUMA);
    float lumaLeft  = dot(left, LUMA);
    float lumaRight = dot(right, LUMA);

    // -- Local contrast -----------------------------------------------
    float lo = min(min(min(lumaCenter, lumaUp), min(lumaDown, lumaLeft)), lumaRight);
    float hi = max(max(max(lumaCenter, lumaUp), max(lumaDown, lumaLeft)), lumaRight);
    float localContrast = hi - lo;

    // -- CAS luma detail extraction -----------------------------------
    // The CAS filter: detail = center - 0.25 * (up + down + left + right)
    float lumaDetail = lumaCenter * 4.0 - lumaUp - lumaDown - lumaLeft - lumaRight;
    lumaDetail *= 0.25;

    // -- Texture/noise masking ----------------------------------------
    // At low textureNoiseSharpening: focus on coherent edges (high localContrast)
    // At high textureNoiseSharpening: include fine texture (low localContrast)
    float noiseMaskStart = 0.02;  // below this contrast = noise
    float noiseMaskEnd   = 0.15;  // above this contrast = edge
    float edgeConfidence = smoothstep(noiseMaskStart, noiseMaskEnd, localContrast);
    float textureBlend = clamp(u_textureNoiseSharpening, 0.0, 1.0);
    float detailMask = mix(1.0, edgeConfidence, 1.0 - textureBlend);

    float effectiveStrength = u_sharpeningStrength * detailMask;

    // -- Chroma contribution ------------------------------------------
    // Compute RGB detail
    vec3 rgbDetail = center * 4.0 - up - down - left - right;
    rgbDetail *= 0.25;

    // At chromaContribution=0: sharpen only luma
    // At chromaContribution=1: full chroma sharpening
    vec3 lumaSharp = center + lumaDetail * effectiveStrength * LUMA;
    vec3 fullSharp = center + rgbDetail * effectiveStrength;
    vec3 sharpened = mix(lumaSharp, fullSharp, clamp(u_chromaContribution, 0.0, 1.0));

    // -- Artifact clamp -----------------------------------------------
    if (u_artifactClamp > 0.0) {
        // Sample corners for 3x3 neighborhood bounds
        vec3 nw = texture(u_sourceTexture, v_texCoord + vec2(-step.x, -step.y)).rgb;
        vec3 ne = texture(u_sourceTexture, v_texCoord + vec2( step.x, -step.y)).rgb;
        vec3 sw = texture(u_sourceTexture, v_texCoord + vec2(-step.x,  step.y)).rgb;
        vec3 se = texture(u_sourceTexture, v_texCoord + vec2( step.x,  step.y)).rgb;

        vec3 localMin = min(min(min(center, up), min(down, left)), right);
        localMin = min(min(min(localMin, nw), ne), min(sw, se));
        vec3 localMax = max(max(max(center, up), max(down, left)), right);
        localMax = max(max(max(localMax, nw), ne), max(sw, se));

        // Expand bounds slightly to prevent over-clamping
        vec3 boundRange = localMax - localMin;
        localMin -= boundRange * 0.1;
        localMax += boundRange * 0.1;

        // Blend between unrestricted and clamped
        float clampStrength = clamp(u_artifactClamp, 0.0, 1.0) * u_sharpeningStrength;
        sharpened = mix(sharpened, clamp(sharpened, localMin, localMax), clampStrength);
    }

    // -- Final clamp --------------------------------------------------
    sharpened = clamp(sharpened, 0.0, 1.0);

    fragColor = vec4(sharpened, 1.0);
}
