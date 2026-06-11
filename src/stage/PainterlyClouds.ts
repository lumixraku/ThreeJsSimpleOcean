import * as THREE from "three";

import cloudsVert from "./shaders/clouds.vert.glsl?raw";
import cloudsFrag from "./shaders/clouds.frag.glsl?raw";

export type PainterlyCloudsConfig = {
  /** Distance from origin to the cloud wall, in world units. */
  radius: number;
  /** Y of the band's bottom edge. */
  baseY: number;
  /** Vertical extent of the band. */
  height: number;
  /** fbm threshold: lower = more cloud. */
  coverage: number;
  /** Output color scale; per-frame day/night dimming multiplies into the uniform. */
  brightness: number;
};

export type PainterlyCloudsUniforms = {
  uTime: THREE.IUniform<number>;
  uSunDirection: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uCoverage: THREE.IUniform<number>;
  uBrightness: THREE.IUniform<number>;
};

/**
 * Stylized "oil sketch" cloud band: a single inward-facing cylinder around the scene with a
 * procedural fbm shader (see clouds.frag.glsl). One draw call, no render targets, no temporal
 * accumulation — the cheap replacement for the volumetric cloud pass.
 *
 * The caller is expected to draw it OUTSIDE the EffectComposer chain (Scene.tsx puts it on its
 * own camera layer, rendered after the composer but before the reflection copy + ocean overlay):
 * the shader's colors are final post-tonemap values, and AerialPerspective would wash them out.
 */
export function buildPainterlyClouds(config: PainterlyCloudsConfig): {
  mesh: THREE.Mesh;
  uniforms: PainterlyCloudsUniforms;
  dispose: () => void;
} {
  const { radius, baseY, height, coverage, brightness } = config;

  const geometry = new THREE.CylinderGeometry(
    radius,
    radius,
    height,
    128,
    1,
    true,
  );

  const uniforms: PainterlyCloudsUniforms = {
    uTime: { value: 0 },
    uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uCoverage: { value: coverage },
    uBrightness: { value: brightness },
  };

  const material = new THREE.ShaderMaterial({
    vertexShader: cloudsVert,
    fragmentShader: cloudsFrag,
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false, // drawn straight onto the depthless canvas, after the composer
    side: THREE.BackSide, // camera lives inside the cylinder
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = baseY + height / 2;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  return {
    mesh,
    uniforms,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}
