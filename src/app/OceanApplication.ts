import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { AssetPaths } from "../config/AssetPaths";
import { loadOceanTextures, type OceanTextureBundle } from "../loading/TextureBundleLoader";
import { createOceanMaterial } from "../ocean/OceanMaterial";
import { BlitPass } from "../rendering/BlitPass";
import { DepthPrePassTarget } from "../rendering/DepthPrePassTarget";
import { renderFrame } from "../rendering/FrameRenderer";
import { loadGrassTile, makeGrassPlaceholder } from "../stage/GrassTileLoader";
import { computeTileBoundsXZ } from "../stage/TileBounds";

/**
 * Scene layout (single source of truth for water level, floor depth, etc.).
 */
const SceneLayout = {
  waterY: 1.5,
  floorY: -2.0,
  floorColor: new THREE.Color(0.01, 0.05, 0.11),
  skyColor: new THREE.Color(0x87b6e8),
};

export class OceanApplication {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly clock = new THREE.Clock();

  private readonly opaqueScene = new THREE.Scene();
  private readonly waterScene = new THREE.Scene();
  private readonly depthPass: DepthPrePassTarget;
  private readonly blitPass: BlitPass;

  private oceanMesh!: THREE.Mesh;
  private oceanUniforms!: ReturnType<typeof createOceanMaterial>["uniforms"];
  private oceanTextures: OceanTextureBundle | null = null;
  private grassDispose: (() => void) | null = null;

  constructor(private readonly mount: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(mount.clientWidth, mount.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    mount.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, mount.clientWidth / mount.clientHeight, 0.1, 200);
    this.camera.position.set(7.5, 5.2, 9.2);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, SceneLayout.waterY, 0);
    this.controls.update();

    this.depthPass = new DepthPrePassTarget();
    this.blitPass = new BlitPass();

    this.opaqueScene.background = SceneLayout.skyColor;
    this.waterScene.background = null;

    const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x3a4a30, 0.85);
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(-4, 10, 6);
    this.opaqueScene.add(hemi, dir);

    window.addEventListener("resize", this.onResize);
  }

  async init(): Promise<void> {
    const texLoader = new THREE.TextureLoader();
    this.oceanTextures = await loadOceanTextures(texLoader, AssetPaths.ocean, 4);

    const grass = await this.tryLoadGrass();
    this.grassDispose = grass.dispose;
    this.opaqueScene.add(grass.root);

    const floor = this.buildOceanFloor();
    this.opaqueScene.add(floor);

    const oceanGeometry = new THREE.PlaneGeometry(120, 120, 240, 240);
    oceanGeometry.computeTangents();

    const { material, uniforms } = createOceanMaterial(this.oceanTextures, this.depthPass.depthTexture);
    this.oceanUniforms = uniforms;

    // Tell the water shader the XZ footprint of the island so foam can wrap around its edge
    // in world space (view-angle independent).
    const islandBounds = computeTileBoundsXZ(grass.root, 0);
    this.oceanUniforms.uIslandBounds.value.copy(islandBounds);

    this.oceanMesh = new THREE.Mesh(oceanGeometry, material);
    this.oceanMesh.rotation.x = -Math.PI / 2;
    this.oceanMesh.position.y = SceneLayout.waterY;
    this.oceanMesh.frustumCulled = false;
    this.waterScene.add(this.oceanMesh);

    this.onResize();
    this.renderer.setAnimationLoop(this.tick);
  }

  private buildOceanFloor(): THREE.Mesh {
    const mat = new THREE.MeshStandardMaterial({
      color: SceneLayout.floorColor,
      roughness: 1.0,
      metalness: 0.0,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200, 1, 1), mat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = SceneLayout.floorY;
    return floor;
  }

  private async tryLoadGrass(): Promise<{ root: THREE.Object3D; dispose: () => void }> {
    try {
      return await loadGrassTile(AssetPaths.grass.model, {
        baseColorUrl: AssetPaths.grass.baseColor,
        normalUrl: AssetPaths.grass.normal,
      });
    } catch (e) {
      console.warn("[Grass] FBX load failed, using placeholder box.", e);
      return makeGrassPlaceholder();
    }
  }

  private readonly tick = (): void => {
    const dt = this.clock.getDelta();
    this.controls.update();
    this.oceanUniforms.uTime.value += dt;

    renderFrame({
      renderer: this.renderer,
      camera: this.camera,
      opaqueScene: this.opaqueScene,
      waterScene: this.waterScene,
      oceanMesh: this.oceanMesh,
      oceanUniforms: this.oceanUniforms,
      depthPass: this.depthPass,
      blitPass: this.blitPass,
    });
  };

  private readonly onResize = (): void => {
    const w = this.mount.clientWidth;
    const h = this.mount.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    this.renderer.setAnimationLoop(null);
    this.controls.dispose();
    this.depthPass.dispose();
    this.blitPass.dispose();
    this.grassDispose?.();

    if (this.oceanMesh) {
      this.oceanMesh.geometry.dispose();
      (this.oceanMesh.material as THREE.Material).dispose();
    }
    this.oceanTextures?.baseColor.dispose();
    this.oceanTextures?.normal.dispose();
    this.oceanTextures?.height.dispose();

    this.renderer.dispose();
    this.mount.removeChild(this.renderer.domElement);
  }
}
