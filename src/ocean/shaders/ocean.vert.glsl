precision highp float;

uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;

uniform sampler2D uHeightMap;
uniform float uTime;
uniform vec2 uHeightScroll;
uniform float uHeightTiling;
uniform float uDisplacement;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
attribute vec4 tangent;

varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vWorldTangent;
varying vec3 vWorldBitangent;

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

  vec4 world = modelMatrix * vec4(displaced, 1.0);
  vWorldPos = world.xyz;

  vec3 n = normalize(mat3(modelMatrix) * normal);
  vec3 t = normalize(mat3(modelMatrix) * tangent.xyz);
  vec3 b = normalize(cross(n, t) * tangent.w);
  vWorldNormal = n;
  vWorldTangent = t;
  vWorldBitangent = b;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
