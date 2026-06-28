#version 300 es
precision highp float;

// SPDX-License-Identifier: MIT
// FidelityFX Super Resolution Sample
//
// Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files(the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and / or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions :
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
//
// WebGL2 GLSL ES 3.00 port of the AMD FidelityFX FSR 1 EASU 32-bit float path.

in vec2 v_texCoord;
out vec4 fragColor;

uniform highp sampler2D u_sourceTexture;
uniform vec2 u_sourceSize;
uniform vec2 u_outputSize;
uniform float u_antiRinging;
uniform vec4 u_easuCon0;
uniform vec4 u_easuCon1;
uniform vec4 u_easuCon2;
uniform vec4 u_easuCon3;

float saturate(float v) {
    return clamp(v, 0.0, 1.0);
}

float safeRcp(float v) {
    return 1.0 / max(abs(v), 1.0e-8);
}

float safeRsq(float v) {
    return inversesqrt(max(v, 1.0e-8));
}

float easuLuma(vec3 c) {
    return c.b * 0.5 + (c.r * 0.5 + c.g);
}

vec3 easuLoad(vec2 pixelPos) {
    vec2 clamped = clamp(pixelPos, vec2(0.0), max(u_sourceSize - vec2(1.0), vec2(0.0)));
    return texture(u_sourceTexture, (clamped + vec2(0.5)) * u_easuCon1.xy).rgb;
}

void fsrEasuTap(
    inout vec3 aC,
    inout float aW,
    vec2 off,
    vec2 dir,
    vec2 len,
    float lob,
    float clp,
    vec3 c
) {
    vec2 v;
    v.x = off.x * dir.x + off.y * dir.y;
    v.y = off.x * -dir.y + off.y * dir.x;
    v *= len;

    float d2 = v.x * v.x + v.y * v.y;
    d2 = min(d2, clp);

    float wB = 0.4 * d2 - 1.0;
    float wA = lob * d2 - 1.0;
    wB *= wB;
    wA *= wA;
    wB = (25.0 / 16.0) * wB - (25.0 / 16.0 - 1.0);

    float w = wB * wA;
    aC += c * w;
    aW += w;
}

void fsrEasuSet(
    inout vec2 dir,
    inout float len,
    vec2 pp,
    bool biS,
    bool biT,
    bool biU,
    bool biV,
    float lA,
    float lB,
    float lC,
    float lD,
    float lE
) {
    float w = 0.0;
    if (biS) w = (1.0 - pp.x) * (1.0 - pp.y);
    if (biT) w = pp.x * (1.0 - pp.y);
    if (biU) w = (1.0 - pp.x) * pp.y;
    if (biV) w = pp.x * pp.y;

    float dc = lD - lC;
    float cb = lC - lB;
    float lenX = safeRcp(max(abs(dc), abs(cb)));
    float dirX = lD - lB;
    dir.x += dirX * w;
    lenX = saturate(abs(dirX) * lenX);
    lenX *= lenX;
    len += lenX * w;

    float ec = lE - lC;
    float ca = lC - lA;
    float lenY = safeRcp(max(abs(ec), abs(ca)));
    float dirY = lE - lA;
    dir.y += dirY * w;
    lenY = saturate(abs(dirY) * lenY);
    lenY *= lenY;
    len += lenY * w;
}

