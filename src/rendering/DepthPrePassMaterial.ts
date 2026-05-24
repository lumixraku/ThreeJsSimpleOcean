import * as THREE from "three";

/** Shared depth-only override material for the opaque pre-pass. */
let depthPrePassMaterial: THREE.MeshDepthMaterial | null = null;

/**
 * Returns a module-scoped {@link THREE.MeshDepthMaterial} used as `scene.overrideMaterial`
 * during the depth pre-pass. Avoids per-frame allocation.
 */
export function getDepthPrePassMaterial(): THREE.MeshDepthMaterial {
  if (!depthPrePassMaterial) {
    depthPrePassMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.BasicDepthPacking,
      side: THREE.DoubleSide,
    });
  }
  return depthPrePassMaterial;
}
