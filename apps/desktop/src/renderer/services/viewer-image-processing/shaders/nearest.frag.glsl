#version 300 es
precision highp float;

// SPDX-License-Identifier: MIT
// Nearest-neighbour point sampling

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_sourceTexture;
uniform vec2 u_sourceSize;
uniform vec2 u_outputSize;

void main() {
    // Map to nearest texel center
    vec2 texel = v_texCoord * u_sourceSize;
    vec2 nearest = (floor(texel) + 0.5) / u_sourceSize;
    fragColor = texture(u_sourceTexture, nearest);
}
