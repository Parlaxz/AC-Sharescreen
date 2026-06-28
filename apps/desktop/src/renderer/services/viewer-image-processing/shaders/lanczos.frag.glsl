#version 300 es
precision highp float;

// SPDX-License-Identifier: MIT
// Lanczos3 (radius 3, 6-tap per axis) separable texture resampler.
// Standard sinc × sinc-window kernel with weight normalisation.
// Fixed internal anti-ringing clamp (no user-facing slider).

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_sourceTexture;
uniform vec2 u_sourceSize;
uniform vec2 u_outputSize;
uniform float u_antiRinging;

const float PI = 3.141592653589793;
const float RADIUS = 3.0;

float lanczosWeight(float t) {
    if (t == 0.0) return 1.0;
    float at = abs(t);
    if (at >= RADIUS) return 0.0;
    float piT = PI * t;
    float piT2 = piT / RADIUS;
    return (sin(piT) / piT) * (sin(piT2) / piT2);
}

vec4 lanczosSample(sampler2D tex, vec2 coord, vec2 texSize) {
    vec2 pos = coord * texSize - 0.5;
    vec2 f = fract(pos);
    vec2 base = floor(pos);

    vec4 accum = vec4(0.0);
    float totalW = 0.0;

    // 6-tap per axis: -2, -1, 0, 1, 2, 3 (radius 3)
    for (int dy = -2; dy <= 3; dy++) {
        for (int dx = -2; dx <= 3; dx++) {
            vec2 samplePos = (base + vec2(float(dx), float(dy)) + 0.5) / texSize;
            // Clamp sample coordinates to valid texture range
            samplePos = clamp(samplePos, vec2(0.0), vec2(1.0) - 1.0 / texSize);

            float wx = lanczosWeight(float(dx) - f.x);
            float wy = lanczosWeight(float(dy) - f.y);
            float w = wx * wy;
            accum += texture(tex, samplePos) * w;
            totalW += w;
        }
    }
    return accum / max(totalW, 0.0001);
}

// Local 2x2 nearest-source min/max clamp for anti-ringing
vec4 clampNeighborhood(vec4 color, vec2 coord, vec2 texSize) {
    if (u_antiRinging <= 0.0) return color;

    vec2 step = 0.5 / texSize;
    vec3 n0 = texture(u_sourceTexture, coord + vec2(-step.x, -step.y)).rgb;
    vec3 n1 = texture(u_sourceTexture, coord + vec2( step.x, -step.y)).rgb;
    vec3 n2 = texture(u_sourceTexture, coord + vec2(-step.x,  step.y)).rgb;
    vec3 n3 = texture(u_sourceTexture, coord + vec2( step.x,  step.y)).rgb;

    vec3 lo = min(min(n0, n1), min(n2, n3));
    vec3 hi = max(max(n0, n1), max(n2, n3));

    vec3 clamped = clamp(color.rgb, lo, hi);
    return vec4(mix(color.rgb, clamped, u_antiRinging), color.a);
}

void main() {
    vec4 sampled = lanczosSample(u_sourceTexture, v_texCoord, u_sourceSize);
    // Fixed internal anti-ringing (uniform set by backend, default 0.4)
    fragColor = clampNeighborhood(sampled, v_texCoord, u_sourceSize);
}