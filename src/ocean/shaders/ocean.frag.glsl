precision highp float;

uniform vec3 uCameraPos;
uniform vec3 uLightDirWorld;
uniform vec3 uSunColor;

uniform sampler2D uBaseColor;
uniform sampler2D uNormalMap;
uniform sampler2D uSceneDepth;
uniform sampler2D uFoamMask;
uniform sampler2D uReflectionMap;

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
uniform vec4 uIslandBounds; // (minX, minZ, maxX, maxZ) — XZ AABB of the island footprint (AABB foam path)
uniform sampler2D uShoreSdf;        // baked top-down shore distance field (R = normalized distance from land)
uniform vec4 uShoreSdfBounds;       // (minX, minZ, maxX, maxZ) — world XZ rectangle the SDF covers
uniform float uShoreSdfMaxDistance; // world units that map to R == 1.0 in the SDF
uniform float uUseShoreSdf;         // 0 = AABB path, 1 = sample uShoreSdf instead
uniform float uFoamShapeNoiseAmount; // strength of the random perturbation of the OUTER band's outer edge (world units)
uniform float uFoamShapeNoiseScale;  // world-XZ frequency of the shape perturbation noise
uniform vec2 uFoamShapeNoiseScroll;  // drift of the shape noise (slow morph)
uniform float uFoamBaseRingWidth;    // water-column contact width for the thin foam ring (world units)
uniform float uDepthTintAmount; // max amount that depthT shifts color toward uDeepColor (0..1)
uniform float uSurfaceBrightness; // multiplier on the base texture's brightness
uniform float uSpecStrength;
uniform float uFresnelStrength;
uniform float uReflectionMaxDistance; // world distance that maps to distanceT == 1.0
uniform vec2 uReflectionDistanceRange; // (start, end) in normalized distanceT for the smoothstep fade
uniform vec3 uReflectionTint;          // uniform 360° baseline sky-tint reflected on far water

uniform float uCameraNear;
uniform float uCameraFar;
uniform vec2 uResolution;

uniform mat4 uInverseProjection;
uniform mat4 uInverseView;

varying vec2 vUv;
varying vec3 vWorldPos;
varying vec4 vMirrorCoord;

