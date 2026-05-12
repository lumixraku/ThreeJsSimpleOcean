import * as THREE from "three";

/**
 * Options for {@link buildShoreSdf}.
 *
 * The bake produces a square XZ texture covering `bounds` (auto-derived from `object` if omitted).
 * The shader sampler reads the R channel as a normalized distance from shore, where
 * `texelValue * maxDistance` is world units away from the closest land pixel.
 */
export type BuildShoreSdfOptions = {
  /** Object whose silhouette to bake. Every visible mesh in this subtree counts as land. */
  object: THREE.Object3D;
  /** Optional explicit XZ rectangle covered by the SDF (minX, minZ, maxX, maxZ). If omitted, bounds are derived from `object` expanded by `max(padding, maxDistance)` so the texture still covers the full encoded distance range (see `maxDistance`). */
  bounds?: THREE.Vector4;
  /** Minimum world-unit padding past `object`'s silhouette when auto-deriving bounds. Default 12. The actual expansion is `max(padding, maxDistance)` unless `bounds` is set explicitly. */
  padding?: number;
  /** Square texture side length. Higher = sharper foam edges (cost is one-time). Default 256. */
  resolution?: number;
  /** World-unit distance that maps to value 1.0 in the texture. Foam beyond this clamps to "deep". Default = `padding`. When `bounds` is omitted, auto-derived bounds expand by `max(padding, maxDistance)` so this value is not truncated at the texture edge. If you pass explicit `bounds`, ensure they extend at least `maxDistance` from the shoreline in XZ or the same clamping artifact can occur. */
  maxDistance?: number;
};

/**
 * A baked top-down shore distance field, plus the metadata the ocean shader needs to sample it.
 *
 * Pass to {@link setOceanShoreSdf} (or via `createOceanMaterial({ shoreSdf })`) to make the outer
 * foam follow the actual coastline of any geometry, not just an XZ AABB.
 */
export type ShoreSdf = {
  /** Single-channel (RGBA8) texture. R = clamp(distance_from_shore / maxDistance, 0, 1). */
  texture: THREE.Texture;
  /** Square XZ rectangle the texture covers, in world units (minX, minZ, maxX, maxZ). */
  bounds: THREE.Vector4;
  /** World-unit distance represented by R == 1.0 in the texture. */
  maxDistance: number;
  /** Free GPU memory. Call when the SDF is no longer needed. */
  dispose: () => void;
};

/**
 * Bake a top-down shore distance field from arbitrary geometry.
 *
 * Pipeline:
 *   1. Pick / auto-derive a square XZ rectangle around `object` (extends shorter axis so pixels are isotropic).
 *      Auto bounds expand the silhouette by `max(padding, maxDistance)` so values out to `maxDistance` are not
 *      lost to UV clamping at the texture edge when `maxDistance > padding`.
 *   2. Deep-clone `object`, render its silhouette top-down with a flat white material into an RGBA8 RT
 *      (the live scene graph is never reparented).
 *   3. Run an exact 2D Euclidean distance transform on the CPU (Felzenszwalb & Huttenlocher 2004).
 *   4. Encode `clamp(distanceWorld / maxDistance, 0, 1)` into a `DataTexture`.
 *
 * Cost: one-time GPU readback (a few ms for 256²; ~10–30ms for 512²). Per-frame cost is one texture sample.
 *
 * Re-bake when the island geometry changes (e.g. tile add/remove). The function is safe to call again
 * to produce a fresh `ShoreSdf`; remember to `dispose()` the old one.
 */
