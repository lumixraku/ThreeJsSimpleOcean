precision highp float;

uniform vec3 uCameraPos;
uniform vec3 uLightDirWorld;
uniform vec3 uSunColor;

uniform mat4 uViewMatrix;
uniform mat4 projectionMatrix;

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
varying vec3 vWorldNormal;

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

/**
 * Base color stays on the existing two-layer cross-fade. The surface normal switches to the
 * canonical Water noise, driven by world XZ (so wavelength is locked to world units, not mesh
 * UV tessellation). The plane is flat — vWorldNormal is world up — so the noise vector is
 * already in a world-aligned basis and we skip the TBN transform.
 *
 * Swizzle .xzy maps the normal map's B-as-up tangent convention into world Y-up.
 * The (1.5, 1.0, 1.5) bias exaggerates the horizontal tilt the way official Water does.
 */
void sampleSurface(out vec3 baseSample, out vec3 nWorld) {
  vec2 uvA = vUv * uSurfaceTiling + uTime * uAlbedoScroll;
  vec2 uvB = vUv * (uSurfaceTiling * 0.55) + uTime * uNormalScroll;
  vec3 baseA = texture2D(uBaseColor, uvA).rgb;
  vec3 baseB = texture2D(uBaseColor, uvB).rgb;
  baseSample = mix(baseA, baseB, 0.5);

  vec4 noise = getWaterNoise(vWorldPos.xz);
  nWorld = normalize(vec3(noise.x, noise.z, noise.y) * vec3(1.5, 1.0, 1.5));
}

