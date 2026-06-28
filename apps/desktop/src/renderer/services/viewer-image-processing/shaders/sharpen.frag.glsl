#version 300 es
precision highp float;

// SPDX-License-Identifier: MIT
// Contrast-adaptive sharpening with noise protection and internal
// artifact clamping. Chroma contribution is internalised at 0.15
// to prevent coloured halos without desaturating the sharpened result.
// Artifact clamp is tied to sharpening strength at 0.50×.
// Anti-ringing is handled in the scaling pass, not here.

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_sourceTexture;
uniform float u_sharpeningStrength;
uniform float u_noiseProtection;
uniform vec2 u_texSize;

// Rec. 709 luminance coefficients
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Internal fixed chroma contribution — prevents coloured halos
// while restoring colour that pure luma sharpening removes.
const float CHROMA_CONTRIBUTION = 0.15;

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
    float lumaDetail = lumaCenter * 4.0 - lumaUp - lumaDown - lumaLeft - lumaRight;
    lumaDetail *= 0.25;

    // -- Noise protection mask ----------------------------------------
    // noiseProtection: 0 = sharpen all detail including noise
    //                  1 = protect noise, sharpen only coherent edges
    // edgeConfidence uses smoothstep to classify local contrast:
    //   below 0.005 (≈1/255) → noise, mask = 0 (no sharpening)
    //   above 0.08  (≈20/255) → strong edge, mask = 1 (full sharpening)
    float edgeConfidence = smoothstep(0.005, 0.08, localContrast);
    float np = clamp(u_noiseProtection, 0.0, 1.0);
    // At np=0: detailMask = 1.0 (sharpen everything)
    // At np=1: detailMask = edgeConfidence (sharpen edges only)
    float detailMask = mix(1.0, edgeConfidence, np);

    float effectiveStrength = u_sharpeningStrength * detailMask;

    // -- Luminance sharpening -----------------------------------------
    vec3 lumaSharp = center + vec3(lumaDetail * effectiveStrength) * LUMA;

    // -- Chroma (color-only) detail (internalised) --------------------
    vec3 rgbDetail = center * 4.0 - up - down - left - right;
    rgbDetail *= 0.25;
    float rgbDetailLuma = dot(rgbDetail, LUMA);
    vec3 colorDetail = rgbDetail - vec3(rgbDetailLuma);
    vec3 sharpened = lumaSharp + colorDetail * effectiveStrength * CHROMA_CONTRIBUTION;

    // -- Internal artifact clamp (tied to sharpening strength) --------
    // At low sharpening, overshoot is negligible so clamp is weak.
    // At max sharpening, clamp caps at 0.50× preventing excessive halos.
    float clampStrength = clamp(u_sharpeningStrength * 0.50, 0.0, 0.60);
    if (clampStrength > 0.0) {
        vec3 nw = texture(u_sourceTexture, v_texCoord + vec2(-step.x, -step.y)).rgb;
        vec3 ne = texture(u_sourceTexture, v_texCoord + vec2( step.x, -step.y)).rgb;
        vec3 sw = texture(u_sourceTexture, v_texCoord + vec2(-step.x,  step.y)).rgb;
        vec3 se = texture(u_sourceTexture, v_texCoord + vec2( step.x,  step.y)).rgb;

        vec3 localMin = min(min(min(center, up), min(down, left)), right);
        localMin = min(min(min(localMin, nw), ne), min(sw, se));
        vec3 localMax = max(max(max(center, up), max(down, left)), right);
        localMax = max(max(max(localMax, nw), ne), max(sw, se));
        vec3 boundRange = localMax - localMin;
        localMin -= boundRange * 0.1;
        localMax += boundRange * 0.1;

        sharpened = mix(sharpened, clamp(sharpened, localMin, localMax), clampStrength);
    }

    // -- Final clamp --------------------------------------------------
    fragColor = vec4(clamp(sharpened, 0.0, 1.0), 1.0);
}
