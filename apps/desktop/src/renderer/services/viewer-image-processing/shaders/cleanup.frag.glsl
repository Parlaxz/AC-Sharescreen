#version 300 es
precision highp float;

// SPDX-License-Identifier: MIT
// Compression cleanup: unified chroma cleanup + edge-aware luma smoothing.
// Replaces the separate chroma cleanup and compression smoothing controls.
// Preserves strong text/UI edges. Zero value is a true bypass.

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_sourceTexture;
uniform float u_compressionCleanup;
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
    float strength = u_compressionCleanup;

    // Bypass when cleanup is zero
    if (strength <= 0.0) {
        fragColor = vec4(center, 1.0);
        return;
    }

    vec2 step = 1.0 / u_texSize;
    vec3 ycbcrCenter = rgb2ycbcr(center);

    // -- Edge-aware chroma cleanup (3x3 gaussian-like weighted average) --
    // Preserves edges where luma differs significantly from center
    vec4 chromaSum = vec4(0.0);
    float chromaW = 0.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec3 samp = rgb2ycbcr(
                texture(u_sourceTexture, v_texCoord + vec2(float(x), float(y)) * step).rgb
            );
            float lumaDiff = abs(samp.x - ycbcrCenter.x);
            float weight = exp(-lumaDiff * lumaDiff * 20.0);
            chromaSum += vec4(samp, 0.0) * weight;
            chromaW += weight;
        }
    }
    vec3 chromaSmoothed = chromaSum.rgb / max(chromaW, 0.001);
    // Blend chroma channels with internal scaling * 0.50 for conservative effect
    ycbcrCenter.yz = mix(ycbcrCenter.yz, chromaSmoothed.yz, strength * 0.50);

    // -- Edge-aware luma smoothing for compression artifacts ------------
    // Small luma gradients = likely compression block boundary
    // Large gradients = real edge, preserve
    vec3 ycbcrN = rgb2ycbcr(texture(u_sourceTexture, v_texCoord + vec2(0.0, -step.y)).rgb);
    vec3 ycbcrS = rgb2ycbcr(texture(u_sourceTexture, v_texCoord + vec2(0.0,  step.y)).rgb);
    vec3 ycbcrW = rgb2ycbcr(texture(u_sourceTexture, v_texCoord + vec2(-step.x, 0.0)).rgb);
    vec3 ycbcrE = rgb2ycbcr(texture(u_sourceTexture, v_texCoord + vec2( step.x, 0.0)).rgb);

    float gradH = abs(ycbcrN.x - ycbcrS.x);
    float gradV = abs(ycbcrW.x - ycbcrE.x);
    float gradMax = max(gradH, gradV);
    float edgeWeight = exp(-gradMax * gradMax * 200.0);
    float smoothStrength = edgeWeight * strength;

    float wN = exp(-abs(ycbcrN.x - ycbcrCenter.x) * 10.0);
    float wS = exp(-abs(ycbcrS.x - ycbcrCenter.x) * 10.0);
    float wW = exp(-abs(ycbcrW.x - ycbcrCenter.x) * 10.0);
    float wE = exp(-abs(ycbcrE.x - ycbcrCenter.x) * 10.0);
    float totalW = wN + wS + wW + wE + 0.001;

    float smoothedLuma = (ycbcrN.x * wN + ycbcrS.x * wS + ycbcrW.x * wW + ycbcrE.x * wE) / totalW;
    ycbcrCenter.x = mix(ycbcrCenter.x, smoothedLuma, smoothStrength * 0.30);
    vec2 smoothedChroma = (ycbcrN.yz * wN + ycbcrS.yz * wS + ycbcrW.yz * wW + ycbcrE.yz * wE) / totalW;
    ycbcrCenter.yz = mix(ycbcrCenter.yz, smoothedChroma, smoothStrength * 0.15);

    vec3 result = clamp(ycbcr2rgb(ycbcrCenter), 0.0, 1.0);
    fragColor = vec4(result, 1.0);
}
