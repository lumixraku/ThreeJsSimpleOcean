import * as THREE from "three";

/**
 * Full-screen blit of a render target's color to the default framebuffer.
 */
export class BlitPass {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.MeshBasicMaterial;
  private readonly mesh: THREE.Mesh;

  constructor() {
    this.material = new THREE.MeshBasicMaterial({
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.scene.add(this.mesh);
  }

  setMap(map: THREE.Texture | null): void {
    this.material.map = map;
    this.material.needsUpdate = true;
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