vec3 reconstructWorldPos(vec2 screenUv, float depth) {
  vec4 ndc = vec4(screenUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 viewPos = uInverseProjection * ndc;
  viewPos /= viewPos.w;
  vec4 worldPos = uInverseView * viewPos;
  return worldPos.xyz;
}

/**
 * Canonical Three.js Water `getNoise`: 4 taps of the normal map at four wildly different
 * scales/scrolls, summed to break visible tiling and produce the cross-scale wave interference
 * that gives the official Water demo its look. Each component of the result lives in [-1, 1].
 */
vec4 getWaterNoise(vec2 uv) {
  vec2 uv0 = (uv / 103.0) + vec2(uTime / 17.0, uTime / 29.0);
  vec2 uv1 = uv / 107.0 - vec2(uTime / -19.0, uTime / 31.0);
  vec2 uv2 = uv / vec2(8907.0, 9803.0) + vec2(uTime / 101.0, uTime / 97.0);
  vec2 uv3 = uv / vec2(1091.0, 1027.0) - vec2(uTime / 109.0, uTime / -113.0);
  vec4 n = texture2D(uNormalMap, uv0)
         + texture2D(uNormalMap, uv1)
         + texture2D(uNormalMap, uv2)
         + texture2D(uNormalMap, uv3);
  return n * 0.5 - 1.0;
}

/** Two-layer cross-fade of the base color texture — hides UV tiling. */
vec3 sampleBaseColor() {
  vec2 uvA = vUv * uSurfaceTiling + uTime * uAlbedoScroll;
  vec2 uvB = vUv * (uSurfaceTiling * 0.55) + uTime * uNormalScroll;
  vec3 baseA = texture2D(uBaseColor, uvA).rgb;
  vec3 baseB = texture2D(uBaseColor, uvB).rgb;
  return mix(baseA, baseB, 0.5);
}

/**
 * World-space surface normal from the Water noise. Driven by world XZ so wavelength is locked
 * to world units (not mesh UV tessellation). The mesh is a flat plane, so the noise vector is
 * already in a world-aligned basis — no TBN needed. `.xzy` maps the normal map's B-as-up
 * tangent convention into world Y-up; `(1.5, 1.0, 1.5)` biases the horizontal tilt to match
 * the official Water demo.
 */
vec3 sampleSurfaceNormal() {
  vec4 noise = getWaterNoise(vWorldPos.xz);
  return normalize(vec3(noise.x, noise.z, noise.y) * vec3(1.5, 1.0, 1.5));
}

void main() {
  vec2 screenUv = gl_FragCoord.xy / uResolution;

  // Reconstruct world position of underwater geometry behind this pixel.
  float sceneDepth = texture2D(uSceneDepth, screenUv).r;
  vec3 floorWorld = reconstructWorldPos(screenUv, sceneDepth);

  // Occlusion test in WORLD units. A raw-depth epsilon here (old: sceneDepth + 0.0002 <
  // gl_FragCoord.z) is NOT angle-safe with this near/far range: it expands to ~0.002·d² m of
  // slack, so from a high camera the whole dry island read as "behind the water" and the
  // contact-foam ring flooded it. A constant 5 cm along the view ray is what the bias meant.
  if (distance(uCameraPos, floorWorld) + 0.05 < distance(uCameraPos, vWorldPos)) discard;

  // World-space water column (angle-independent).
  float worldColumn = max(0.0, vWorldPos.y - floorWorld.y);
  float depthT = clamp(1.0 - exp(-worldColumn * uAbsorption), 0.0, 1.0);

  vec3 baseSample = sampleBaseColor();
  vec3 n = sampleSurfaceNormal();

  vec3 viewDir = normalize(uCameraPos - vWorldPos);
  vec3 lightDir = normalize(uLightDirWorld);

  // === SURFACE ===
  // Surface = lit texture, tinted slightly by shallow color so it matches the water palette.
  float ndotl = max(0.0, dot(n, lightDir));
  vec3 surfaceAlbedo = baseSample * uSurfaceBrightness;
  // Bias the surface a bit toward the shallow color so the texture reads as "water" not just a generic image.
  surfaceAlbedo = mix(surfaceAlbedo, surfaceAlbedo * uShallowColor * 2.0, 0.5);
  vec3 surfaceLit = surfaceAlbedo * (0.55 + 0.45 * ndotl);

  // Canonical Three.js Water sun specular: a sharp pow100 highlight tinted by the atmosphere-
  // synced sun color. The factor of 2 matches Water's `spec=2.0` argument to sunLight().
  // uSpecStrength keeps the existing tunable so values from the old shader still mean something.
  vec3 R = reflect(-lightDir, n);
  float spec = pow(max(0.0, dot(R, viewDir)), 100.0);
  vec3 specular = uSunColor * (2.0 * spec * uSpecStrength);

  // === REFLECTION ===
  // Intensity: full Schlick, `F0 + (1 - F0) * pow(1 - h/dist3d, 5)`, based purely on camera
  // height above the water (h) and the 3D camera→water distance. h/dist3d is the cosine of the
  // incidence angle from the surface normal, so the shape term is x^5 of an input that is
  // mathematically guaranteed to live in [0,1]:
  //   - water directly below camera: h/dist3d == 1 → shape term 0 → reflection == F0 (faint)
  //   - water at horizon: dist3d → ∞ → input → 1 → reflection → 1 (full mirror)
  // The F0 base term matters: without it, raising the camera crushes the x^5 term to zero and
  // ALL reflections vanish from elevated views. Real water keeps ~2% reflectance at normal
  // incidence; we use a slightly higher stylized base so it stays readable.
  // Strength is a pure function of (h, dist3d), not of view direction or screen position, so
  // 360° camera yaw gives identical reflection per distance.
  float h = max(uCameraPos.y - vWorldPos.y, 0.0);
  float dist3d = max(length(uCameraPos - vWorldPos), 1e-4);
  float fresInput = clamp(1.0 - h / dist3d, 0.0, 1.0);
  float reflectionAmount =
    clamp((0.08 + 0.92 * pow(fresInput, 5.0)) * uFresnelStrength, 0.0, 1.0);
  float viewDistance = length(uCameraPos.xz - vWorldPos.xz);

  // Content: true planar reflection — the scene rendered from a camera mirrored across the
  // water plane (see PlanarReflection.ts), valid at any camera angle. Projective sampling of
  // vMirrorCoord; the wave normal perturbs the UV for surface distortion.
  vec2 mirrorUv = vMirrorCoord.xy / max(vMirrorCoord.w, 1e-6);
  mirrorUv = clamp(mirrorUv + n.xz * 0.02, 0.0, 1.0);
  vec3 reflectColor = texture2D(uReflectionMap, mirrorUv).rgb;

  vec3 surface = surfaceLit + specular;

  // === DEPTH TINT ===
  // Mix surface toward deepColor by depthT, capped so the texture is never fully erased.
  vec3 color = mix(surface, uDeepColor, depthT * uDepthTintAmount);
  color = mix(color, reflectColor, reflectionAmount);

  // === FOAM ===
  // View-angle independent: world-space horizontal distance from this water pixel to the actual shore.
  //
  //   uUseShoreSdf == 1 → sample a pre-baked top-down distance field. Hugs any silhouette
  //                       (peninsulas, bays, archipelagos, jagged tile coasts). Recommended.
  //   uUseShoreSdf == 0 → fall back to a single XZ AABB. Cheap, fine for rectangular islands,
  //                       but produces a rectangular foam band around irregular geometry.
  vec2 xz = vWorldPos.xz;
  float distOutsideIsland;
  if (uUseShoreSdf > 0.5) {
    vec2 sdfUv = (xz - uShoreSdfBounds.xy) / max(uShoreSdfBounds.zw - uShoreSdfBounds.xy, vec2(1e-6));
    sdfUv = clamp(sdfUv, 0.0, 1.0);
    distOutsideIsland = texture2D(uShoreSdf, sdfUv).r * uShoreSdfMaxDistance;
  } else {
    float dx = max(uIslandBounds.x - xz.x, xz.x - uIslandBounds.z);
    float dz = max(uIslandBounds.y - xz.y, xz.y - uIslandBounds.w);
    distOutsideIsland = max(dx, dz);
  }

  // Two independent foam layers combined with max(): a thin solid inner ring at the actual
  // water/land contact line, plus a wider mask-gated outer wash. Neither references the other.

  // --- Inner ring ---
  // `ringEnabled` gates the strength so foamBaseRingWidth=0 produces no ring at all. Without
  // this, smoothstep(0, w, worldColumn) returns 0 for worldColumn ≤ 0 regardless of w, so
  // shrinking the knob has no visible effect.
  float ringEnabled = smoothstep(0.0, 0.005, uFoamBaseRingWidth);
  float innerRing = ringEnabled * (1.0 - smoothstep(0.0, max(uFoamBaseRingWidth, 1e-6), worldColumn));
  innerRing = pow(innerRing, 0.7);
  // Suppress the contact ring on isolated depth casters (e.g. open-water posts) by gating on
  // distance from the actual shore SDF/AABB.
  float nearLand = 1.0 - smoothstep(0.0, 0.5, distOutsideIsland);
  innerRing *= nearLand;

  // --- Outer foam ---
  // Two scrolling world-XZ samples of the foam mask, combined so the wash pattern doesn't tile.
  vec2 maskUvA = xz * uFoamMaskTiling + uTime * uFoamMaskScroll;
  vec2 maskUvB = xz * (uFoamMaskTiling * 1.35) + uTime * (uFoamMaskScroll * vec2(-0.7, 0.9));
  float maskRaw = max(texture2D(uFoamMask, maskUvA).r, texture2D(uFoamMask, maskUvB).r);
  float maskOuter = smoothstep(uFoamMaskThreshold, 1.0, maskRaw);

  // Outer silhouette wobble — shape offset is a FRACTION of uFoamWidth, not absolute world units,
  // so the rim disappears cleanly when foamWidth → 0.
  vec2 shapeSeedA = xz * uFoamShapeNoiseScale + uTime * uFoamShapeNoiseScroll;
  vec2 shapeSeedB = xz * (uFoamShapeNoiseScale * 0.62) + uTime * (uFoamShapeNoiseScroll * vec2(-1.3, 0.8));
  float shapeNoise = fract(sin(dot(shapeSeedA, vec2(12.9898, 78.233)) + dot(shapeSeedB, vec2(39.3468, 11.1355))) * 43758.5453);
  float shapeOffset = (shapeNoise - 0.5) * uFoamShapeNoiseAmount * uFoamWidth;

  // Narrow unmasked SDF core keeps the visible shore continuous; the wider wash is mask-gated.
  float outerEnabled = smoothstep(0.0, 0.005, uFoamWidth);
  float shoreCoreWidth = max(uFoamWidth * 0.35, 1e-6);
  float shoreCore = outerEnabled * (1.0 - smoothstep(0.0, shoreCoreWidth, max(0.0, distOutsideIsland)));
  float outerDistance = max(0.0, distOutsideIsland + uFoamOuterShoreOffset);
  float outerReach = max(uFoamWidth + shapeOffset, 1e-4);
  float outerFade = pow(1.0 - smoothstep(0.0, outerReach, outerDistance), 1.4);
  float outerFoam = outerEnabled * max(shoreCore, outerFade * maskOuter);

  float foam = clamp(max(innerRing, outerFoam) * uFoamStrength, 0.0, 1.0);
  color = mix(color, vec3(0.96, 0.98, 1.0), foam);

  // === ALPHA ===
  // Shallow water is more transparent (you see underwater geometry through it).
  float transparencyDistance = smoothstep(4.0, 45.0, viewDistance);
  float alpha = mix(uShallowAlpha, uDeepAlpha, depthT);
  alpha = mix(alpha, 0.18, 1.0 - transparencyDistance);
  // Don't bind "high-reflection ↔ opaque" tightly. Pulling alpha all the way to 0.94 made the
  // distant grazing-angle water look like a fluorescent sheet at dawn/dusk: a huge area of the
  // screen rendered nearly opaque while reflecting the brightest part of the sky. Pulling toward
  // 0.55 keeps the "mirror surface looks denser than transparent water" intuition without
  // erasing every trace of the deep color underneath.
  alpha = mix(alpha, 0.55, reflectionAmount);
  alpha = mix(alpha, 1.0, foam);

  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
}
