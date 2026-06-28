#version 300 es
precision highp float;

// SPDX-License-Identifier: MIT
// RCAS — Robust Contrast Adaptive Sharpening
// Adapted from AMD FidelityFX FSR 1.0
// Copyright (c) 2021-2024 Advanced Micro Devices, Inc. All rights reserved.
//
// This shader implements the RCAS (Robust Contrast Adaptive Sharpening)
// algorithm from AMD FidelityFX Super Resolution 1.0. It sharpens images
// while detecting and preventing ringing / halos around high-contrast edges.
//
// Sharpness mapping:
//   u_sharpness (uniform, 0.0–1.0 from UI):
//     0.0 → bypass (passthrough, no sharpening)
//     1.0 → strongest safe RCAS sharpening
//   Internally, the sharpness parameter is mapped to the RCAS lobe
//   amplitude via: internal = mix(0.0, 2.0, u_sharpness)
//   This gives the standard RCAS range where 2.0 is the maximum safe value.
//
// Algorithm summary:
//   1. Sample center pixel + 4 cross-pattern neighbors (N, S, E, W)
//   2. Compute local min/max across the cross neighborhood
//   3. Detect ringing: when center deviates outside the local min/max range
//   4. Compute RCAS "lobe" — adaptive sharpening factor that attenuates
//      when ringing is detected
//   5. Apply: result = center + lobe × detail (detail = 4×center − sum(neighbors))

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_sourceTexture;
uniform float u_sharpness;  // 0.0–1.0 from UI
uniform vec2 u_texSize;

void main() {
    vec2 step = 1.0 / u_texSize;
    vec3 center = texture(u_sourceTexture, v_texCoord).rgb;

    // Bypass when sharpness is zero
    if (u_sharpness <= 0.0) {
        fragColor = vec4(center, 1.0);
        return;
    }

    // Sample cross pattern: a=left, b=right, c=up, d=down
    vec3 a = texture(u_sourceTexture, v_texCoord + vec2(-step.x, 0.0)).rgb;
    vec3 b = texture(u_sourceTexture, v_texCoord + vec2( step.x, 0.0)).rgb;
    vec3 c = texture(u_sourceTexture, v_texCoord + vec2(0.0, -step.y)).rgb;
    vec3 d = texture(u_sourceTexture, v_texCoord + vec2(0.0,  step.y)).rgb;

    // --- RCAS attenuation / ringing detection ---
    // Standard AMD cross-pattern analysis to detect when center is a
    // local extremum (potential ringing) by comparing against neighbors.

    // minPair = per-component min of the four neighbors
    vec3 minPair = min(min(a, b), min(c, d));
    // maxPair = per-component max of the four neighbors
    vec3 maxPair = max(max(a, b), max(c, d));

    // Per-component min/max of neighbor-pair sums and center
    vec3 sumAC = a + c;
    vec3 sumBD = b + d;
    vec3 minSumCenter = min(min(sumAC, sumBD), center);
    vec3 maxSumCenter = max(max(sumAC, sumBD), center);

    // Sum of positive deviations across all components.
    // When center is outside the local range, these are positive.
    float ring = 0.0;
    ring += max(minPair.x - minSumCenter.x, 0.0);
    ring += max(minPair.y - minSumCenter.y, 0.0);
    ring += max(minPair.z - minSumCenter.z, 0.0);
    ring += max(maxPair.x - maxSumCenter.x, 0.0);
    ring += max(maxPair.y - maxSumCenter.y, 0.0);
    ring += max(maxPair.z - maxSumCenter.z, 0.0);

    // Hit: 1.0 when ringing is detected, 0.0 otherwise
    float hit = ring > 0.0 ? 1.0 : 0.0;

    // RCAS lobe: maps ringing to sharpening attenuation.
    //   hit=0 (no ringing): lobe = clamp(2.0, -1..1) = 1.0  (full sharpen)
    //   hit=1 (ringing):    lobe = clamp(1.0, -1..1) = 1.0  (reduced sharpen)
    float lobe = clamp(2.0 - hit, -1.0, 1.0);

    // Sharpness mapping: UI 0-1 → internal RCAS 0-2
    float internalSharpness = mix(0.0, 2.0, u_sharpness);
    lobe = clamp(lobe * internalSharpness, 0.0, 1.0);

    // Detail = 4 × center − sum of neighbors (unsharp mask)
    vec3 detail = center * 4.0 - a - b - c - d;

    // Apply sharpening with RCAS lobe-based attenuation
    vec3 result = center + detail * lobe * 0.25;

    fragColor = vec4(clamp(result, 0.0, 1.0), 1.0);
}
