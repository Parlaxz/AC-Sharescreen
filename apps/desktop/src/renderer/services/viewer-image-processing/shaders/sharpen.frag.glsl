#version 300 es
precision highp float;

// SPDX-License-Identifier: MIT
// Contrast-adaptive sharpening with independent chroma, artifact clamp,
// and texture/noise discrimination.

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
    // The CAS filter: detail = center * 4 - (up + down + left + right)
    float lumaDetail = lumaCenter * 4.0 - lumaUp - lumaDown - lumaLeft - lumaRight;
    lumaDetail *= 0.25;

    // -- Texture/noise masking ----------------------------------------
    // textureNoiseSharpening changes which local detail is considered
    // valid texture vs noise. It is subordinate to sharpening strength,
    // not a second global strength.
    // At 0: only strong edges (high localContrast) get sharpened
    // At 1: fine texture detail (low localContrast) is also sharpened
    float noiseFloor = 0.005;
    float noiseCeil = 0.12;
    // edgeConfidence: 0 at noiseFloor, 1 at noiseCeil
    float edgeConfidence = smoothstep(noiseFloor, noiseCeil, localContrast);
    // textureBlend: 0 = only edges, 1 = all detail including noise
    float textureBlend = clamp(u_textureNoiseSharpening, 0.0, 1.0);
    // detailMask blends between "all detail" and "edges only"
    float detailMask = mix(1.0, edgeConfidence, 1.0 - textureBlend);

    float effectiveStrength = u_sharpeningStrength * detailMask;

    // -- Luminance detail (add to luma channel only) ------------------
    // Add luma detail equally to all RGB channels via luminance weights
    vec3 lumaDetailVec = vec3(lumaDetail * effectiveStrength);
    // Scale by LUMA so neutral color gets correct luminance boost,
    // colored edges get less to avoid tint
    vec3 lumaSharp = center + lumaDetailVec * LUMA;

    // -- Chroma (color-only) detail -----------------------------------
    // Compute RGB detail independently for chroma
    vec3 rgbDetail = center * 4.0 - up - down - left - right;
    rgbDetail *= 0.25;
    // Color-only detail = RGB detail minus its luma component
    float rgbDetailLuma = dot(rgbDetail, LUMA);
    vec3 colorDetail = rgbDetail - vec3(rgbDetailLuma);

    // Blend chroma contribution: 0 = luma-only, 1 = full detail
    float chromaBlend = clamp(u_chromaContribution, 0.0, 1.0);
    // Color detail is multiplied by effectiveStrength too, but scaled
    // by chromaBlend to prevent color artifacts at low chromaContribution
    vec3 chromaSharp = lumaSharp + colorDetail * effectiveStrength * chromaBlend;

    vec3 sharpened = chromaSharp;

    // -- Artifact clamp (independent, not multiplied by sharpening strength) --
    // 0 = unrestricted, 1 = strong local clamp
    float clampStrength = clamp(u_artifactClamp, 0.0, 1.0);
    if (clampStrength > 0.0) {
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
        // clampStrength is independent (not multiplied by sharpeningStrength)
        sharpened = mix(sharpened, clamp(sharpened, localMin, localMax), clampStrength);
    }

    // -- Final clamp --------------------------------------------------
    sharpened = clamp(sharpened, 0.0, 1.0);

    fragColor = vec4(sharpened, 1.0);
}