export function buildShoreSdf(
  renderer: THREE.WebGLRenderer,
  options: BuildShoreSdfOptions,
): ShoreSdf {
  const padding = options.padding ?? 12;
  const resolution = Math.max(32, Math.floor(options.resolution ?? 256));
  const maxDistance = options.maxDistance ?? padding;

  const autoExpand = Math.max(padding, maxDistance);
  const bounds = options.bounds ? options.bounds.clone() : defaultBoundsFor(options.object, autoExpand);
  squareUp(bounds);

  const mask = renderSilhouette(renderer, options.object, bounds, resolution);
  const distSq = edt2d(mask, resolution, resolution);

  const worldPerPixel = (bounds.z - bounds.x) / resolution;
  const invMax = 1 / Math.max(maxDistance, 1e-6);

  const data = new Uint8Array(resolution * resolution * 4);
  for (let i = 0; i < resolution * resolution; i++) {
    const dW = Math.sqrt(distSq[i]) * worldPerPixel;
    const v = clampByte(dW * invMax * 255);
    const o = i * 4;
    data[o + 0] = v;
    data[o + 1] = v;
    data[o + 2] = v;
    data[o + 3] = 255;
  }

  const texture = new THREE.DataTexture(
    data,
    resolution,
    resolution,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return {
    texture,
    bounds,
    maxDistance,
    dispose: () => texture.dispose(),
  };
}

// -----------------------------------------------------------------------------
// Bounds helpers
// -----------------------------------------------------------------------------

/** Expand `object`'s XZ bounding box by `expand` world units on each side (used for auto-derived bounds). */
function defaultBoundsFor(object: THREE.Object3D, expand: number): THREE.Vector4 {
  const box = new THREE.Box3().setFromObject(object);
  if (
    box.isEmpty() ||
    !Number.isFinite(box.min.x) ||
    !Number.isFinite(box.min.z) ||
    !Number.isFinite(box.max.x) ||
    !Number.isFinite(box.max.z)
  ) {
    throw new Error(
      "buildShoreSdf could not derive bounds from options.object. Provide options.bounds explicitly or ensure the object subtree contains geometry with valid bounds.",
    );
  }
  return new THREE.Vector4(
    box.min.x - expand,
    box.min.z - expand,
    box.max.x + expand,
    box.max.z + expand,
  );
}

/** Mutate `b` so it's a square (extend the shorter axis equally on both sides). */
function squareUp(b: THREE.Vector4): void {
  const w = b.z - b.x;
  const h = b.w - b.y;
  if (Math.abs(w - h) < 1e-5) return;
  const cx = (b.x + b.z) * 0.5;
  const cz = (b.y + b.w) * 0.5;
  const half = Math.max(w, h) * 0.5;
  b.set(cx - half, cz - half, cx + half, cz + half);
}

function clampByte(v: number): number {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return Math.round(v);
}

// -----------------------------------------------------------------------------
// Silhouette pass
// -----------------------------------------------------------------------------

/**
 * Render `object` top-down with a flat white material into a `resolution²` RGBA8 RT and read back pixels.
 *
 * Uses a **deep clone** of `object` under a throwaway scene so the live scene graph is never
 * reparented (no ordering changes, no risk of leaving the source detached if something throws).
 * Geometries and materials are shared with the original where Three's `clone(true)` does so.
 *
 * Convention: returned `Uint8Array` is laid out so that the row index increases with world +Z and the
 * column index increases with world +X. This way uploading it as a `DataTexture` and sampling with
 * `uv = (worldXZ - bounds.xy) / (bounds.zw - bounds.xy)` requires no flip in the shader.
 *
 * Camera setup:
 *   - position: above the world bbox of `object`, looking straight down.
 *   - up: (0, 0, -1)  →  framebuffer +X = world +X, framebuffer +Y = world -Z.
 * After readback we vertically flip the rows so framebuffer +Y becomes data +Y = world +Z again.
 */
function renderSilhouette(
  renderer: THREE.WebGLRenderer,
  object: THREE.Object3D,
  bounds: THREE.Vector4,
  resolution: number,
): Uint8Array {
  const tempScene = new THREE.Scene();
  tempScene.background = new THREE.Color(0x000000);
  const overrideMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  tempScene.overrideMaterial = overrideMat;

  object.updateWorldMatrix(true, true);

  const clone = object.clone(true);
  clone.matrix.copy(object.matrixWorld);
  clone.matrix.decompose(clone.position, clone.quaternion, clone.scale);
  clone.matrixAutoUpdate = false;
  tempScene.add(clone);
  clone.updateMatrixWorld(true);

  const halfW = (bounds.z - bounds.x) * 0.5;
  const halfH = (bounds.w - bounds.y) * 0.5;
  const cx = (bounds.x + bounds.z) * 0.5;
  const cz = (bounds.y + bounds.w) * 0.5;

  const worldBox = new THREE.Box3().setFromObject(clone);
  const top = worldBox.max.y + 10;
  const depth = Math.max(1, top - (worldBox.min.y - 10));

  const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.01, depth);
  cam.up.set(0, 0, -1);
  cam.position.set(cx, top, cz);
  cam.lookAt(cx, top - 1, cz);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);

  const rt = new THREE.WebGLRenderTarget(resolution, resolution, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
    stencilBuffer: false,
  });

  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;

  let flipped: Uint8Array;
  try {
    renderer.autoClear = true;
    renderer.setRenderTarget(rt);
    renderer.clear(true, true, true);
    renderer.render(tempScene, cam);

    const fb = new Uint8Array(resolution * resolution * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, resolution, resolution, fb);

    // GL framebuffer row 0 is the BOTTOM of the image (=> world +Z with our up vector).
    // Flip so data row 0 corresponds to world -Z. Then DataTexture upload + plain UV sampling
    // gives uv.y = (worldZ - minZ) / (maxZ - minZ) with no extra work in the shader.
    flipped = new Uint8Array(resolution * resolution * 4);
    const stride = resolution * 4;
    for (let row = 0; row < resolution; row++) {
      const srcRow = resolution - 1 - row;
      flipped.set(fb.subarray(srcRow * stride, srcRow * stride + stride), row * stride);
    }
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    rt.dispose();
    tempScene.overrideMaterial = null;
    overrideMat.dispose();
    tempScene.remove(clone);
  }

  return flipped;
}

// -----------------------------------------------------------------------------
// 2D Euclidean distance transform (Felzenszwalb & Huttenlocher, 2004)
// -----------------------------------------------------------------------------

const INF = 1e20;

/**
 * Exact 2D EDT.
 *
 * Input: RGBA8 silhouette where R > 127 means "inside land" (seed).
 * Output: per-pixel SQUARED Euclidean distance in pixel units. Caller multiplies sqrt(distSq) by
 * `worldUnitsPerPixel` to get a world-space distance.
 *
 * Two separable 1D passes (columns, then rows). O(W*H) total. ~3ms for 256² on a modern CPU.
 */
function edt2d(mask: Uint8Array, w: number, h: number): Float32Array {
  const grid = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    grid[i] = mask[p] > 127 ? 0 : INF;
  }

  const n = Math.max(w, h);
  const v = new Int32Array(n);
  const z = new Float32Array(n + 1);
  const f = new Float32Array(n);
  const out = new Float32Array(n);

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, v, z, out);
    for (let y = 0; y < h; y++) grid[y * w + x] = out[y];
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, w, v, z, out);
    for (let x = 0; x < w; x++) grid[y * w + x] = out[x];
  }

  return grid;
}

/**
 * 1D distance transform of `f[0..n-1]`. Writes into `out`. Uses caller-provided scratch (`v`, `z`)
 * to avoid per-call allocation in the inner loops.
 */
function edt1d(
  f: Float32Array,
  n: number,
  v: Int32Array,
  z: Float32Array,
  out: Float32Array,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;

  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * (q - v[k]));
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * (q - v[k]));
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const d = q - v[k];
    out[q] = d * d + f[v[k]];
  }
}
