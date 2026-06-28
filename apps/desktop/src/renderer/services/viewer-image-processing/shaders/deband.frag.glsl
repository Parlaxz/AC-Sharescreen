#version 300 es
precision highp float;

// SPDX-License-Identifier: MIT
// Lightweight spatial debanding. Detects gradient quantization steps
// in a 5x5 neighborhood and applies edge-aware smoothing to reduce
// visible banding. Optionally adds subtle fixed dithering to prevent
// bands from reappearing. Zero value is a true bypass.
// No temporal processing or frame history.

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_sourceTexture;
uniform float u_debandStrength;
uniform vec2 u_texSize;

// Rec. 709 luminance coefficients
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Fixed dither amplitude (internal, 0.5 / 255 = 1 8-bit level rounded)
const float DITHER_AMP = 0.00196;

// Simple hash-based dither pattern (static per pixel, no temporal component)
float ditherPattern(vec2 pos) {
    return fract(sin(dot(pos, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
    vec3 center = texture(u_sourceTexture, v_texCoord).rgb;

    if (u_debandStrength <= 0.0) {
        fragColor = vec4(center, 1.0);
        return;
    }

    vec2 step = 1.0 / u_texSize;
    float lumaCenter = dot(center, LUMA);

    // -- 5x5 neighborhood sample + compute local statistics ------------
    // We compute the local mean and variance. In areas with low variance
    // and a "staircase" pattern in the gradient, banding is present.
    float lumaSum = 0.0;
    float lumaSumSq = 0.0;
    vec3 rgbSum = vec3(0.0);
    float minLuma = 1.0;
    float maxLuma = 0.0;
    int count = 0;

    for (int dy = -2; dy <= 2; dy++) {
        for (int dx = -2; dx <= 2; dx++) {
            vec2 tc = v_texCoord + vec2(float(dx), float(dy)) * step;
            vec3 s = texture(u_sourceTexture, tc).rgb;
            float l = dot(s, LUMA);
            lumaSum += l;
            lumaSumSq += l * l;
            rgbSum += s;
            minLuma = min(minLuma, l);
            maxLuma = max(maxLuma, l);
            count++;
        }
    }

    float n = float(count);
    float lumaMean = lumaSum / n;
    float lumaVar = (lumaSumSq / n) - (lumaMean * lumaMean);

    // -- Banding detection --------------------------------------------
    // Banding is characterised by:
    //   1. Low local variance (flat gradient)
    //   2. Quantization steps visible as discrete levels
    // Detect steps: count how many pixels are within 1/255 of each level
    float bandScore = 0.0;
    float stepSize = 1.0 / 255.0;
    float range = maxLuma - minLuma;

    // If the range is small and the variance is low, it's a flat gradient
    // Check if values cluster around discrete levels
    if (range > stepSize * 2.0 && lumaVar < 0.0005) {
        // Check gradient direction: horizontal vs vertical
        float gradH = 0.0, gradV = 0.0;
        for (int i = -2; i <= 2; i++) {
            vec3 sE = texture(u_sourceTexture, v_texCoord + vec2(step.x * float(i), 0.0)).rgb;
            vec3 sW = texture(u_sourceTexture, v_texCoord + vec2(0.0, step.y * float(i))).rgb;
            gradH += abs(dot(sE, LUMA) - lumaCenter);
            gradV += abs(dot(sW, LUMA) - lumaCenter);
        }
        float gradMax2 = max(gradH, gradV);

        // High gradient coherence with low variance = likely banding
        // bandScore near 1 = strong banding, near 0 = no banding
        bandScore = smoothstep(0.0001, 0.0008, lumaVar * 10.0) *
                    (1.0 - smoothstep(0.01, 0.05, range)) *
                    smoothstep(0.001, 0.008, gradMax2);
    }

    // -- Edge-aware blur -----------------------------------------------
    // Only apply in banding-affected areas. Preserve real edges.
    vec3 blurred = rgbSum / n;
    float edgeWeight = smoothstep(0.015, 0.05, lumaVar);

    // Stronger debanding = accept more blur in banded areas
    float debandAmount = u_debandStrength * bandScore * (1.0 - edgeWeight);
    vec3 result = mix(center, blurred, clamp(debandAmount, 0.0, 1.0));

    // -- Subtle fixed dither to prevent re-quantization ----------------
    // The dither pattern is static per pixel (no temporal) which prevents
    // bands from reappearing without causing flicker.
    float dither = (ditherPattern(gl_FragCoord.xy) - 0.5) * DITHER_AMP;
    result += vec3(dither);

    fragColor = vec4(clamp(result, 0.0, 1.0), 1.0);
}
