# Three.js Simple Ocean

Three.js **ocean surface** material: scrolling height and normal maps, depth-aware absorption, and shoreline foam. Includes a small **render helper** that matches what the shader expects (opaque depth pre-pass + transparent water pass).

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
  BlitPass,
  createOceanMaterial,
  DepthPrePassTarget,
  loadOceanTextures,
  renderFrame,
} from "threejs-simple-ocean";

const renderer = new THREE.WebGLRenderer({ antialias: true });
const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 200);

const opaqueScene = new THREE.Scene();
const waterScene = new THREE.Scene();

const depthPass = new DepthPrePassTarget();
const blitPass = new BlitPass();

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

const geometry = new THREE.PlaneGeometry(120, 120, 240, 240);
geometry.computeTangents();

const { material, uniforms } = createOceanMaterial(textures, depthPass.depthTexture);
const oceanMesh = new THREE.Mesh(geometry, material);
oceanMesh.rotation.x = -Math.PI / 2;
oceanMesh.position.y = 1.5;
oceanMesh.frustumCulled = false;
waterScene.add(oceanMesh);

function tick() {
  uniforms.uTime.value += 0.016;
  renderFrame({
    renderer,
    camera,
    opaqueScene,
    waterScene,
    oceanMesh,
    oceanUniforms: uniforms,
    depthPass,
    blitPass,
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
  resolution: 256,      // square texture side; 256–512 is a good range
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

Cost: a one-time GPU readback (~3–10ms at 256², ~10–30ms at 512²) plus one extra texture sample per water pixel at render time.

#### Tuning tips

- **`padding` / `maxDistance` set the maximum foam reach** in world units. The foam `foamWidth` knob still controls how far the patchy band actually extends, but if you set `foamWidth` larger than `maxDistance` the SDF clamps and the outer edge becomes flat. Keep `maxDistance >= foamWidth + foamBaseRingWidth + foamShapeNoiseAmount * foamWidth` for organic edges. When `bounds` is omitted, the bake expands the island’s XZ box by **`max(padding, maxDistance)`** so a larger `maxDistance` does not get flattened at the texture edge; if you pass explicit `bounds`, size them so open water extends at least `maxDistance` from the coast in every direction you care about.
- **`resolution` controls foam edge sharpness.** 256² is usually enough because the patchy mask and shape noise hide aliasing. Bump to 512² if you see stepped/blocky boundaries on long flat coasts.
- **Re-bake when the island changes.** `buildShoreSdf` is safe to call again at runtime (e.g. after adding/removing tiles). Dispose the old SDF first.
- **Object placement matters.** Bake AFTER the island has its final world transform — the SDF stores absolute world XZ coordinates via `shoreSdf.bounds`. If you move the island later, re-bake.
- **Use a subtree, not the whole scene.** Pass only the geometry that should count as "land". Floors, skyboxes, props, etc. should be excluded.
- **Skinned / animated meshes:** the bake uses `Object3D.clone(true)`. Rigid hierarchies and static meshes match the on-screen silhouette. **SkinnedMesh** clones may not reproduce the current animation pose (skeleton binding, bone matrices, and morph targets can differ from the live object), so the SDF silhouette can be wrong for animated characters or rigs. For shoreline foam, pass **static** land geometry (baked/rest pose, or a merged mesh). If you need a posed skinned mesh, bake from a dedicated static copy or merge the skinned result to a non-skinned mesh first.

## Public API

| Export | Role |
|--------|------|
| `createOceanMaterial` | Builds `RawShaderMaterial` + uniform bag from textures and a shared `DepthTexture`. Accepts an optional `shoreSdf`. |
| `bindOceanMatrices` | Per-frame camera/mesh matrices (also called from `renderFrame`). |
| `buildShoreSdf` | Bake a top-down shore distance field so foam follows the actual coastline of any geometry. |
| `setOceanShoreSdf` | Bind / unbind a `ShoreSdf` on an existing material at runtime. |
| `loadOceanTextures` | Loads and configures repeat/anisotropy; **placeholders on failure**. |
| `DepthPrePassTarget` | Color+depth render target whose `depthTexture` the shader samples. |
| `BlitPass` | Full-screen blit utility (required by `renderFrame` context; optional for your own experiments). |
| `renderFrame` | Opaque pre-pass → screen opaque → transparent water with correct depth testing. |

Types: `OceanMaterialConfig`, `OceanMaterialUniforms`, `OceanTextureBundle`, `FrameRenderContext`, `ShoreSdf`, `BuildShoreSdfOptions`.

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
