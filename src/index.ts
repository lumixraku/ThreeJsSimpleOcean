/**
 * Ocean Simple — Three.js ocean surface material and render helpers.
 * @packageDocumentation
 */

export {
  bindOceanMatrices,
  createOceanMaterial,
  type OceanMaterialConfig,
  type OceanMaterialUniforms,
} from "./ocean/OceanMaterial";

export { loadOceanTextures, type OceanTextureBundle } from "./loading/TextureBundleLoader";

export { DepthPrePassTarget } from "./rendering/DepthPrePassTarget";
export { BlitPass } from "./rendering/BlitPass";
export { renderFrame, type FrameRenderContext } from "./rendering/FrameRenderer";
