import * as THREE from "three";

export type MountainRingConfig = {
  /** Distance from origin to the wall, in world units. */
  radius: number;
  /** Y of the wall's bottom edge (should be below water surface so the base is hidden). */
  baseY: number;
  /** Minimum peak height above the base. */
  minHeight: number;
  /** Maximum peak height above the base. */
  maxHeight: number;
  /** Number of vertical columns around the arc. Higher = smoother silhouette. */
  segments: number;
  /** Base material color. AerialPerspective will tint distant ridges toward sky tone. */
  color: THREE.Color;
  /** Seed for the silhouette noise — same seed = same shape. */
  seed: number;
  /** Center angle of the arc in radians (0 = +X axis, π/2 = +Z axis). */
  arcCenter: number;
  /** Total angular width of the arc in radians. Ends taper to sea level for a soft fade. */
  arcWidth: number;
  /** Fraction (0..0.5) of the arc devoted to each end-fade. 0.18 ≈ outer 18% on each side. */
  endFade: number;
};

function hashI(i: number): number {
  let n = (Math.imul(i, 374761393) ^ 668265263) >>> 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0;
  n = (n ^ (n >>> 16)) >>> 0;
  return n / 0x100000000;
}

function arcFbm(t: number, seed: number): number {
  const octaves = [
    { M: 6, amp: 0.55 },
    { M: 13, amp: 0.27 },
    { M: 27, amp: 0.13 },
    { M: 59, amp: 0.05 },
  ];
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves.length; o++) {
    const { M, amp } = octaves[o];
    norm += amp;
    const u = t * M;
    const k0 = Math.floor(u);
    const k1 = k0 + 1;
    const f = u - k0;
    const ts = f * f * f * (f * (f * 6 - 15) + 10);
    const p0 = hashI(k0 + seed * 7919 + o * 104729);
    const p1 = hashI(k1 + seed * 7919 + o * 104729);
    sum += amp * (p0 * (1 - ts) + p1 * ts);
  }
  return sum / norm;
}

function arcEnvelope(t: number, endFade: number): number {
  const f = Math.max(1e-4, Math.min(0.5, endFade));
  const rise = THREE.MathUtils.smoothstep(t, 0, f);
  const fall = THREE.MathUtils.smoothstep(t, 1 - f, 1);
  return rise * (1 - fall);
}

/**
 * Minimal horizon-mountain arc: a vertical wall over one angular slice around the origin, with
 * an fbm-displaced top edge and smooth end-fade. Rendered with a flat MeshStandardMaterial so
 * AerialPerspective can tint the distant silhouette toward the sky color naturally — no
 * emissive or vertex-color tricks, the haze is what sells the "distant ridges" read.
 *
 * NOT a depth caster — kept off `OCEAN_DEPTH_CASTER_LAYER`. If it were a caster the water
 * shader's `if (sceneDepth < waterDepth) discard` would clip far water behind the wall.
 */
export function buildMountainRing(config: MountainRingConfig): {
  mesh: THREE.Mesh;
  dispose: () => void;
} {
  const { radius, baseY, minHeight, maxHeight, segments, color, seed,
          arcCenter, arcWidth, endFade } = config;

  const vertCount = (segments + 1) * 2;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const angle = arcCenter + (t - 0.5) * arcWidth;
    const cx = Math.cos(angle);
    const cz = Math.sin(angle);
    const x = cx * radius;
    const z = cz * radius;

    const env = arcEnvelope(t, endFade);
    const heightN = arcFbm(t, seed);
    const topY = baseY + (minHeight + heightN * (maxHeight - minHeight)) * env;

    const baseIdx = i * 6;
    positions[baseIdx + 0] = x;
    positions[baseIdx + 1] = baseY;
    positions[baseIdx + 2] = z;
    positions[baseIdx + 3] = x;
    positions[baseIdx + 4] = topY;
    positions[baseIdx + 5] = z;

    // Inward-pointing normals (camera lives inside the ring).
    normals[baseIdx + 0] = -cx;
    normals[baseIdx + 1] = 0;
    normals[baseIdx + 2] = -cz;
    normals[baseIdx + 3] = -cx;
    normals[baseIdx + 4] = 0;
    normals[baseIdx + 5] = -cz;
  }

  const indices = new Uint32Array(segments * 6);
  for (let i = 0; i < segments; i++) {
    const a0 = i * 2;
    const a1 = i * 2 + 1;
    const b0 = (i + 1) * 2;
    const b1 = (i + 1) * 2 + 1;
    const o = i * 6;
    indices[o + 0] = a0;
    indices[o + 1] = a1;
    indices[o + 2] = b1;
    indices[o + 3] = a0;
    indices[o + 4] = b1;
    indices[o + 5] = b0;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));

  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geom, material);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  return {
    mesh,
    dispose: () => {
      geom.dispose();
      material.dispose();
    },
  };
}
