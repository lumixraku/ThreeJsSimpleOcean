import * as THREE from "three";
import type { OceanTextureBundle } from "../loading/TextureBundleLoader";
import type { ShoreSdf } from "./ShoreSdf";

import oceanVert from "./shaders/ocean.vert.glsl?raw";
import oceanFrag from "./shaders/ocean.frag.glsl?raw";

export type OceanMaterialUniforms = {
  uHeightMap: THREE.IUniform<THREE.Texture | null>;
  uBaseColor: THREE.IUniform<THREE.Texture | null>;
  uNormalMap: THREE.IUniform<THREE.Texture | null>;
  uSceneDepth: THREE.IUniform<THREE.Texture | null>;
  uFoamMask: THREE.IUniform<THREE.Texture | null>;
  uTime: THREE.IUniform<number>;
  uHeightScroll: THREE.IUniform<THREE.Vector2>;
  uAlbedoScroll: THREE.IUniform<THREE.Vector2>;
  uNormalScroll: THREE.IUniform<THREE.Vector2>;
  uHeightTiling: THREE.IUniform<number>;
  uSurfaceTiling: THREE.IUniform<number>;
  uDisplacement: THREE.IUniform<number>;
  uLightDirWorld: THREE.IUniform<THREE.Vector3>;
  uCameraPos: THREE.IUniform<THREE.Vector3>;
  uShallowColor: THREE.IUniform<THREE.Color>;
  uDeepColor: THREE.IUniform<THREE.Color>;
  uShallowAlpha: THREE.IUniform<number>;
  uDeepAlpha: THREE.IUniform<number>;
  uAbsorption: THREE.IUniform<number>;
  uFoamWidth: THREE.IUniform<number>;
  uFoamOuterShoreOffset: THREE.IUniform<number>;
  uFoamStrength: THREE.IUniform<number>;
  uFoamMaskTiling: THREE.IUniform<number>;
  uFoamMaskScroll: THREE.IUniform<THREE.Vector2>;
  uFoamMaskThreshold: THREE.IUniform<number>;
  uIslandBounds: THREE.IUniform<THREE.Vector4>;
  /** Baked shore distance field (RGBA8; R = clamped normalized distance from land). Uses a shared 1×1 black fallback when unused. */
  uShoreSdf: THREE.IUniform<THREE.Texture | null>;
  /** World XZ rectangle the SDF covers (minX, minZ, maxX, maxZ). */
  uShoreSdfBounds: THREE.IUniform<THREE.Vector4>;
  /** World-unit distance represented by R == 1.0 in `uShoreSdf`. */
  uShoreSdfMaxDistance: THREE.IUniform<number>;
  /** 0 → use the AABB foam path; 1 → sample `uShoreSdf` instead. Set automatically by {@link setOceanShoreSdf}. */
  uUseShoreSdf: THREE.IUniform<number>;
  uFoamShapeNoiseAmount: THREE.IUniform<number>;
  uFoamShapeNoiseScale: THREE.IUniform<number>;
  uFoamShapeNoiseScroll: THREE.IUniform<THREE.Vector2>;
  uFoamBaseRingWidth: THREE.IUniform<number>;
  uDepthTintAmount: THREE.IUniform<number>;
  uSurfaceBrightness: THREE.IUniform<number>;
  uSpecStrength: THREE.IUniform<number>;
  uFresnelStrength: THREE.IUniform<number>;
  uCameraNear: THREE.IUniform<number>;
  uCameraFar: THREE.IUniform<number>;
  uResolution: THREE.IUniform<THREE.Vector2>;
  uInverseProjection: THREE.IUniform<THREE.Matrix4>;
  uInverseView: THREE.IUniform<THREE.Matrix4>;
  modelMatrix: THREE.IUniform<THREE.Matrix4>;
  modelViewMatrix: THREE.IUniform<THREE.Matrix4>;
  projectionMatrix: THREE.IUniform<THREE.Matrix4>;
  normalMatrix: THREE.IUniform<THREE.Matrix3>;
};

