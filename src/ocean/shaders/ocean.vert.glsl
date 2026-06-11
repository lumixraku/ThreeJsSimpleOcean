precision highp float;

uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

uniform sampler2D uHeightMap;
uniform float uTime;
uniform vec2 uHeightScroll;
uniform float uHeightTiling;
uniform float uDisplacement;
uniform mat4 uMirrorMatrix; // world → planar-reflection UV (projective)

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

varying vec2 vUv;
varying vec3 vWorldPos;
varying vec4 vMirrorCoord;

void main() {
  vUv = uv;

  // Two scrolls at different scales/speeds reduce temporal flicker.
  vec2 uvDisp1 = uv * uHeightTiling + uTime * uHeightScroll;
  vec2 uvDisp2 = uv * (uHeightTiling * 0.55) + uTime * (uHeightScroll * -0.8 + vec2(0.002, -0.001));
  float h1 = texture2D(uHeightMap, uvDisp1).r;
  float h2 = texture2D(uHeightMap, uvDisp2).r;
  float h = mix(h1, h2, 0.45);

  float disp = (h - 0.5) * 2.0 * uDisplacement;
  vec3 displaced = position + normal * disp;

  vWorldPos = (modelMatrix * vec4(displaced, 1.0)).xyz;
  vMirrorCoord = uMirrorMatrix * vec4(vWorldPos, 1.0);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
