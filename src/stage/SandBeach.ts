import * as THREE from "three";

// Heightmapped sand island ported from /Users/raku/repos/sandcastle and adapted for this scene:
//   - Cubic radial falloff with PEAK above water + TROUGH below water (TROUGH matches the seabed
//     so the submerged sand slope merges into the dark floor plane naturally).
//   - Azimuthal noise on the effective radius makes the shoreline organic, not a perfect circle.
//   - The shore proxy mesh is built from the *same* azimuthal function so foam SDF traces the
//     visible coastline.
//   - A procedural canvas grain bump map breaks the smooth-lacquer look.

const ISLAND_RADIUS = 10;
const SAND_PEAK_ABOVE_WATER = 0.6;
// Match the underwater dive to the actual seabed depth (FLOOR_Y at -2.0, WATER_Y at 1.5
// → 3.5 below water). That way the submerged sand slope meets the dark seafloor plane
// smoothly at the disc edge instead of cutting off as a visible muffin shape.
const SAND_TROUGH_BELOW_WATER = 3.5;
const PLANE_SIZE = ISLAND_RADIUS * 2.6;
const PLANE_SEGMENTS = 240;

// Fraction of the effective (azimuthally-deformed) radius where `1 - t^3` crosses the water
// plane: solve `1 - t^3 = TROUGH / (TROUGH + PEAK)` for t. With PEAK=0.6 / TROUGH=3.5 this lands
// at ~0.527.
const SHORE_FRACTION = 0.527;

function hash(x: number, y: number): number {
  const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

function smoothNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return (
    a * (1 - ux) * (1 - uy) +
    b * ux * (1 - uy) +
    c * (1 - ux) * uy +
    d * ux * uy
  );
}

/**
 * Azimuthal modulation of the island radius, in ±0.2 range. Three octaves of sinusoids
 * keyed off the angle so the shoreline curves in and out — small bays, gentle headlands —
 * without any non-deterministic noise. The shore-proxy polygon uses the same function so
 * the water foam SDF traces this exact silhouette.
 */
function shoreWave(angleRad: number): number {
  return (
    0.10 * Math.sin(angleRad * 2 + 0.7) +
    0.07 * Math.sin(angleRad * 4 - 1.3) +
    0.04 * Math.cos(angleRad * 7 + 2.1)
  );
}

function effectiveRadius(angleRad: number): number {
  return ISLAND_RADIUS * (1 + shoreWave(angleRad));
}

function sandHeight(x: number, z: number, waterY: number): number {
  const r = Math.sqrt(x * x + z * z);
  const a = Math.atan2(z, x);
  const er = effectiveRadius(a);
  // Outside the island, continue diving smoothly so the plane edge ends up hidden under the
  // dark seafloor plane.
  if (r > er) {
    const k = Math.min(1, (r - er) / 4);
    return waterY - SAND_TROUGH_BELOW_WATER - k * 6;
  }
  const trough = waterY - SAND_TROUGH_BELOW_WATER;
  const peak = waterY + SAND_PEAK_ABOVE_WATER;
  const t = r / er;
  const plateau = 1 - t * t * t;
  let h = trough + (peak - trough) * plateau;
  // Soft two-octave dune noise so the dry-sand plateau reads as dune-y, not as a flat lid.
  const n =
    smoothNoise(x * 0.35 + 12.3, z * 0.35 - 4.7) * 0.6 +
    smoothNoise(x * 0.9 - 7.1, z * 0.9 + 9.4) * 0.25;
  const shoreFade = Math.max(0, 1 - Math.pow(t, 4));
  h += (n - 0.45) * 0.28 * shoreFade;
  return h;
}

/**
 * Procedural sand-grain bump map. Mid-gray base + thousands of tiny dark/light specks so the
 * standard material treats it as a height field and perturbs the surface normal per-pixel.
 * Tiled across the disc — the actual world frequency is set by `repeat`.
 */
function buildSandGrainBumpTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 18000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const v = Math.random();
    const a = 0.18 + Math.random() * 0.22;
    ctx.fillStyle = v > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    ctx.fillRect(x, y, 1.4, 1.4);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  // Tile densely across the 26m plane so each grain projects to multiple screen pixels.
  tex.repeat.set(14, 14);
  return tex;
}