export type OceanMaterialConfig = {
  heightScroll: THREE.Vector2;
  albedoScroll: THREE.Vector2;
  normalScroll: THREE.Vector2;
  heightTiling: number;
  surfaceTiling: number;
  displacement: number;
  shallowColor: THREE.Color;
  deepColor: THREE.Color;
  shallowAlpha: number;
  deepAlpha: number;
  absorption: number;
  /** Width of the outer patchy foam in absolute world units (independent of inner ring). */
  foamWidth: number;
  /** Moves the outer patchy foam origin toward the island edge without changing foamWidth. */
  foamOuterShoreOffset: number;
  foamStrength: number;
  /** Tiling factor for the foam mask sampling (higher = finer pattern). */
  foamMaskTiling: number;
  /** Scroll velocity for the foam mask, animating the foam pattern. */
  foamMaskScroll: THREE.Vector2;
  /** Threshold (0..1) for considering the foam mask "on" — higher = sparser foam. */
  foamMaskThreshold: number;
  /**
   * Max ± perturbation of the outer foam silhouette as a FRACTION of foamWidth.
   * e.g. 0.5 → silhouette wobbles by ±0.25 × foamWidth. When foamWidth = 0 the wobble is 0 too.
   */
  foamShapeNoiseAmount: number;
  /** World-XZ frequency of the shape noise (smaller = larger organic blobs). */
  foamShapeNoiseScale: number;
  /** Slow drift of the shape noise to give the foam edge a living motion. */
  foamShapeNoiseScroll: THREE.Vector2;
  /** Water-column contact width for the always-on solid foam ring at the mesh edge. Independent of foamWidth. */
  foamBaseRingWidth: number;
  /** Max fraction (0..1) the depth tint mixes the surface toward `deepColor`. 0.6 leaves 40% surface visible at deepest. */
  depthTintAmount: number;
  /** Multiplier applied to the sampled base texture (1 = unmodified, >1 brightens, <1 darkens). */
  surfaceBrightness: number;
  /** Strength of specular twinkle driven by the normal map. */
  specStrength: number;
  /** Strength of fresnel rim at glancing angles. */
  fresnelStrength: number;
  /**
   * Optional baked shore distance field (see {@link buildShoreSdf}). When provided, the outer foam
   * follows the actual coastline of any geometry instead of an XZ AABB. Can also be set later via
   * {@link setOceanShoreSdf}.
   */
  shoreSdf?: ShoreSdf;
};

/**
 * Defaults tuned for: water at y≈1.5, ocean floor at y≈-2 (column range ~0..3.5).
 * - shallowAlpha low → you see the underwater geometry in shallow water.
 * - deepAlpha high → deep water reads as a flat opaque dark blue.
 * - absorption tuned so column ~2 → deep, column ~0.2 → shallow.
 */
const defaultConfig: OceanMaterialConfig = {
  heightScroll: new THREE.Vector2(0.006, 0.004),
  // Two-layer surface: each layer scrolls BOTH its texture and normal coherently.
  // Layer A scroll:
  albedoScroll: new THREE.Vector2(0.012, 0.008),
  // Layer B scroll (different direction/speed so layers interfere and look non-tiled):
  normalScroll: new THREE.Vector2(-0.007, 0.011),
  heightTiling: 6,
  surfaceTiling: 4,
  displacement: 0.12,
  shallowColor: new THREE.Color(0.22, 0.55, 0.72),
  deepColor: new THREE.Color(0.01, 0.05, 0.11),
  shallowAlpha: 0.25,
  deepAlpha: 0.97,
  absorption: 1.6,
  // Outer patchy foam width in absolute world units (independent of inner ring).
  foamWidth: 0.2,
  // Positive values pull the patchy foam inward toward the visible shore.
  foamOuterShoreOffset: 0.05,
  foamStrength: 0.75,
  foamMaskTiling: 6,
  // Slow drift of the foam mask animation.
  foamMaskScroll: new THREE.Vector2(0.008, 0.005),
  // Higher threshold = sparser/more broken-up outer patches (less wash).
  foamMaskThreshold: 0.42,
  // Outer silhouette wobble as a fraction of foamWidth (unitless). Now scales with foamWidth,
  // so setting foamWidth tiny actually makes the outer foam vanish completely.
  foamShapeNoiseAmount: 0.55,
  foamShapeNoiseScale: 0.5,
  // Speed of the rim morphing; two-sample interference makes it read as expand/contract.
  foamShapeNoiseScroll: new THREE.Vector2(0.018, 0.012),
  // Inner solid contact width (world units). Independent of everything else.
  foamBaseRingWidth: 0.1,
  depthTintAmount: 0.55,
  surfaceBrightness: 1.4,
  specStrength: 0.9,
  fresnelStrength: 0.28,
};

