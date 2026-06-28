#version 300 es
precision highp float;

// SPDX-License-Identifier: MIT
// Lanczos2 (radius 2, 4x4 kernel) texture resampler

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_sourceTexture;
uniform vec2 u_sourceSize;
uniform vec2 u_outputSize;
uniform float u_antiRinging;

float lanczosWeight(float t) {
    if (t == 0.0) return 1.0;
    float at = abs(t);
    if (at >= 2.0) return 0.0;
    float piT = 3.14159265359 * t;
    float piT2 = piT * 0.5;
    return (sin(piT) / piT) * (sin(piT2) / piT2);
}

vec4 lanczosSample(sampler2D tex, vec2 coord, vec2 texSize) {
    vec2 pos = coord * texSize - 0.5;
    vec2 f = fract(pos);
    vec2 base = floor(pos);

    vec4 accum = vec4(0.0);
    float totalW = 0.0;

    for (int dy = -1; dy <= 2; dy++) {
        for (int dx = -1; dx <= 2; dx++) {
            vec2 samplePos = (base + vec2(float(dx), float(dy)) + 0.5) / texSize;
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
    fragColor = clampNeighborhood(sampled, v_texCoord, u_sourceSize);
}
