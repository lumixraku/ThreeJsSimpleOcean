/**
 * Ocean Simple — Three.js ocean surface material and render helpers.
 * @packageDocumentation
 */

export {
  bindOceanMatrices,
  createOceanMaterial,
  setOceanShoreSdf,
  type OceanMaterialConfig,
  type OceanMaterialUniforms,
} from "./ocean/OceanMaterial";

export {
  buildShoreSdf,
  type BuildShoreSdfOptions,
  type ShoreSdf,
} from "./ocean/ShoreSdf";

export { loadOceanTextures, type OceanTextureBundle } from "./loading/TextureBundleLoader";

export { AdaptiveDepthScale, type AdaptiveDepthScaleOptions } from "./rendering/AdaptiveDepthScale";
export { DepthPrePassTarget } from "./rendering/DepthPrePassTarget";
export { BlitPass } from "./rendering/BlitPass";
export {
  renderFrame,
  type FrameRenderContext,
  type RenderFrameOptions,
} from "./rendering/FrameRenderer";
export {
  OCEAN_DEPTH_CASTER_LAYER,
  hasOceanDepthCasters,
  registerOceanDepthCastersScene,
  tagOceanDepthCasters,
} from "./rendering/OceanDepthLayers";
