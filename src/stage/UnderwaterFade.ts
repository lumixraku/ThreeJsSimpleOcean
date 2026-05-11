import * as THREE from "three";

export type UnderwaterFadeParams = {
  waterLevelY: number;
  deepColor: THREE.Color;
  fadeDistance: number;
  maxStrength?: number;
};

/**
 * Adds a world-space underwater tint to MeshStandardMaterial via onBeforeCompile.
 * This makes geometry below the waterline fade toward `deepColor`.
 */
export function applyUnderwaterFade(root: THREE.Object3D, params: UnderwaterFadeParams): void {
  const maxStrength = params.maxStrength ?? 0.9;

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of materials) {
      const mat = m as THREE.MeshStandardMaterial;
      if (!(mat && (mat as unknown as { isMeshStandardMaterial?: boolean }).isMeshStandardMaterial)) continue;

      const deep = params.deepColor.clone();
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uWaterLevelY = { value: params.waterLevelY };
        shader.uniforms.uFadeDistance = { value: params.fadeDistance };
        shader.uniforms.uDeepColor = { value: deep };
        shader.uniforms.uMaxStrength = { value: maxStrength };

        shader.vertexShader =
          shader.vertexShader +
          "\n" +
          "varying vec3 vWorldPosUF;\n";

        shader.vertexShader = shader.vertexShader.replace(
          "#include <worldpos_vertex>",
          [
            "#include <worldpos_vertex>",
            "vWorldPosUF = worldPosition.xyz;",
          ].join("\n"),
        );

        shader.fragmentShader =
          "varying vec3 vWorldPosUF;\n" +
          "uniform float uWaterLevelY;\n" +
          "uniform float uFadeDistance;\n" +
          "uniform vec3 uDeepColor;\n" +
          "uniform float uMaxStrength;\n" +
          shader.fragmentShader;

        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <output_fragment>",
          [
            "float below = max(0.0, uWaterLevelY - vWorldPosUF.y);",
            "float t = clamp(below / max(uFadeDistance, 0.0001), 0.0, 1.0);",
            // Smooth to avoid a hard band at the waterline.
            "t = smoothstep(0.0, 1.0, t) * uMaxStrength;",
            // outgoingLight is defined by <output_fragment> path.
            "outgoingLight = mix(outgoingLight, uDeepColor, t);",
            "#include <output_fragment>",
          ].join("\n"),
        );
      };

      mat.needsUpdate = true;
    }
  });
}