void main() {
    vec2 ip = floor(gl_FragCoord.xy);
    vec2 pp = ip * u_easuCon0.xy + u_easuCon0.zw;
    vec2 fp = floor(pp);
    pp -= fp;

    // Official EASU 12-tap footprint:
    //     b c
    //   e f g h
    //   i j k l
    //     n o
    vec3 b = easuLoad(fp + vec2( 0.0, -1.0));
    vec3 c = easuLoad(fp + vec2( 1.0, -1.0));
    vec3 e = easuLoad(fp + vec2(-1.0,  0.0));
    vec3 f = easuLoad(fp + vec2( 0.0,  0.0));
    vec3 g = easuLoad(fp + vec2( 1.0,  0.0));
    vec3 h = easuLoad(fp + vec2( 2.0,  0.0));
    vec3 i = easuLoad(fp + vec2(-1.0,  1.0));
    vec3 j = easuLoad(fp + vec2( 0.0,  1.0));
    vec3 k = easuLoad(fp + vec2( 1.0,  1.0));
    vec3 l = easuLoad(fp + vec2( 2.0,  1.0));
    vec3 n = easuLoad(fp + vec2( 0.0,  2.0));
    vec3 o = easuLoad(fp + vec2( 1.0,  2.0));

    float bL = easuLuma(b);
    float cL = easuLuma(c);
    float eL = easuLuma(e);
    float fL = easuLuma(f);
    float gL = easuLuma(g);
    float hL = easuLuma(h);
    float iL = easuLuma(i);
    float jL = easuLuma(j);
    float kL = easuLuma(k);
    float lL = easuLuma(l);
    float nL = easuLuma(n);
    float oL = easuLuma(o);

    vec2 dir = vec2(0.0);
    float len = 0.0;
    fsrEasuSet(dir, len, pp, true,  false, false, false, bL, eL, fL, gL, jL);
    fsrEasuSet(dir, len, pp, false, true,  false, false, cL, fL, gL, hL, kL);
    fsrEasuSet(dir, len, pp, false, false, true,  false, fL, iL, jL, kL, nL);
    fsrEasuSet(dir, len, pp, false, false, false, true,  gL, jL, kL, lL, oL);

    float dirR = dot(dir, dir);
    bool zro = dirR < (1.0 / 32768.0);
    dirR = safeRsq(dirR);
    dir = zro ? vec2(1.0, 0.0) : dir * dirR;

    len *= 0.5;
    len *= len;

    float stretch = dot(dir, dir) * safeRcp(max(abs(dir.x), abs(dir.y)));
    vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
    float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
    float clp = safeRcp(lob);

    vec3 min4 = min(min(f, g), min(j, k));
    vec3 max4 = max(max(f, g), max(j, k));

    vec3 aC = vec3(0.0);
    float aW = 0.0;
    fsrEasuTap(aC, aW, vec2( 0.0, -1.0) - pp, dir, len2, lob, clp, b);
    fsrEasuTap(aC, aW, vec2( 1.0, -1.0) - pp, dir, len2, lob, clp, c);
    fsrEasuTap(aC, aW, vec2(-1.0,  1.0) - pp, dir, len2, lob, clp, i);
    fsrEasuTap(aC, aW, vec2( 0.0,  1.0) - pp, dir, len2, lob, clp, j);
    fsrEasuTap(aC, aW, vec2( 0.0,  0.0) - pp, dir, len2, lob, clp, f);
    fsrEasuTap(aC, aW, vec2(-1.0,  0.0) - pp, dir, len2, lob, clp, e);
    fsrEasuTap(aC, aW, vec2( 1.0,  1.0) - pp, dir, len2, lob, clp, k);
    fsrEasuTap(aC, aW, vec2( 2.0,  1.0) - pp, dir, len2, lob, clp, l);
    fsrEasuTap(aC, aW, vec2( 2.0,  0.0) - pp, dir, len2, lob, clp, h);
    fsrEasuTap(aC, aW, vec2( 1.0,  0.0) - pp, dir, len2, lob, clp, g);
    fsrEasuTap(aC, aW, vec2( 1.0,  2.0) - pp, dir, len2, lob, clp, o);
    fsrEasuTap(aC, aW, vec2( 0.0,  2.0) - pp, dir, len2, lob, clp, n);

    vec3 raw = aC * safeRcp(aW);
    // Note: u_antiRinging neighborhood clamp is non-AMD-standard.
    // The official AMD FSR 1 EASU does not include a neighborhood
    // anti-ringing pass — it relies entirely on the adaptive
    // EASU reconstruction filter to suppress ringing.
    // This is a ScreenLink addition for safety on aggressively
    // compressed streams where EASU can produce overshoot.
    vec3 deringed = clamp(raw, min4, max4);
    vec3 pix = mix(raw, deringed, clamp(u_antiRinging, 0.0, 1.0));

    fragColor = vec4(clamp(pix, 0.0, 1.0), 1.0);
}
