precision highp float;

uniform vec3 uCameraPos;
uniform vec3 uLightDirWorld;

uniform sampler2D uBaseColor;
uniform sampler2D uNormalMap;
uniform sampler2D uSceneDepth;
uniform sampler2D uFoamMask;

uniform float uTime;
uniform vec2 uAlbedoScroll;
uniform vec2 uNormalScroll;
uniform float uSurfaceTiling;

uniform vec3 uShallowColor;
uniform vec3 uDeepColor;
uniform float uShallowAlpha;
uniform float uDeepAlpha;
uniform float uAbsorption;
uniform float uFoamWidth;
uniform float uFoamOuterShoreOffset; // positive values pull the outer foam origin toward the island
uniform float uFoamStrength;
uniform float uFoamMaskTiling;
uniform vec2 uFoamMaskScroll;
uniform float uFoamMaskThreshold;
uniform vec4 uIslandBounds; // (minX, minZ, maxX, maxZ) — XZ AABB of the island footprint
uniform float uFoamShapeNoiseAmount; // strength of the random perturbation of the OUTER band's outer edge (world units)
uniform float uFoamShapeNoiseScale;  // world-XZ frequency of the shape perturbation noise
uniform vec2 uFoamShapeNoiseScroll;  // drift of the shape noise (slow morph)
uniform float uFoamBaseRingWidth;    // water-column contact width for the thin foam ring (world units)
uniform float uDepthTintAmount; // max amount that depthT shifts color toward uDeepColor (0..1)
uniform float uSurfaceBrightness; // multiplier on the base texture's brightness
uniform float uSpecStrength;
uniform float uFresnelStrength;

uniform float uCameraNear;
uniform float uCameraFar;
uniform vec2 uResolution;

uniform mat4 uInverseProjection;
uniform mat4 uInverseView;

varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vWorldTangent;
varying vec3 vWorldBitangent;

