import * as THREE from "three";

/** Layer mask for geometry that should appear in the cheap depth pre-pass. */
export const OCEAN_DEPTH_CASTER_LAYER = 1;

/**
 * Enable {@link OCEAN_DEPTH_CASTER_LAYER} on every mesh under `object`.
 * Meshes remain on the default layer for the main opaque pass.
 */
export function tagOceanDepthCasters(object: THREE.Object3D): void {
  object.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      child.layers.enable(OCEAN_DEPTH_CASTER_LAYER);
    }
  });
}

/**
 * Returns true when at least one mesh in `scene` participates in the depth-caster layer.
 * Used to fall back to a full-scene depth pass for backward compatibility.
 */
export function hasOceanDepthCasters(scene: THREE.Scene): boolean {
  let found = false;
  scene.traverse((child) => {
    if (found) return;
    if ((child as THREE.Mesh).isMesh && child.layers.isEnabled(OCEAN_DEPTH_CASTER_LAYER)) {
      found = true;
    }
  });
  return found;
}