/** Shared 1x1 black RGBA8 fallback for `uShoreSdf` — one GPU allocation for all ocean materials. */
let shoreSdfFallbackTexture: THREE.DataTexture | null = null;

/**
 * Lazily allocates a single module-wide fallback texture. All materials share it when
 * `uUseShoreSdf === 0` or after {@link setOceanShoreSdf}(…, `null`). Avoids leaking one 1x1
 * texture per {@link createOceanMaterial} call.
 */
function getShoreSdfFallbackTexture(): THREE.DataTexture {
  if (!shoreSdfFallbackTexture) {
    shoreSdfFallbackTexture = new THREE.DataTexture(
      new Uint8Array([0, 0, 0, 255]),
      1,
      1,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    shoreSdfFallbackTexture.needsUpdate = true;
  }
  return shoreSdfFallbackTexture;
}

export function createOceanMaterial(
  textures: OceanTextureBundle,
  depthTexture: THREE.DepthTexture,
  config: Partial<OceanMaterialConfig> = {},
): { material: THREE.RawShaderMaterial; uniforms: OceanMaterialUniforms } {
  const c = { ...defaultConfig, ...config };

  const uniforms: OceanMaterialUniforms = {
    uHeightMap: { value: textures.height },
    uBaseColor: { value: textures.baseColor },
    uNormalMap: { value: textures.normal },
    uSceneDepth: { value: depthTexture },
    uFoamMask: { value: textures.foamMask },
    uTime: { value: 0 },
    uHeightScroll: { value: c.heightScroll.clone() },
    uAlbedoScroll: { value: c.albedoScroll.clone() },
    uNormalScroll: { value: c.normalScroll.clone() },
    uHeightTiling: { value: c.heightTiling },
    uSurfaceTiling: { value: c.surfaceTiling },
    uDisplacement: { value: c.displacement },
    uLightDirWorld: { value: new THREE.Vector3(0.35, 0.85, 0.35).normalize() },
    uCameraPos: { value: new THREE.Vector3() },
    uShallowColor: { value: c.shallowColor.clone() },
    uDeepColor: { value: c.deepColor.clone() },
    uShallowAlpha: { value: c.shallowAlpha },
    uDeepAlpha: { value: c.deepAlpha },
    uAbsorption: { value: c.absorption },
    uFoamWidth: { value: c.foamWidth },
    uFoamOuterShoreOffset: { value: c.foamOuterShoreOffset },
    uFoamStrength: { value: c.foamStrength },
    uFoamMaskTiling: { value: c.foamMaskTiling },
    uFoamMaskScroll: { value: c.foamMaskScroll.clone() },
    uFoamMaskThreshold: { value: c.foamMaskThreshold },
    uIslandBounds: { value: new THREE.Vector4(-1, -1, 1, 1) },
    uShoreSdf: { value: getShoreSdfFallbackTexture() },
    uShoreSdfBounds: { value: new THREE.Vector4(-1, -1, 1, 1) },
    uShoreSdfMaxDistance: { value: 1 },
    uUseShoreSdf: { value: 0 },
    uFoamShapeNoiseAmount: { value: c.foamShapeNoiseAmount },
    uFoamShapeNoiseScale: { value: c.foamShapeNoiseScale },
    uFoamShapeNoiseScroll: { value: c.foamShapeNoiseScroll.clone() },
    uFoamBaseRingWidth: { value: c.foamBaseRingWidth },
    uDepthTintAmount: { value: c.depthTintAmount },
    uSurfaceBrightness: { value: c.surfaceBrightness },
    uSpecStrength: { value: c.specStrength },
    uFresnelStrength: { value: c.fresnelStrength },
    uCameraNear: { value: 0.1 },
    uCameraFar: { value: 200 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uInverseProjection: { value: new THREE.Matrix4() },
    uInverseView: { value: new THREE.Matrix4() },
    modelMatrix: { value: new THREE.Matrix4() },
    modelViewMatrix: { value: new THREE.Matrix4() },
    projectionMatrix: { value: new THREE.Matrix4() },
    normalMatrix: { value: new THREE.Matrix3() },
  };

  const material = new THREE.RawShaderMaterial({
    vertexShader: oceanVert,
    fragmentShader: oceanFrag,
    uniforms: uniforms as unknown as { [key: string]: THREE.IUniform<unknown> },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.FrontSide,
  });

  if (c.shoreSdf) setOceanShoreSdf(uniforms, c.shoreSdf);

  return { material, uniforms };
}

/**
 * Bind (or unbind) a baked shore distance field to an ocean material's uniforms.
 *
 * Pass a {@link ShoreSdf} produced by `buildShoreSdf` to make the outer foam follow that geometry's
 * silhouette. Pass `null` to switch back to the rectangular `uIslandBounds` AABB path.
 *
 * When unbinding, the shared module fallback is re-bound to `uShoreSdf` so it never keeps a pointer
 * to a texture the caller may have disposed. `uShoreSdfBounds` and `uShoreSdfMaxDistance` are reset to
 * the same defaults as {@link createOceanMaterial} (they are unused while `uUseShoreSdf` is 0, but
 * this avoids stale values in debuggers and future shader edits).
 */
export function setOceanShoreSdf(
  uniforms: OceanMaterialUniforms,
  shoreSdf: ShoreSdf | null,
): void {
  if (shoreSdf) {
    uniforms.uShoreSdf.value = shoreSdf.texture;
    uniforms.uShoreSdfBounds.value.copy(shoreSdf.bounds);
    uniforms.uShoreSdfMaxDistance.value = shoreSdf.maxDistance;
    uniforms.uUseShoreSdf.value = 1;
  } else {
    uniforms.uShoreSdf.value = getShoreSdfFallbackTexture();
    uniforms.uShoreSdfBounds.value.set(-1, -1, 1, 1);
    uniforms.uShoreSdfMaxDistance.value = 1;
    uniforms.uUseShoreSdf.value = 0;
  }
}

/**
 * Push per-frame matrices into the ocean shader. Call once per frame before rendering water.
 */
export function bindOceanMatrices(
  uniforms: OceanMaterialUniforms,
  mesh: THREE.Mesh,
  camera: THREE.PerspectiveCamera,
): void {
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  uniforms.modelMatrix.value.copy(mesh.matrixWorld);
  uniforms.modelViewMatrix.value.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
  uniforms.normalMatrix.value.getNormalMatrix(uniforms.modelViewMatrix.value as THREE.Matrix4);
  uniforms.projectionMatrix.value.copy(camera.projectionMatrix);

  uniforms.uInverseProjection.value.copy(camera.projectionMatrixInverse);
  uniforms.uInverseView.value.copy(camera.matrixWorld);

  uniforms.uCameraPos.value.copy(camera.position);
  uniforms.uCameraNear.value = camera.near;
  uniforms.uCameraFar.value = camera.far;
}
