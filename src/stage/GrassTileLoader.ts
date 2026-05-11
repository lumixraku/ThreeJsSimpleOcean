import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

export type GrassLoadResult = {
  root: THREE.Object3D;
  dispose: () => void;
};

/**
 * Loads the grass tile FBX and applies provided textures.
 */
export async function loadGrassTile(
  modelUrl: string,
  textures?: { baseColorUrl: string; normalUrl?: string },
): Promise<GrassLoadResult> {
  const loader = new FBXLoader();
  const root = await new Promise<THREE.Group>((resolve, reject) => {
    loader.load(modelUrl, resolve, undefined, reject);
  });

  normalizeGrassScale(root);
  centerAndGround(root);

  let loadedBase: THREE.Texture | null = null;
  let loadedNormal: THREE.Texture | null = null;
  if (textures) {
    const texLoader = new THREE.TextureLoader();
    loadedBase = await new Promise<THREE.Texture>((resolve, reject) => {
      texLoader.load(textures.baseColorUrl, resolve, undefined, reject);
    });
    loadedBase.colorSpace = THREE.SRGBColorSpace;
    loadedBase.wrapS = THREE.RepeatWrapping;
    loadedBase.wrapT = THREE.RepeatWrapping;

    if (textures.normalUrl) {
      loadedNormal = await new Promise<THREE.Texture>((resolve, reject) => {
        texLoader.load(textures.normalUrl!, resolve, undefined, reject);
      });
      loadedNormal.colorSpace = THREE.LinearSRGBColorSpace;
      loadedNormal.wrapS = THREE.RepeatWrapping;
      loadedNormal.wrapT = THREE.RepeatWrapping;
    }
  }

  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    if (mesh.material) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((m) => {
        const mat = (m as THREE.MeshStandardMaterial) ?? new THREE.MeshStandardMaterial();
        if (loadedBase) mat.map = loadedBase;
        if (loadedNormal) mat.normalMap = loadedNormal;
        mat.roughness = 1.0;
        mat.metalness = 0.0;
        mat.needsUpdate = true;
      });
    }
  });

  const dispose = () => {
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((m) => (m as THREE.Material).dispose());
    });
    loadedBase?.dispose();
    loadedNormal?.dispose();
  };

  return { root, dispose };
}

function normalizeGrassScale(root: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim < 1e-4) return;
  if (maxDim > 5.5 || maxDim < 0.35) {
    const s = 4 / maxDim;
    root.scale.setScalar(s);
  }
}

function centerAndGround(root: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());

  // Move XZ center to origin (keep Y centered for now)
  root.position.x -= center.x;
  root.position.z -= center.z;

  // Recompute after XZ shift, then place it on the ground (minY = 0)
  const box2 = new THREE.Box3().setFromObject(root);
  root.position.y -= box2.min.y;
}

export function makeGrassPlaceholder(): GrassLoadResult {
  const geo = new THREE.BoxGeometry(4, 0.35, 4, 4, 1, 4);
  const mat = new THREE.MeshStandardMaterial({ color: 0x3d6b2d, roughness: 0.9, metalness: 0.05 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 0.175;
  const root = new THREE.Group();
  root.add(mesh);

  return {
    root,
    dispose: () => {
      geo.dispose();
      mat.dispose();
    },
  };
}
