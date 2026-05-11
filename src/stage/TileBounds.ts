import * as THREE from "three";

/**
 * Axis-aligned bounds on XZ for shader-driven edge foam (minX, minZ, maxX, maxZ).
 */
export function computeTileBoundsXZ(root: THREE.Object3D, padding = 0.05): THREE.Vector4 {
  const box = new THREE.Box3().setFromObject(root);
  return new THREE.Vector4(
    box.min.x - padding,
    box.min.z - padding,
    box.max.x + padding,
    box.max.z + padding,
  );
}
