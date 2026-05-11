import * as THREE from "three";

export type OceanTextureBundle = {
  baseColor: THREE.Texture;
  normal: THREE.Texture;
  height: THREE.Texture;
  foamMask: THREE.Texture;
};

const defaultAnisotropy = 8;

function configureTexture(t: THREE.Texture, repeat: number): void {
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = defaultAnisotropy;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.SRGBColorSpace;
}

function configureDataTexture(t: THREE.Texture, repeat: number): void {
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = defaultAnisotropy;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
}

/**
 * Loads ocean maps; on failure falls back to tiny procedural placeholders so the app still runs.
 */
export async function loadOceanTextures(
  loader: THREE.TextureLoader,
  paths: { baseColor: string; normal: string; height: string; foamMask: string },
  tiling: number,
): Promise<OceanTextureBundle> {
  const load = (url: string, onTex: (t: THREE.Texture) => void) =>
    new Promise<THREE.Texture>((resolve, reject) => {
      loader.load(
        url,
        (tex) => {
          onTex(tex);
          resolve(tex);
        },
        undefined,
        () => reject(new Error(`Failed to load ${url}`)),
      );
    });

  try {
    const [baseColor, normal, height, foamMask] = await Promise.all([
      load(paths.baseColor, (t) => configureTexture(t, tiling)),
      load(paths.normal, (t) => {
        configureDataTexture(t, tiling);
        t.colorSpace = THREE.LinearSRGBColorSpace;
      }),
      load(paths.height, (t) => configureDataTexture(t, tiling)),
      load(paths.foamMask, (t) => configureDataTexture(t, 1)),
    ]);
    return { baseColor, normal, height, foamMask };
  } catch (e) {
    console.warn("[Ocean] Texture load failed, using placeholders.", e);
    return makePlaceholderBundle(tiling);
  }
}

function makePlaceholderBundle(tiling: number): OceanTextureBundle {
  const baseColor = makeSolidDataTexture(64, 64, new THREE.Color(0.12, 0.35, 0.55));
  const normal = makeNormalFallback(64, 64);
  const height = makeHeightFallback(64, 64);
  const foamMask = makeSolidDataTexture(8, 8, new THREE.Color(1, 1, 1));
  [baseColor, normal, height, foamMask].forEach((t) => {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(tiling, tiling);
    t.needsUpdate = true;
  });
  baseColor.colorSpace = THREE.SRGBColorSpace;
  normal.colorSpace = THREE.LinearSRGBColorSpace;
  return { baseColor, normal, height, foamMask };
}

function makeSolidDataTexture(w: number, h: number, color: THREE.Color): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4 + 0] = Math.floor(color.r * 255);
    data[i * 4 + 1] = Math.floor(color.g * 255);
    data[i * 4 + 2] = Math.floor(color.b * 255);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

function makeNormalFallback(w: number, h: number): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i + 0] = 128;
      data[i + 1] = 128;
      data[i + 2] = 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

function makeHeightFallback(w: number, h: number): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n =
        Math.sin(x * 0.35) * 0.5 +
        Math.sin(y * 0.28) * 0.5 +
        Math.sin((x + y) * 0.12) * 0.25;
      const v = Math.floor((0.5 + 0.5 * n) * 255);
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}