vec3 reconstructWorldPos(vec2 screenUv, float depth) {
  vec4 ndc = vec4(screenUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 viewPos = uInverseProjection * ndc;
  viewPos /= viewPos.w;
  vec4 worldPos = uInverseView * viewPos;
  return worldPos.xyz;
}

/**
 * Sample base color and tangent-space normal from TWO layers at different scales,
 * then blend so the surface doesn't look obviously tiled and base/normal stay coherent
 * within each layer (no "two surfaces drifting apart" look).
 */
void sampleSurface(out vec3 baseSample, out vec3 nWorld) {
  vec2 uvA = vUv * uSurfaceTiling + uTime * uAlbedoScroll;
  vec2 uvB = vUv * (uSurfaceTiling * 0.55) + uTime * uNormalScroll;

  vec3 baseA = texture2D(uBaseColor, uvA).rgb;
  vec3 baseB = texture2D(uBaseColor, uvB).rgb;
  baseSample = mix(baseA, baseB, 0.5);

  vec3 nLocalA = texture2D(uNormalMap, uvA).xyz * 2.0 - 1.0;
  vec3 nLocalB = texture2D(uNormalMap, uvB).xyz * 2.0 - 1.0;
  vec3 nLocal = normalize(nLocalA + nLocalB);

  mat3 tbn = mat3(vWorldTangent, vWorldBitangent, vWorldNormal);
  nWorld = normalize(tbn * nLocal);
}

void main() {
  vec2 screenUv = gl_FragCoord.xy / uResolution;

  // Reconstruct world position of underwater geometry behind this pixel.
  float sceneDepth = texture2D(uSceneDepth, screenUv).r;
  vec3 floorWorld = reconstructWorldPos(screenUv, sceneDepth);

  // World-space water column (angle-independent).
  float worldColumn = max(0.0, vWorldPos.y - floorWorld.y);
  float depthT = clamp(1.0 - exp(-worldColumn * uAbsorption), 0.0, 1.0);

  // Two-layer surface sample (texture + normal sampled coherently within each layer).
  vec3 baseSample;
  vec3 n;
  sampleSurface(baseSample, n);

  vec3 viewDir = normalize(uCameraPos - vWorldPos);
  vec3 lightDir = normalize(uLightDirWorld);

  // === SURFACE ===
  // Surface = lit texture, tinted slightly by shallow color so it matches the water palette.
  float ndotl = max(0.0, dot(n, lightDir));
  vec3 surfaceAlbedo = baseSample * uSurfaceBrightness;
  // Bias the surface a bit toward the shallow color so the texture reads as "water" not just a generic image.
  surfaceAlbedo = mix(surfaceAlbedo, surfaceAlbedo * uShallowColor * 2.0, 0.5);
  vec3 surfaceLit = surfaceAlbedo * (0.55 + 0.45 * ndotl);

  // Specular twinkle from the normal map — always visible (this is how you "see" the normals).
  vec3 R = reflect(-lightDir, n);
  float spec = pow(max(0.0, dot(R, viewDir)), 80.0);
  vec3 specular = vec3(spec) * uSpecStrength;

  // Fresnel rim — adds sky-tinted reflection at glancing angles.
  float fres = pow(1.0 - max(0.0, dot(n, viewDir)), 5.0);
  vec3 fresnel = vec3(0.78, 0.88, 1.0) * fres * uFresnelStrength;

  vec3 surface = surfaceLit + specular + fresnel;

  // === DEPTH TINT ===
  // Mix surface toward deepColor by depthT, capped so the texture is never fully erased.
  vec3 color = mix(surface, uDeepColor, depthT * uDepthTintAmount);

  // === FOAM ===
  // View-angle independent: world-space horizontal distance from this water pixel
  // to the island's XZ footprint. >0 outside, <=0 inside (under the mesh).
  vec2 xz = vWorldPos.xz;
  float dx = max(uIslandBounds.x - xz.x, xz.x - uIslandBounds.z);
  float dz = max(uIslandBounds.y - xz.y, xz.y - uIslandBounds.w);
  float distOutsideIsland = max(dx, dz);

  // ============================================================
  // FOAM — two fully independent layers, combined with max().
  // Inner ring: own width knob, no mask. Outer foam: own width knob, mask-gated.
  // The two do not reference each other.
  // ============================================================

  // --- Inner ring (independent) ---
  // Solid contact foam where the actual opaque mesh is close to the water surface.
  // This hugs the visible shore mesh instead of drawing the island's rectangular XZ bounds.
  //
  // IMPORTANT: smoothstep(0, w, worldColumn) returns 0 for any worldColumn <= 0, meaning
  // (1 - smoothstep(...)) = 1 over the ENTIRE band of "worldColumn ≈ 0" pixels regardless of w.
  // The size of that band is set by depth-pass + rasterization, not the width knob — which is
  // exactly why shrinking `foamBaseRingWidth` previously had no visible effect.
  // Gating the strength by smoothstep(0, ε, w) makes width=0 → ring=0, and small widths fade
  // proportionally so the visible ring shrinks AND dims as you decrease the knob.
  float ringEnabled = smoothstep(0.0, 0.005, uFoamBaseRingWidth);
  float innerRing = ringEnabled * (1.0 - smoothstep(0.0, max(uFoamBaseRingWidth, 1e-6), worldColumn));
  innerRing = pow(innerRing, 0.7);

  // --- Outer foam (independent) ---
  // Foam mask: two scrolling samples for non-tiling animated patches.
  vec2 maskUvA = vUv * uFoamMaskTiling + uTime * uFoamMaskScroll;
  vec2 maskUvB = vUv * (uFoamMaskTiling * 1.35) + uTime * (uFoamMaskScroll * vec2(-0.7, 0.9));
  float maskRaw = max(texture2D(uFoamMask, maskUvA).r, texture2D(uFoamMask, maskUvB).r);
  float maskOuter = smoothstep(uFoamMaskThreshold, 1.0, maskRaw);

  // Shape noise wobbles the outer silhouette only.
  // IMPORTANT: shape offset is expressed as a FRACTION of uFoamWidth, NOT absolute world units.
  // This way, when uFoamWidth -> 0 the shape noise contribution -> 0 too, so the outer foam
  // genuinely vanishes (no residual band leaking out from shape noise).
  vec2 sUvA = xz * uFoamShapeNoiseScale + uTime * uFoamShapeNoiseScroll;
  vec2 sUvB = xz * (uFoamShapeNoiseScale * 0.62) + uTime * (uFoamShapeNoiseScroll * vec2(-1.3, 0.8));
  float shapeNoise = (texture2D(uFoamMask, sUvA).r + texture2D(uFoamMask, sUvB).r) * 0.5;
  float shapeOffset = (shapeNoise - 0.5) * uFoamShapeNoiseAmount * uFoamWidth;

  // Outer foam fades from an adjustable shore origin to 0 at (foamWidth + shapeOffset), gated by patches.
  // foamWidth is in absolute world units, independent of foamBaseRingWidth.
  float outerDistance = max(0.0, distOutsideIsland + uFoamOuterShoreOffset);
  float outerReach = max(uFoamWidth + shapeOffset, 1e-4);
  float outerFade = 1.0 - smoothstep(0.0, outerReach, outerDistance);
  outerFade = pow(outerFade, 1.4);
  float outerFoam = outerFade * maskOuter;

  // --- Combine: inner ring sits as a guaranteed solid floor; outer patches add on top. ---
  float foam = clamp(max(innerRing, outerFoam) * uFoamStrength, 0.0, 1.0);
  color = mix(color, vec3(0.96, 0.98, 1.0), foam);

  // === ALPHA ===
  // Shallow water is more transparent (you see underwater geometry through it).
  float alpha = mix(uShallowAlpha, uDeepAlpha, depthT);
  alpha = mix(alpha, 1.0, foam);

  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
}
