import * as THREE from "three";

const TONEMAP_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Exposure + ACES filmic + sRGB OETF — the same math three.js applies to tone-mapped materials
// on the canvas, so the reflection matches the main pipeline's look.
const TONEMAP_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform float uExposure;
varying vec2 vUv;

vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 acesFilmic(vec3 color) {
  const mat3 ACESInputMat = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777)
  );
  const mat3 ACESOutputMat = mat3(
    vec3(1.60475, -0.10208, -0.00327),
    vec3(-0.53108, 1.10813, -0.07276),
    vec3(-0.07367, -0.00605, 1.07602)
  );
  color *= uExposure / 0.6;
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}

vec3 sRGBOETF(vec3 v) {
  return mix(
    pow(v, vec3(0.41666)) * 1.055 - 0.055,
    v * 12.92,
    vec3(lessThanEqual(v, vec3(0.0031308)))
  );
}

void main() {
  vec3 hdr = texture2D(uMap, vUv).rgb;
  gl_FragColor = vec4(sRGBOETF(acesFilmic(hdr)), 1.0);
}
`;

/**
 * True planar reflection for a horizontal water plane at `waterY`.
 *
 * Replaces the previous screen-space mirror of the post-composer frame: that approach only had
 * data for whatever happened to be on screen above the horizon, so raising the camera shrank
 * the usable mirror strip until every reflection vanished. Here the scene is actually rendered
 * from a camera mirrored across the plane, so any camera angle gets a complete reflection.
 *
 * Pipeline per frame (mirrors the main pipeline's tone handling):
 *   1. scene (default layer: sky/island/mountains/posts) → HDR target, NO tone mapping
 *      (SkyMaterial is `toneMapped: false`, so everything must stay linear here)
 *   2. tonemap blit (exposure + ACES + sRGB) → `texture`
 *   3. cloud layer overlaid on `texture` — the painterly clouds output display-referred
 *      colors and are drawn after tone mapping, exactly like the main canvas pass
 *
 * The mirrored projection gets the standard oblique near-plane clip so underwater geometry
 * (sea floor, submerged beach) never leaks into the reflection.
 */
export class PlanarReflection {
  readonly mirrorCamera = new THREE.PerspectiveCamera();
  /** world → reflection-UV (projective). Bind to the ocean shader's `uMirrorMatrix`. */
  readonly textureMatrix = new THREE.Matrix4();

  private readonly waterY: number;
  private readonly rtHDR: THREE.WebGLRenderTarget;
  private readonly rtFinal: THREE.WebGLRenderTarget;
  private width = 1;
  private height = 1;

  private readonly blitScene = new THREE.Scene();
  private readonly blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly blitMaterial: THREE.RawShaderMaterial;
  private readonly blitMesh: THREE.Mesh;

  constructor(waterY: number) {
    this.waterY = waterY;

    this.rtHDR = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.rtFinal = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });

    this.blitMaterial = new THREE.RawShaderMaterial({
      vertexShader: TONEMAP_VERT,
      fragmentShader: TONEMAP_FRAG,
      uniforms: {
        uMap: { value: this.rtHDR.texture },
        uExposure: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.blitMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blitMaterial);
    this.blitScene.add(this.blitMesh);
  }

  /** The display-referred reflection texture the ocean shader samples. */
  get texture(): THREE.Texture {
    return this.rtFinal.texture;
  }

  setSize(fullWidth: number, fullHeight: number, scale = 0.5): void {
    const w = Math.max(1, Math.floor(fullWidth * scale));
    const h = Math.max(1, Math.floor(fullHeight * scale));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.rtHDR.setSize(w, h);
    this.rtFinal.setSize(w, h);
  }

  /** Mirror `camera` across the water plane and rebuild the oblique projection + UV matrix. */
  private update(camera: THREE.PerspectiveCamera): void {
    const normal = _normal.set(0, 1, 0);
    const mirrorPos = _mirrorPos.set(0, this.waterY, 0);
    const camPos = _camPos.setFromMatrixPosition(camera.matrixWorld);

    // Mirrored camera position.
    const view = _view.subVectors(mirrorPos, camPos);
    view.reflect(normal).negate();
    view.add(mirrorPos);

    // Mirrored look target + up vector.
    const rotation = _rotation.extractRotation(camera.matrixWorld);
    const lookAt = _lookAt.set(0, 0, -1).applyMatrix4(rotation).add(camPos);
    const target = _target.subVectors(mirrorPos, lookAt);
    target.reflect(normal).negate();
    target.add(mirrorPos);

    const cam = this.mirrorCamera;
    cam.position.copy(view);
    cam.up.set(0, 1, 0).applyMatrix4(rotation).reflect(normal);
    cam.lookAt(target);
    cam.far = camera.far;
    cam.updateMatrixWorld();
    cam.projectionMatrix.copy(camera.projectionMatrix);

    // world → [0,1]² reflection UV.
    // prettier-ignore
    this.textureMatrix.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0,
    );
    this.textureMatrix.multiply(cam.projectionMatrix);
    this.textureMatrix.multiply(cam.matrixWorldInverse);

    // Oblique near-plane clip at the water surface (Lengyel, as in THREE.Reflector): nothing
    // below the plane may appear in the mirror image.
    const reflectorPlane = _plane.setFromNormalAndCoplanarPoint(normal, mirrorPos);
    reflectorPlane.applyMatrix4(cam.matrixWorldInverse);
    const clipPlane = _clip.set(
      reflectorPlane.normal.x,
      reflectorPlane.normal.y,
      reflectorPlane.normal.z,
      reflectorPlane.constant,
    );
    const projection = cam.projectionMatrix;
    const q = _q;
    q.x = (Math.sign(clipPlane.x) + projection.elements[8]) / projection.elements[0];
    q.y = (Math.sign(clipPlane.y) + projection.elements[9]) / projection.elements[5];
    q.z = -1.0;
    q.w = (1.0 + projection.elements[10]) / projection.elements[14];
    clipPlane.multiplyScalar(2.0 / clipPlane.dot(q));
    projection.elements[2] = clipPlane.x;
    projection.elements[6] = clipPlane.y;
    projection.elements[10] = clipPlane.z + 1.0;
    projection.elements[14] = clipPlane.w;
  }

  /**
   * Render the reflection. `cloudLayer` is drawn as a display-referred overlay after tone
   * mapping; the camera's default layer-0 content forms the HDR base pass.
   */
  render(
    gl: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    cloudLayer: number,
  ): void {
    this.update(camera);

    const prevRT = gl.getRenderTarget();
    const prevToneMapping = gl.toneMapping;
    const prevAutoClear = gl.autoClear;

    try {
      // 1. Linear HDR base pass.
      this.mirrorCamera.layers.set(0);
      gl.toneMapping = THREE.NoToneMapping;
      gl.autoClear = true;
      gl.setRenderTarget(this.rtHDR);
      gl.render(scene, this.mirrorCamera);

      // 2. Tone map into the final (display-referred) target.
      this.blitMaterial.uniforms.uExposure.value = gl.toneMappingExposure;
      gl.setRenderTarget(this.rtFinal);
      gl.render(this.blitScene, this.blitCamera);

      // 3. Painterly clouds on top (their colors are already display-referred).
      this.mirrorCamera.layers.set(cloudLayer);
      gl.autoClear = false;
      gl.render(scene, this.mirrorCamera);
    } finally {
      gl.setRenderTarget(prevRT);
      gl.toneMapping = prevToneMapping;
      gl.autoClear = prevAutoClear;
    }
  }

  dispose(): void {
    this.rtHDR.dispose();
    this.rtFinal.dispose();
    this.blitMaterial.dispose();
    this.blitMesh.geometry.dispose();
  }
}

const _normal = new THREE.Vector3();
const _mirrorPos = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _view = new THREE.Vector3();
const _rotation = new THREE.Matrix4();
const _lookAt = new THREE.Vector3();
const _target = new THREE.Vector3();
const _plane = new THREE.Plane();
const _clip = new THREE.Vector4();
const _q = new THREE.Vector4();
