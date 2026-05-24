import * as THREE from "three";

/** Layer mask for geometry that should appear in the cheap depth pre-pass. */
export const OCEAN_DEPTH_CASTER_LAYER = 1;

const registeredDepthCasterScenes = new WeakSet<THREE.Scene>();

function findParentScene(object: THREE.Object3D): THREE.Scene | null {
  let node: THREE.Object3D | null = object;
  while (node) {
    if ((node as THREE.Scene).isScene) return node as THREE.Scene;
    node = node.parent;
  }
  return null;
}

/**
 * Mark `scene` as using layer-filtered depth casters in {@link renderFrame}.
 * Call once after tagging casters (e.g. when roots are tagged before being added to the scene).
 */
export function registerOceanDepthCastersScene(scene: THREE.Scene): void {
  registeredDepthCasterScenes.add(scene);
}

/** O(1) check — no scene graph traversal. */
export function hasOceanDepthCasters(scene: THREE.Scene): boolean {
  return registeredDepthCasterScenes.has(scene);
}

/**
 * Enable {@link OCEAN_DEPTH_CASTER_LAYER} on every mesh under `object`.
 * Meshes remain on the default layer for the main opaque pass.
 *
 * When `scene` is omitted, registers the parent {@link THREE.Scene} if the object is already
 * in the graph. Otherwise call {@link registerOceanDepthCastersScene} once after adding roots.
 */
export function tagOceanDepthCasters(object: THREE.Object3D, scene?: THREE.Scene): void {
  object.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      child.layers.enable(OCEAN_DEPTH_CASTER_LAYER);
    }
  });

  const targetScene = scene ?? findParentScene(object);
  if (targetScene) {
    registeredDepthCasterScenes.add(targetScene);
  }
}