/**
 * Build the shore-proxy polygon: a flat triangle fan from origin out to `effectiveRadius * SHORE_FRACTION`
 * at each angle. Captures the above-water silhouette only — buildShoreSdf clones this for the
 * top-down silhouette render, so it never needs to live in the scene graph.
 */
function buildShoreProxy(waterY: number): { mesh: THREE.Mesh; dispose: () => void } {
  const N = 192;
  const positions = new Float32Array((N + 2) * 3);
  positions[0] = 0;
  positions[1] = 0;
  positions[2] = 0;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = effectiveRadius(a) * SHORE_FRACTION;
    const o = (i + 1) * 3;
    positions[o + 0] = Math.cos(a) * r;
    positions[o + 1] = 0;
    positions[o + 2] = Math.sin(a) * r;
  }
  const indices = new Uint16Array(N * 3);
  for (let i = 0; i < N; i++) {
    indices[i * 3 + 0] = 0;
    indices[i * 3 + 1] = i + 1;
    indices[i * 3 + 2] = i + 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();

  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = waterY;
  // NB: leave `visible = true`. buildShoreSdf clones this object for an offscreen render, and
  // the clone inherits this flag — `visible = false` would render an empty silhouette and the
  // SDF would treat the entire bake region as deep water (no foam fires). The proxy is never
  // added to the live scene graph, so visibility here only matters during the silhouette bake.

  return {
    mesh,
    dispose: () => {
      geo.dispose();
      mat.dispose();
    },
  };
}

export type SandBeach = {
  /** Visible heightmapped sand mesh. Add to the scene and tag as a depth caster. */
  mesh: THREE.Mesh;
  /** Invisible top-down silhouette polygon. Feed to buildShoreSdf / computeTileBoundsXZ so
   *  foam math sees only the above-water coastline (azimuthally deformed, not a circle). */
  shoreProxy: THREE.Mesh;
  dispose: () => void;
};

export function buildSandBeach(opts: { waterY: number }): SandBeach {
  const { waterY } = opts;

  const geo = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE, PLANE_SEGMENTS, PLANE_SEGMENTS);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);

  const dry = new THREE.Color("#e9d3a3");
  const dryShade = new THREE.Color("#cfa974");
  const wet = new THREE.Color("#a98655");
  const deep = new THREE.Color("#6b513a");

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = sandHeight(x, z, waterY);
    pos.setY(i, h);

    const r = Math.sqrt(x * x + z * z);
    const er = effectiveRadius(Math.atan2(z, x));
    // Wet-sand band keyed off the *fractional* radius, so it follows the deformed shoreline.
    const tInLand = THREE.MathUtils.clamp(r / er, 0, 1);
    const shoreT = THREE.MathUtils.clamp((tInLand - 0.78) / 0.22, 0, 1);
    const dune = THREE.MathUtils.clamp((h - waterY) / 0.5, 0, 1);
    const c = new THREE.Color();
    if (r > er) {
      c.copy(deep);
    } else {
      const top = dry.clone().lerp(dryShade, 1 - dune);
      c.copy(top).lerp(wet, shoreT);
    }
    // Per-vertex luminance jitter so the surface doesn't read as a flat gradient. We use a
    // 2D hash instead of `sin(ax+bz)` — the latter produces visible diagonal stripes when the
    // viewing angle aligns with the wave plane of (a, b).
    const grain = hash(x * 3.71 + 1.7, z * 2.91 - 4.3) * 0.05;
    c.offsetHSL(0, 0, (grain - 0.025) * 0.6);

    colors[i * 3 + 0] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const bumpMap = buildSandGrainBumpTexture();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0.02,
    flatShading: false,
    bumpMap,
    bumpScale: 0.18,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  const proxy = buildShoreProxy(waterY);

  return {
    mesh,
    shoreProxy: proxy.mesh,
    dispose: () => {
      geo.dispose();
      mat.dispose();
      bumpMap.dispose();
      proxy.dispose();
    },
  };
}
