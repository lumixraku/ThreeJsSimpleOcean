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

### Island foam bounds

For foam that hugs an island mesh in world XZ, set:

```ts
uniforms.uIslandBounds.value.set(minX, minZ, maxX, maxZ);
```

Defaults cover a small area around the origin when you omit this.

## Public API

| Export | Role |
|--------|------|
| `createOceanMaterial` | Builds `RawShaderMaterial` + uniform bag from textures and a shared `DepthTexture`. |
| `bindOceanMatrices` | Per-frame camera/mesh matrices (also called from `renderFrame`). |
| `loadOceanTextures` | Loads and configures repeat/anisotropy; **placeholders on failure**. |
| `DepthPrePassTarget` | Color+depth render target whose `depthTexture` the shader samples. |
| `BlitPass` | Full-screen blit utility (required by `renderFrame` context; optional for your own experiments). |
| `renderFrame` | Opaque pre-pass → screen opaque → transparent water with correct depth testing. |

Types: `OceanMaterialConfig`, `OceanMaterialUniforms`, `OceanTextureBundle`, `FrameRenderContext`.

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
