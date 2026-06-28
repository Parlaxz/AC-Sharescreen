#version 300 es
precision highp float;

// SPDX-License-Identifier: MIT
// Bicubic Catmull-Rom 4x4 texture filter

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_sourceTexture;
uniform vec2 u_sourceSize;
uniform vec2 u_outputSize;
uniform float u_antiRinging;

// Catmull-Rom cubic weight: 0.5 * |t|^3 - 2.5 * |t|^2 + 4 * |t| - 2  for |t| <= 2
// Simplified piecewise:
float weight(float t) {
    float at = abs(t);
    float at2 = at * at;
    float at3 = at2 * at;
    if (at < 1.0) {
        return 1.5 * at3 - 2.5 * at2 + 1.0;
    } else if (at < 2.0) {
        return -0.5 * at3 + 2.5 * at2 - 4.0 * at + 2.0;
    }
    return 0.0;
}

vec4 bicubicSample(sampler2D tex, vec2 coord, vec2 texSize) {
    vec2 pos = coord * texSize - 0.5;
    vec2 f = fract(pos);
    vec2 base = floor(pos);

    vec4 accum = vec4(0.0);
    float totalW = 0.0;

    for (int dy = -1; dy <= 2; dy++) {
        for (int dx = -1; dx <= 2; dx++) {
            vec2 samplePos = (base + vec2(float(dx), float(dy)) + 0.5) / texSize;
            float wx = weight(float(dx) - f.x);
            float wy = weight(float(dy) - f.y);
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
    vec4 sampled = bicubicSample(u_sourceTexture, v_texCoord, u_sourceSize);
    fragColor = clampNeighborhood(sampled, v_texCoord, u_sourceSize);
}
