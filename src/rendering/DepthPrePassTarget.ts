import * as THREE from "three";

/**
 * Owns a color+depth render target sized to the drawing buffer, used for opaque pre-pass.
 */
export class DepthPrePassTarget {
  readonly renderTarget: THREE.WebGLRenderTarget;
  readonly depthTexture: THREE.DepthTexture;

  constructor() {
    this.depthTexture = new THREE.DepthTexture(1, 1);
    this.depthTexture.format = THREE.DepthFormat;
    this.depthTexture.type = THREE.UnsignedIntType;

    this.renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      depthBuffer: true,
      depthTexture: this.depthTexture,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
  }

  setSize(width: number, height: number): void {
    this.renderTarget.setSize(width, height);
  }

  dispose(): void {
    this.renderTarget.dispose();
  }
}
