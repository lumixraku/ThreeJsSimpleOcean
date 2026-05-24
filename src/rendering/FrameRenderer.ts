import * as THREE from "three";
import type { OceanMaterialUniforms } from "../ocean/OceanMaterial";
import { bindOceanMatrices } from "../ocean/OceanMaterial";
import type { AdaptiveDepthScale } from "./AdaptiveDepthScale";
import { getDepthPrePassMaterial } from "./DepthPrePassMaterial";
import { DepthPrePassTarget } from "./DepthPrePassTarget";
import { hasOceanDepthCasters, OCEAN_DEPTH_CASTER_LAYER } from "./OceanDepthLayers";

export type RenderFrameOptions = {
  /**
   * Fixed depth pre-pass resolution scale (1 = full drawing-buffer size).
   * Ignored when `adaptiveDepthScale` is provided.
   */
  depthResolutionScale?: number;
  /** Adaptive 0.5↔0.25 depth scale controller. When set, `depthResolutionScale` is ignored. */
  adaptiveDepthScale?: AdaptiveDepthScale;
  /** Frame delta in milliseconds — required when using `adaptiveDepthScale`. */
  frameDeltaMs?: number;
  /** Use {@link THREE.MeshDepthMaterial} override in pass 1 (default true). */
  useDepthOverrideMaterial?: boolean;
  /** Restrict pass 1 to {@link OCEAN_DEPTH_CASTER_LAYER} when the opaque scene is registered (default true). */
  useDepthCasterLayers?: boolean;
  /** Override layer filtering: `true` = filter, `false` = full opaque scene, `undefined` = use registration flag. */
  filterDepthCasters?: boolean;
  /** Disable shadow map updates during pass 1 (default true). */
  disableShadowsInDepthPass?: boolean;
};

export type FrameRenderContext = {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  opaqueScene: THREE.Scene;
  waterScene: THREE.Scene;
  oceanMesh: THREE.Mesh;
  oceanUniforms: OceanMaterialUniforms;
  depthPass: DepthPrePassTarget;
  options?: RenderFrameOptions;
};

/**
 * Cheap depth pre-pass → full opaque pass to screen → transparent ocean sampling depth texture.
 */
export function renderFrame(ctx: FrameRenderContext): void {
  const {
    renderer,
    camera,
    opaqueScene,
    waterScene,
    oceanMesh,
    oceanUniforms,
    depthPass,
    options = {},
  } = ctx;

  const {
    depthResolutionScale = 1,
    adaptiveDepthScale,
    frameDeltaMs = 0,
    useDepthOverrideMaterial = true,
    useDepthCasterLayers = true,
    filterDepthCasters,
    disableShadowsInDepthPass = true,
  } = options;

  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);

  const depthScale = adaptiveDepthScale
    ? adaptiveDepthScale.update(frameDeltaMs)
    : depthResolutionScale;

  depthPass.setSize(size.x, size.y, depthScale);
  oceanUniforms.uResolution.value.set(size.x, size.y);

  // --- Pass 1: cheap depth pre-pass into RT ---
  const prevRenderTarget = renderer.getRenderTarget();
  const prevOverride = opaqueScene.overrideMaterial;
  const prevCameraLayers = camera.layers.mask;
  const prevShadowAutoUpdate = renderer.shadowMap.autoUpdate;
  const prevShadowEnabled = renderer.shadowMap.enabled;

  renderer.setRenderTarget(depthPass.renderTarget);
  renderer.clear(false, true, false);

  if (useDepthOverrideMaterial) {
    opaqueScene.overrideMaterial = getDepthPrePassMaterial();
  }

  if (disableShadowsInDepthPass) {
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.enabled = false;
  }

  const filterDepthCastersPass =
    useDepthCasterLayers && (filterDepthCasters ?? hasOceanDepthCasters(opaqueScene));
  if (filterDepthCastersPass) {
    camera.layers.set(OCEAN_DEPTH_CASTER_LAYER);
  }

  try {
    renderer.render(opaqueScene, camera);
  } finally {
    opaqueScene.overrideMaterial = prevOverride;
    camera.layers.mask = prevCameraLayers;
    renderer.shadowMap.autoUpdate = prevShadowAutoUpdate;
    renderer.shadowMap.enabled = prevShadowEnabled;
    renderer.setRenderTarget(prevRenderTarget);
  }

  // --- Pass 2: full opaque pass to screen (correct color + default depth buffer) ---
  renderer.setRenderTarget(null);
  renderer.clear(true, true, true);
  renderer.render(opaqueScene, camera);

  bindOceanMatrices(oceanUniforms, oceanMesh, camera);
  oceanUniforms.uSceneDepth.value = depthPass.depthTexture;

  // --- Pass 3: transparent water ---
  renderer.autoClear = false;
  renderer.render(waterScene, camera);
  renderer.autoClear = true;
}
