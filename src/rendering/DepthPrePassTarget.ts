import * as THREE from "three";

/**
 * Owns a depth render target sized to the drawing buffer (optionally scaled down),
 * used for the cheap opaque depth pre-pass.
 */
export class DepthPrePassTarget {
  readonly renderTarget: THREE.WebGLRenderTarget;
  readonly depthTexture: THREE.DepthTexture;
  /** Actual width of the depth target after the last {@link setSize} call. */
  width = 1;
  /** Actual height of the depth target after the last {@link setSize} call. */
  height = 1;

  constructor() {
    this.depthTexture = new THREE.DepthTexture(1, 1);
    this.depthTexture.format = THREE.DepthFormat;
    this.depthTexture.type = THREE.UnsignedIntType;

    // Depth-only pre-pass: we only sample depthTexture in the water shader.
    this.renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      depthBuffer: true,
      depthTexture: this.depthTexture,
      stencilBuffer: false,
    });
  }

  /**
   * Resize the depth target. `scale` applies to both axes (e.g. 0.5 → half resolution).
   */
  setSize(fullWidth: number, fullHeight: number, scale = 1): void {
    const w = Math.max(1, Math.floor(fullWidth * scale));
    const h = Math.max(1, Math.floor(fullHeight * scale));
    if (w === this.width && h === this.height) return;

    this.width = w;
    this.height = h;
    this.renderTarget.setSize(w, h);
  }

  dispose(): void {
    this.renderTarget.dispose();
  }
}
