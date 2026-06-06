# Three.js Simple Ocean

Three.js **ocean surface** material: scrolling height and normal maps, depth-aware absorption, and shoreline foam. Includes a small **render helper** that matches what the shader expects (opaque depth pre-pass + transparent water pass).

![Demo screenshot](docs/preview.jpg)

_Iteration log — dawn lighting + procedural sand beach (2026-06-06):_

![Dawn + sand beach iteration](docs/preview-dawn-beach.jpg)

_Iteration log — softened reflection α + widened SSR fade (2026-06-06, evening):_

![Softer dawn reflection](docs/preview-dawn-softrefl.jpg)

This hasn't been tested with scale and has no underwater filters or anything.

I just use a small amount in a fairly light game.

## Install

```bash
npm install threejs-simple-ocean three
```

`three` is a **peer dependency** — use a compatible version (see `peerDependencies` in [package.json](https://github.com/sam-thewise/ThreeJsSimpleOcean/blob/master/package.json)).

## Quick start

Your app must render **opaque geometry first** (into an off-screen target that exposes a `DepthTexture`), then render the **transparent water mesh** on top while binding that depth texture to the material. The helper `renderFrame` implements this pattern.

```ts
import * as THREE from "three";
import {
  AdaptiveDepthScale,
  createOceanMaterial,
  DepthPrePassTarget,
  loadOceanTextures,
  renderFrame,
  tagOceanDepthCasters,
} from "threejs-simple-ocean";

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // water is full-screen — cap DPR
const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 200);

const opaqueScene = new THREE.Scene();
const waterScene = new THREE.Scene();

const depthPass = new DepthPrePassTarget();
const adaptiveDepthScale = new AdaptiveDepthScale();

const texLoader = new THREE.TextureLoader();
const textures = await loadOceanTextures(
  texLoader,
  {
    baseColor: "/textures/ocean.png",
    normal: "/textures/ocean_normal.png",
    height: "/textures/ocean_heightmap.png",
    foamMask: "/textures/foam-mask.png",
  },
  4, // tiling repeat for most maps
);

// Tag underwater geometry for the cheap depth pre-pass (floor, island, etc.).
// Tag after adding to opaqueScene so the scene is registered automatically,
// or call registerOceanDepthCastersScene(opaqueScene) once after setup.
opaqueScene.add(floor);
tagOceanDepthCasters(floor);
opaqueScene.add(islandRoot);
tagOceanDepthCasters(islandRoot);

const geometry = new THREE.PlaneGeometry(120, 120, 128, 128);
geometry.computeTangents();

const { material, uniforms } = createOceanMaterial(textures, depthPass.depthTexture);
const oceanMesh = new THREE.Mesh(geometry, material);
oceanMesh.rotation.x = -Math.PI / 2;
oceanMesh.position.y = 1.5;
oceanMesh.frustumCulled = false;
waterScene.add(oceanMesh);

function tick(dtMs: number) {
  uniforms.uTime.value += dtMs / 1000;
  renderFrame({
    renderer,
    camera,
    opaqueScene,
    waterScene,
    oceanMesh,
    oceanUniforms: uniforms,
    depthPass,
    options: {
      adaptiveDepthScale,
      frameDeltaMs: dtMs,
    },
  });
}
```

### No assets yet?

If texture URLs fail to load, `loadOceanTextures` **falls back to small procedural placeholders** so you can integrate the pipeline before wiring real files.

### Shoreline foam — rectangular islands (`uIslandBounds`)

For a rectangular island, set the XZ AABB once:

```ts
uniforms.uIslandBounds.value.set(minX, minZ, maxX, maxZ);
```

This is fastest (no extra texture, no bake) but produces a rectangular foam band around any non-rectangular geometry.

### Shoreline foam — any shape (`buildShoreSdf`)

For an irregular coast (peninsulas, bays, tile-based islands, archipelagos), use the baked **shore distance field**. The shader samples a top-down SDF so the outer patchy foam follows the actual silhouette, exactly like the thin inner ring does:

```ts
import {
  buildShoreSdf,
  createOceanMaterial,
  setOceanShoreSdf,
} from "threejs-simple-ocean";

// Build your scene first, then bake the SDF once the island is in its final pose.
const shoreSdf = buildShoreSdf(renderer, {
  object: islandRoot,   // any Object3D; every mesh in its subtree counts as land
  padding: 8,           // minimum expansion past the silhouette for auto bounds; actual expansion is max(padding, maxDistance)
  resolution: 128,      // square texture side; 128 default, 256+ for sharper coasts
  // maxDistance: 8,    // optional: defaults to `padding`. If larger than `padding`, auto bounds grow to match (avoids UV clamping). Explicit `bounds` must still extend ≥ maxDistance from shore.
});

// Option 1: bind at material creation time.
const { material, uniforms } = createOceanMaterial(textures, depthPass.depthTexture, { shoreSdf });

// Option 2: bind later / swap at runtime.
setOceanShoreSdf(uniforms, shoreSdf);

// Switch back to the AABB path at any time (rebinds a safe internal fallback texture so you can dispose the old SDF immediately):
setOceanShoreSdf(uniforms, null);

// Dispose when no longer needed (e.g. before re-baking after geometry change).
shoreSdf.dispose();
```

#### How it works

1. `buildShoreSdf` **deep-clones** `object` into a throwaway scene (your live graph is never reparented), then renders that clone top-down with a flat white override material into an RGBA8 RT.
2. The pixels are read back and an exact 2D Euclidean distance transform (Felzenszwalb 2004) runs on the CPU.
3. The result is encoded into a `DataTexture` where `R = clamp(distanceFromShore / maxDistance, 0, 1)`, sampled in the fragment shader as `texture2D(uShoreSdf, (worldXZ - bounds.xy) / boundsSize)`.

Cost: a one-time GPU readback (~2–5ms at 128², ~3–10ms at 256², ~10–30ms at 512²) plus one extra texture sample per water pixel at render time.

#### Tuning tips

- **`padding` / `maxDistance` set the maximum foam reach** in world units. The foam `foamWidth` knob still controls how far the patchy band actually extends, but if you set `foamWidth` larger than `maxDistance` the SDF clamps and the outer edge becomes flat. Keep `maxDistance >= foamWidth + foamBaseRingWidth + foamShapeNoiseAmount * foamWidth` for organic edges. When `bounds` is omitted, the bake expands the island’s XZ box by **`max(padding, maxDistance)`** so a larger `maxDistance` does not get flattened at the texture edge; if you pass explicit `bounds`, size them so open water extends at least `maxDistance` from the coast in every direction you care about.
- **`resolution` controls foam edge sharpness.** 128² is the default and usually enough because the patchy mask and shape noise hide aliasing. Bump to 256² or 512² if you see stepped boundaries on long flat coasts.
- **Re-bake when the island changes.** `buildShoreSdf` is safe to call again at runtime (e.g. after adding/removing tiles). Dispose the old SDF first.
- **Object placement matters.** Bake AFTER the island has its final world transform — the SDF stores absolute world XZ coordinates via `shoreSdf.bounds`. If you move the island later, re-bake.
- **Use a subtree, not the whole scene.** Pass only the geometry that should count as "land". Floors, skyboxes, props, etc. should be excluded.
- **Skinned / animated meshes:** the bake uses `Object3D.clone(true)`. Rigid hierarchies and static meshes match the on-screen silhouette. **SkinnedMesh** clones may not reproduce the current animation pose (skeleton binding, bone matrices, and morph targets can differ from the live object), so the SDF silhouette can be wrong for animated characters or rigs. For shoreline foam, pass **static** land geometry (baked/rest pose, or a merged mesh). If you need a posed skinned mesh, bake from a dedicated static copy or merge the skinned result to a non-skinned mesh first.

## Sky reflection

The water reflects sky + clouds using two decoupled pieces — strength and content.

**Strength: geometric Schlick fresnel** keyed off camera→water distance, not view direction:

```glsl
float h         = max(uCameraPos.y - vWorldPos.y, 0.0);   // camera height above water
float dist3d    = length(uCameraPos - vWorldPos);          // 3D distance to the water point
float fresInput = clamp(1.0 - h / dist3d, 0.0, 1.0);       // mathematically in [0, 1]
float amount    = pow(fresInput, 5.0) * uFresnelStrength;
```

- Water directly below the camera (`dist3d == h`) → input `0` → transparent.
- Water at the horizon (`dist3d → ∞`) → input → `1` → full mirror.
- `pow(input, 5)` is naturally bounded in `[0, 1]`; **no clamp**, **no slope discontinuity**, so the gradient never produces a visible band/step. The strength is identical for any pair of water points at the same camera distance, regardless of yaw — so the reflection looks the same as you orbit 360°.

**Content: screen-space reflection of the current frame.** Each frame the host renders the no-water scene to `uReflectionMap` (sky + clouds + island). The shader mirrors the screen UV across the projected horizon line and samples that texture, which puts the *actual* rendered clouds onto the water:

```glsl
// horizonUvY = projected screen-Y of the camera's horizontal forward direction
vec2 reflectedUv = vec2(screenUv.x, 2.0 * horizonUvY - screenUv.y);
reflectedUv.x   += n.x * 0.012;                                  // tiny lateral wave wobble
vec3 reflectColor = texture2D(uReflectionMap, clamp(reflectedUv, 0.0, 1.0)).rgb;
```

Notes / gotchas:

- The vertical UV is *not* perturbed by waves and the sample uses `clamp`, not edge fade. Pushing the UV down (or fading at the screen edges) would either land on the sea-floor strip of `uReflectionMap` or visibly cut the reflection at a screen-aligned boundary — both manifest as a horizontal black/seam line at the horizon.
- `uReflectionMap` must be rendered without the water mesh (the demo's `Scene.tsx` does this on a layer toggle). If the water is in the reflection map, you get feedback artefacts.
- The reflected *content* unavoidably depends on what's above the horizon in the current view (that's what SSR does); the **strength** is the part that stays uniform 360°.

Tuning knobs (all on `OceanMaterialConfig` / exposed as uniforms):

| Knob | Effect |
|------|--------|
| `fresnelStrength` | Global multiplier on the Schlick amount. `1.0` (default) is full mirror at horizon. |
| `reflectionTint` | Currently unused at runtime (kept on the uniform bag for downstream forks that want a sky-tint fallback). |
| `reflectionMaxDistance` / `reflectionDistanceRange` | Legacy knobs from the previous `pow(distance / maxDist, 5)` formulation, kept as no-op uniforms for backward compat. |

If you want a flat tint instead of real clouds (e.g. for a distance-only stylised look) you can swap the `texture2D(uReflectionMap, …)` line for `uReflectionTint` — strength stays smooth and 360° uniform either way.

## Performance

The render path is three passes per frame:

1. **Cheap depth pre-pass** — depth-only override material, optional layer-filtered casters, adaptive half/quarter resolution.
2. **Full opaque pass** — correct lit color and default depth buffer for water `depthTest`.
3. **Transparent water** — full resolution; ~8 texture samples per pixel.

Cost compounds with **full-screen water × high DPR × multi-pass rendering**. `renderFrame` defaults are tuned for this, and adaptive depth scaling is available as an opt-in:

| Lever | API | Default |
|-------|-----|---------|
| Depth override material | `options.useDepthOverrideMaterial` | `true` |
| Depth-caster layers | `tagOceanDepthCasters(mesh)` + `registerOceanDepthCastersScene(scene)` if tagged before add | enabled when scene registered |
| Adaptive depth scale | `AdaptiveDepthScale` + `options.frameDeltaMs` | opt-in; when supplied, starts at 0.5× and drops to 0.25× when over budget |
| Fixed depth scale | `options.depthResolutionScale` | `1` when adaptive scaling is not supplied |
| Shadow skip in pass 1 | `options.disableShadowsInDepthPass` | `true` |
| Shore SDF resolution | `buildShoreSdf({ resolution })` | `128` |
| DPR cap | `renderer.setPixelRatio(Math.min(dpr, 2))` | recommended |
| Water mesh density | `PlaneGeometry(w, h, segs, segs)` | `128` in examples |

```ts
import { AdaptiveDepthScale, tagOceanDepthCasters } from "threejs-simple-ocean";

tagOceanDepthCasters(floor);
tagOceanDepthCasters(island);

const adaptiveDepthScale = new AdaptiveDepthScale({ frameTimeBudgetMs: 16.6 });

renderFrame({
  // ...
  options: {
    adaptiveDepthScale,
    frameDeltaMs: deltaMs,
    // depthResolutionScale: 0.5, // fixed alternative to adaptive
  },
});
```

If no scene is registered (via tagging in-graph or `registerOceanDepthCastersScene`), pass 1 falls back to rendering the full opaque scene (backward compatible). Override per frame with `options.filterDepthCasters`.

## Public API

| Export | Role |
|--------|------|
| `createOceanMaterial` | Builds `RawShaderMaterial` + uniform bag from textures and a shared `DepthTexture`. Accepts an optional `shoreSdf`. |
| `bindOceanMatrices` | Per-frame camera/mesh matrices (also called from `renderFrame`). |
| `buildShoreSdf` | Bake a top-down shore distance field so foam follows the actual coastline of any geometry. |
| `setOceanShoreSdf` | Bind / unbind a `ShoreSdf` on an existing material at runtime. |
| `loadOceanTextures` | Loads and configures repeat/anisotropy; **placeholders on failure**. |
| `DepthPrePassTarget` | Depth render target whose `depthTexture` the water shader samples. Supports scaled sizing. |
| `AdaptiveDepthScale` | Adapts depth pre-pass resolution between 0.5× and 0.25× based on frame time. |
| `tagOceanDepthCasters` | Tag meshes for the cheap layer-filtered depth pre-pass; auto-registers parent scene when in-graph. |
| `registerOceanDepthCastersScene` | Register an opaque scene for layer filtering (use when tagging before `scene.add`). |
| `hasOceanDepthCasters` | O(1) check whether a scene uses layer-filtered depth casters. |
| `OCEAN_DEPTH_CASTER_LAYER` | Layer constant used by `tagOceanDepthCasters`. |
| `BlitPass` | Full-screen blit utility for custom pipelines (not used by `renderFrame`). |
| `renderFrame` | Cheap depth pre-pass → screen opaque → transparent water. |

Types: `OceanMaterialConfig`, `OceanMaterialUniforms`, `OceanTextureBundle`, `FrameRenderContext`, `RenderFrameOptions`, `AdaptiveDepthScaleOptions`, `ShoreSdf`, `BuildShoreSdfOptions`.

## Bundler note

The library ships as **ESM** (`dist/index.js`). Shader sources are bundled at build time. Consumers should use a bundler (Vite, webpack, etc.) compatible with modern ESM. TypeScript projects should resolve `three` types from `@types/three` or from `three` depending on version.

## Repository layout

| Path | Purpose |
|------|---------|
| [src/index.ts](https://github.com/sam-thewise/ThreeJsSimpleOcean/blob/master/src/index.ts) | Package entry (public exports). |
| [src/ocean/OceanMaterial.ts](https://github.com/sam-thewise/ThreeJsSimpleOcean/blob/master/src/ocean/OceanMaterial.ts) | Shader material and defaults. |
| [src/rendering/FrameRenderer.ts](https://github.com/sam-thewise/ThreeJsSimpleOcean/blob/master/src/rendering/FrameRenderer.ts) | `renderFrame` pipeline. |
| [src/app/OceanApplication.ts](https://github.com/sam-thewise/ThreeJsSimpleOcean/blob/master/src/app/OceanApplication.ts) | **Demo app only** — not exported from the package. |
| [examples/minimal](https://github.com/sam-thewise/ThreeJsSimpleOcean/tree/master/examples/minimal) | Standalone minimal Vite example using `file:../..`. |

The full-screen demo (grass island, FBX, Siegebound asset paths) lives in the root app. Those assets are **examples only** and are not part of the npm API.

## License

MIT