void main() {
  vec2 screenUv = gl_FragCoord.xy / uResolution;

  // Reconstruct world position of underwater geometry behind this pixel.
  float sceneDepth = texture2D(uSceneDepth, screenUv).r;
  if (sceneDepth + 0.0002 < gl_FragCoord.z) discard;
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

  // Canonical Three.js Water sun specular: a sharp pow100 highlight tinted by the atmosphere-
  // synced sun color. The factor of 2 matches Water's `spec=2.0` argument to sunLight().
  // uSpecStrength keeps the existing tunable so values from the old shader still mean something.
  vec3 R = reflect(-lightDir, n);
  float spec = pow(max(0.0, dot(R, viewDir)), 100.0);
  vec3 specular = uSunColor * (2.0 * spec * uSpecStrength);

  // === REFLECTION ===
  // Intensity: `pow(1 - h/dist3d, 5)` — geometric Schlick fresnel based purely on camera height
  // above the water (h) and the 3D camera→water distance. This is x^5 of an input that is
  // mathematically guaranteed to live in [0,1]:
  //   - water directly below camera: h/dist3d == 1 → input == 0 → reflection == 0 (transparent)
  //   - water at horizon: dist3d → ∞ → input → 1 → reflection → 1 (full mirror)
  // So pow(input, 5) is in [0,1] WITHOUT any clamp at saturation — no slope-discontinuity, no
  // visible band where the curve hits a cap. Strength is a pure function of (h, dist3d), not of
  // view direction or screen position, so 360° camera yaw gives identical reflection per distance.
  float h = max(uCameraPos.y - vWorldPos.y, 0.0);
  float dist3d = max(length(uCameraPos - vWorldPos), 1e-4);
  float fresInput = clamp(1.0 - h / dist3d, 0.0, 1.0);
  float reflectionAmount = clamp(pow(fresInput, 5.0) * uFresnelStrength, 0.0, 1.0);
  float viewDistance = length(uCameraPos.xz - vWorldPos.xz);

  // Content: mirror screen UV across the horizon line and sample the real rendered sky frame so
  // the actual clouds appear in the water. No `onScreen` gate / smoothstep fade — those produced
  // a visible horizontal seam where SSR cut over to the tint fallback. Instead we just `clamp` the
  // UV: out-of-range mirrored samples take the nearest edge pixel of the SSR map, which is sky
  // (the framebuffer's top row is always sky+clouds in this scene), so the visible result is
  // continuous with no boundary.
  vec3 cameraForward = normalize((uInverseView * vec4(0.0, 0.0, -1.0, 0.0)).xyz);
  vec3 horizonForward = normalize(vec3(cameraForward.x, 0.0, cameraForward.z));
  vec4 horizonClip = projectionMatrix * uViewMatrix * vec4(horizonForward, 0.0);
  float horizonUvY = clamp((horizonClip.y / max(horizonClip.w, 1e-6)) * 0.5 + 0.5, 0.02, 0.98);

  vec2 reflectedUv = vec2(screenUv.x, 2.0 * horizonUvY - screenUv.y);
  // Tiny lateral wave wobble. Vertical perturbation is intentionally 0 — pushing reflectedUv
  // *down* could land on the sea-floor strip of the SSR frame (uReflectionMap renders the scene
  // with no water), producing a dark stripe at the water's horizon line.
  reflectedUv.x += n.x * 0.012;
  // Out-of-range guard. The mirror trick only matches a real reflection while the camera is
  // ~level; once it tilts down, horizonUvY moves toward the top of the screen and reflectedUv.y
  // runs past 1.0 for most foreground water. Clamping then samples the top row of the SSR frame
  // (which contains the mountain horizon silhouette) and smears that strip across the foreground
  // as a banding artifact. Fade to the uniform sky tint where the sample would have to be clamped
  // so the bad region just reads as a flat sky-blue instead of a smeared mountain.
  float reflectInRange = 1.0 - smoothstep(0.95, 1.05, reflectedUv.y);
  vec3 ssrSample = texture2D(uReflectionMap, clamp(reflectedUv, 0.0, 1.0)).rgb;
  vec3 reflectColor = mix(uReflectionTint, ssrSample, reflectInRange);

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
  // Near-land gate: only show the contact ring where the SDF/AABB says we are close to real
  // shore geometry. Without this, ANY shallow depth caster (e.g. a wooden post in open water)
  // would inherit a foam ring at its waterline just because worldColumn is small there.
  // distOutsideIsland is 0 at the shore and saturates at the SDF max distance far away.
  float nearLand = 1.0 - smoothstep(0.0, 0.5, distOutsideIsland);
  innerRing *= nearLand;

  // --- Outer foam (independent) ---
  // Foam mask: two scrolling world-XZ samples for non-tiling animated patches.
  // The SDF owns shoreline placement; this mask only breaks up the wash pattern.
  vec2 maskUvA = xz * uFoamMaskTiling + uTime * uFoamMaskScroll;
  vec2 maskUvB = xz * (uFoamMaskTiling * 1.35) + uTime * (uFoamMaskScroll * vec2(-0.7, 0.9));
  float maskRaw = max(texture2D(uFoamMask, maskUvA).r, texture2D(uFoamMask, maskUvB).r);
  float maskOuter = smoothstep(uFoamMaskThreshold, 1.0, maskRaw);

  // Shape noise wobbles the outer silhouette only — procedural hash from shape UVs (no extra fetches).
  // IMPORTANT: shape offset is expressed as a FRACTION of uFoamWidth, NOT absolute world units.
  vec2 shapeSeedA = xz * uFoamShapeNoiseScale + uTime * uFoamShapeNoiseScroll;
  vec2 shapeSeedB = xz * (uFoamShapeNoiseScale * 0.62) + uTime * (uFoamShapeNoiseScroll * vec2(-1.3, 0.8));
  float shapeNoise = fract(sin(dot(shapeSeedA, vec2(12.9898, 78.233)) + dot(shapeSeedB, vec2(39.3468, 11.1355))) * 43758.5453);
  float shapeOffset = (shapeNoise - 0.5) * uFoamShapeNoiseAmount * uFoamWidth;

  // Outer foam fades from an adjustable shore origin to 0 at (foamWidth + shapeOffset).
  // A narrow unmasked SDF core keeps the visible shore continuous, while the wider wash is mask-gated.
  // foamWidth is in absolute world units, independent of foamBaseRingWidth.
  float outerEnabled = smoothstep(0.0, 0.005, uFoamWidth);
  float shoreCoreWidth = max(uFoamWidth * 0.35, 1e-6);
  float shoreCore = outerEnabled * (1.0 - smoothstep(0.0, shoreCoreWidth, max(0.0, distOutsideIsland)));
  float outerDistance = max(0.0, distOutsideIsland + uFoamOuterShoreOffset);
  float outerReach = max(uFoamWidth + shapeOffset, 1e-4);
  float outerFade = 1.0 - smoothstep(0.0, outerReach, outerDistance);
  outerFade = pow(outerFade, 1.4);
  float outerFoam = outerEnabled * max(shoreCore, outerFade * maskOuter);

  // --- Combine: inner ring sits as a guaranteed solid floor; outer patches add on top. ---
  float foam = clamp(max(innerRing, outerFoam) * uFoamStrength, 0.0, 1.0);
  color = mix(color, vec3(0.96, 0.98, 1.0), foam);

  // === ALPHA ===
  // Shallow water is more transparent (you see underwater geometry through it).
  float transparencyDistance = smoothstep(4.0, 45.0, viewDistance);
  float alpha = mix(uShallowAlpha, uDeepAlpha, depthT);
  alpha = mix(alpha, 0.18, 1.0 - transparencyDistance);
  alpha = mix(alpha, 0.94, reflectionAmount);
  alpha = mix(alpha, 1.0, foam);

  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
}
