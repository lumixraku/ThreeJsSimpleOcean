import * as THREE from "three";

import skyVert from "./shaders/sky.vert.glsl?raw";
import skyFrag from "./shaders/sky.frag.glsl?raw";

/** Dedicated layer so the sky is skipped by the depth pre-pass without relying on caster tags. */
export const SKY_LAYER = 5;

export type SkyUniforms = {
  uTime: { value: number };
  uSunDir: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uZenithColor: { value: THREE.Color };
  uHorizonColor: { value: THREE.Color };
  uGroundColor: { value: THREE.Color };
  uCameraPos: { value: THREE.Vector3 };
  uInverseProjection: { value: THREE.Matrix4 };
  uInverseView: { value: THREE.Matrix4 };
  uCloudCoverage: { value: number };
  uCloudDensity: { value: number };
  uCloudHeight: { value: number };
  uCloudThickness: { value: number };
  uCloudScale: { value: number };
  uCloudSpeed: { value: number };
  uCloudAbsorb: { value: number };
  uCloudWind: { value: THREE.Vector2 };
};

export type SkySystem = {
  mesh: THREE.Mesh;
  material: THREE.RawShaderMaterial;
  uniforms: SkyUniforms;
  /** Advance time and refresh camera-derived uniforms. */
  update(camera: THREE.PerspectiveCamera, dtSeconds: number): void;
  dispose(): void;
};

export function createSky(): SkySystem {
  const uniforms: SkyUniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.3, 0.15, 0.94).normalize() },
    uSunColor: { value: new THREE.Color(1.0, 0.78, 0.55) },
    uZenithColor: { value: new THREE.Color(0.1, 0.18, 0.32) },
    uHorizonColor: { value: new THREE.Color(0.95, 0.55, 0.3) },
    uGroundColor: { value: new THREE.Color(0.04, 0.05, 0.08) },
    uCameraPos: { value: new THREE.Vector3() },
    uInverseProjection: { value: new THREE.Matrix4() },
    uInverseView: { value: new THREE.Matrix4() },
    uCloudCoverage: { value: 0.5 },
    uCloudDensity: { value: 1.0 },
    uCloudHeight: { value: 70.0 },
    uCloudThickness: { value: 28.0 },
    uCloudScale: { value: 28.0 },
    uCloudSpeed: { value: 0.4 },
    uCloudAbsorb: { value: 0.6 },
    uCloudWind: { value: new THREE.Vector2(1.0, 0.2) },
  };

  // Single full-screen triangle covering NDC [-1,1]^2 — cheaper than a quad and avoids the diagonal seam.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );
  geometry.setAttribute(
    "uv",
    new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2),
  );

  const material = new THREE.RawShaderMaterial({
    vertexShader: skyVert,
    fragmentShader: skyFrag,
    uniforms: uniforms as unknown as { [k: string]: THREE.IUniform<unknown> },
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    transparent: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  // Draw before everything else so subsequent opaque geometry overpaints it correctly.
  mesh.renderOrder = -1000;
  // Layer 0 is disabled, SKY_LAYER enabled, so it skips passes that filter to OCEAN_DEPTH_CASTER_LAYER.
  mesh.layers.set(SKY_LAYER);

  function update(camera: THREE.PerspectiveCamera, dtSeconds: number): void {
    uniforms.uTime.value += dtSeconds;
    camera.updateMatrixWorld();
    uniforms.uInverseProjection.value.copy(camera.projectionMatrixInverse);
    uniforms.uInverseView.value.copy(camera.matrixWorld);
    uniforms.uCameraPos.value.copy(camera.position);
  }

  function dispose(): void {
    geometry.dispose();
    material.dispose();
  }

  return { mesh, material, uniforms, update, dispose };
}
