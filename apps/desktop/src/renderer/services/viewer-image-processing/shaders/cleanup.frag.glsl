#version 300 es
precision highp float;

// SPDX-License-Identifier: MIT
// Chroma cleanup + compression smoothing (edge-aware, preserves text/UI edges)

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_sourceTexture;
uniform float u_chromaCleanup;
uniform float u_compressionSmoothing;
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
    if (u_chromaCleanup <= 0.0 && u_compressionSmoothing <= 0.0) {
        fragColor = vec4(center, 1.0);
        return;
    }

    vec2 step = 1.0 / u_texSize;
    vec3 ycbcrCenter = rgb2ycbcr(center);

    // -- Chroma cleanup -----------------------------------------------
    if (u_chromaCleanup > 0.0) {
        // Edge-aware chroma smoothing using luma difference weights
        vec4 chromaSum = vec4(0.0);
        float chromaW = 0.0;

        for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
                vec3 samp = rgb2ycbcr(
                    texture(u_sourceTexture, v_texCoord + vec2(float(x), float(y)) * step).rgb
                );
                // Edge-aware weight: preserve edges where luma differs significantly
                float lumaDiff = abs(samp.x - ycbcrCenter.x);
                float weight = exp(-lumaDiff * lumaDiff * 20.0);
                chromaSum += vec4(samp, 0.0) * weight;
                chromaW += weight;
            }
        }

        vec3 smoothed = chromaSum.rgb / max(chromaW, 0.001);
        // Only blend chroma channels (Cb, Cr), preserve luma unchanged
        ycbcrCenter.yz = mix(ycbcrCenter.yz, smoothed.yz, u_chromaCleanup);
    }

    // -- Compression smoothing (replaces deblocking) ------------------
    // Conservative edge-aware smoothing of weak compression discontinuities.
    // Preserves strong text/UI edges. Zero values bypass entirely.
    if (u_compressionSmoothing > 0.0) {
        // Sample 4 direct neighbors in YCbCr
        vec3 ycbcrN = rgb2ycbcr(texture(u_sourceTexture, v_texCoord + vec2(0.0, -step.y)).rgb);
        vec3 ycbcrS = rgb2ycbcr(texture(u_sourceTexture, v_texCoord + vec2(0.0,  step.y)).rgb);
        vec3 ycbcrW = rgb2ycbcr(texture(u_sourceTexture, v_texCoord + vec2(-step.x, 0.0)).rgb);
        vec3 ycbcrE = rgb2ycbcr(texture(u_sourceTexture, v_texCoord + vec2( step.x, 0.0)).rgb);

        // Luma gradients: small = likely compression artifact, large = real edge
        float gradH = abs(ycbcrN.x - ycbcrS.x);
        float gradV = abs(ycbcrW.x - ycbcrE.x);
        float gradMax = max(gradH, gradV);

        // Edge detection: weight toward 1 for weak edges, 0 for strong edges
        // Use a soft falloff so strong text edges suppress smoothing entirely
        // but weak compression discontinuities get smoothed
        float edgeWeight = exp(-gradMax * gradMax * 200.0);

        // Conservative blend: only smooth when gradient is small
        float smoothStrength = edgeWeight * u_compressionSmoothing;

        // Weighted neighbor blend for smoothing (edge-aware weights)
        float wN = exp(-abs(ycbcrN.x - ycbcrCenter.x) * 10.0);
        float wS = exp(-abs(ycbcrS.x - ycbcrCenter.x) * 10.0);
        float wW = exp(-abs(ycbcrW.x - ycbcrCenter.x) * 10.0);
        float wE = exp(-abs(ycbcrE.x - ycbcrCenter.x) * 10.0);
        float totalW = wN + wS + wW + wE + 0.001;

        // Blend luma with neighbors (weighted)
        float smoothedLuma = (ycbcrN.x * wN + ycbcrS.x * wS + ycbcrW.x * wW + ycbcrE.x * wE) / totalW;
        ycbcrCenter.x = mix(ycbcrCenter.x, smoothedLuma, smoothStrength * 0.3);

        // Blend chroma similarly for compression artifacts
        vec2 smoothedChroma = (ycbcrN.yz * wN + ycbcrS.yz * wS + ycbcrW.yz * wW + ycbcrE.yz * wE) / totalW;
        ycbcrCenter.yz = mix(ycbcrCenter.yz, smoothedChroma, smoothStrength * 0.15);
    }

    vec3 result = clamp(ycbcr2rgb(ycbcrCenter), 0.0, 1.0);
    fragColor = vec4(result, 1.0);
}
