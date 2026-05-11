import * as THREE from "three";
import type { OceanMaterialUniforms } from "../ocean/OceanMaterial";
import { bindOceanMatrices } from "../ocean/OceanMaterial";
import { BlitPass } from "./BlitPass";
import { DepthPrePassTarget } from "./DepthPrePassTarget";

export type FrameRenderContext = {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  opaqueScene: THREE.Scene;
  waterScene: THREE.Scene;
  oceanMesh: THREE.Mesh;
  oceanUniforms: OceanMaterialUniforms;
  depthPass: DepthPrePassTarget;
  blitPass: BlitPass;
};

/**
 * Opaque depth/color pre-pass → blit color → transparent ocean with shared depth texture.
 */
export function renderFrame(ctx: FrameRenderContext): void {
  const { renderer, camera, opaqueScene, waterScene, oceanMesh, oceanUniforms, depthPass, blitPass } = ctx;

  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  depthPass.setSize(size.x, size.y);
  oceanUniforms.uResolution.value.set(size.x, size.y);

  // 1) Pre-pass into RT so water can sample depth for absorption/foam.
  // This RT is NOT what we present to screen.
  renderer.setRenderTarget(depthPass.renderTarget);
  renderer.clear(true, true, true);
  renderer.render(opaqueScene, camera);

  // 2) Render opaque scene to screen normally so the DEFAULT depth buffer is correct.
  // This is the standard way to ensure transparent water depth-tests properly against opaque geometry.
  renderer.setRenderTarget(null);
  renderer.clear(true, true, true);
  renderer.render(opaqueScene, camera);

  // Keep blit available for experimentation (unused in the correct-depth path).
  blitPass.setMap(depthPass.renderTarget.texture);

  bindOceanMatrices(oceanUniforms, oceanMesh, camera);
  oceanUniforms.uSceneDepth.value = depthPass.depthTexture;

  renderer.autoClear = false;
  renderer.render(waterScene, camera);
  renderer.autoClear = true;
}
