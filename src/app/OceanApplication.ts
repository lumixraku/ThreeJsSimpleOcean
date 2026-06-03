import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { AssetPaths } from "../config/AssetPaths";
import { loadOceanTextures, type OceanTextureBundle } from "../loading/TextureBundleLoader";
import { createOceanMaterial, setOceanShoreSdf } from "../ocean/OceanMaterial";
import { buildShoreSdf, type ShoreSdf } from "../ocean/ShoreSdf";
import { AdaptiveDepthScale } from "../rendering/AdaptiveDepthScale";
import { DepthPrePassTarget } from "../rendering/DepthPrePassTarget";
import { tagOceanDepthCasters } from "../rendering/OceanDepthLayers";
import { renderFrame } from "../rendering/FrameRenderer";
import { createSky, SKY_LAYER, type SkySystem } from "../sky/SkySystem";
import { SunController } from "../sky/SunController";
import { loadGrassTile, makeGrassPlaceholder } from "../stage/GrassTileLoader";
import { computeTileBoundsXZ } from "../stage/TileBounds";

/**
 * Scene layout (single source of truth for water level, floor depth, etc.).
 */
const SceneLayout = {
  waterY: 1.5,
  floorY: -2.0,
  floorColor: new THREE.Color(0.01, 0.05, 0.11),
};

export class OceanApplication {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly clock = new THREE.Clock();

  private readonly opaqueScene = new THREE.Scene();
  private readonly waterScene = new THREE.Scene();
  private readonly depthPass: DepthPrePassTarget;
  private readonly adaptiveDepthScale = new AdaptiveDepthScale();

  private oceanMesh!: THREE.Mesh;
  private oceanUniforms!: ReturnType<typeof createOceanMaterial>["uniforms"];
  private oceanTextures: OceanTextureBundle | null = null;
  private grassDispose: (() => void) | null = null;
  private shoreSdf: ShoreSdf | null = null;
  private sky!: SkySystem;
  private sunController!: SunController;
  private hemiLight!: THREE.HemisphereLight;
  private dirLight!: THREE.DirectionalLight;
  private controlPanel: HTMLElement | null = null;

  constructor(private readonly mount: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(mount.clientWidth, mount.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    mount.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, mount.clientWidth / mount.clientHeight, 0.1, 2000);
    // Default pose: open water in front, sun ahead, island mid-frame — matches the reference shot.
    this.camera.position.set(-12, 5.5, -13);
    // Allow the camera to see the procedural sky (rendered on its own layer).
    this.camera.layers.enable(SKY_LAYER);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, SceneLayout.waterY, 0);
    // Keep the camera above the water plane: cap the orbit polar angle so it can't dip below the
    // horizon relative to the target, and disable panning so the user can't drag the target underwater.
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 80;
    this.controls.enablePan = false;
    this.controls.update();

    this.depthPass = new DepthPrePassTarget();

    // Sky mesh paints the full background; clear color is just a fallback for any uncovered pixels.
    this.opaqueScene.background = null;
    this.renderer.setClearColor(0x000000, 1);
    this.waterScene.background = null;

    this.hemiLight = new THREE.HemisphereLight(0xcfe8ff, 0x3a4a30, 0.6);
    this.dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
    this.dirLight.position.set(-4, 10, 6);
    this.opaqueScene.add(this.hemiLight, this.dirLight);

    window.addEventListener("resize", this.onResize);
  }

  async init(): Promise<void> {
    const texLoader = new THREE.TextureLoader();
    this.oceanTextures = await loadOceanTextures(texLoader, AssetPaths.ocean, 4);

    // Load one grass tile, then clone-place it into an irregular layout. This is what makes the
    // demo a useful reference for the shore SDF: an AABB would draw a rectangular foam band around
    // this L-shape, while the SDF wraps the actual coastline of every tile.
    const grass = await this.tryLoadGrass();
    this.grassDispose = grass.dispose;
    const islandRoot = this.buildIslandLayout(grass.root);
    this.opaqueScene.add(islandRoot);
    tagOceanDepthCasters(islandRoot);

    const floor = this.buildOceanFloor();
    this.opaqueScene.add(floor);
    tagOceanDepthCasters(floor);

    const oceanGeometry = new THREE.PlaneGeometry(120, 120, 128, 128);
    oceanGeometry.computeTangents();

    const { material, uniforms } = createOceanMaterial(this.oceanTextures, this.depthPass.depthTexture);
    this.oceanUniforms = uniforms;

    // AABB fallback for the foam shader. Used when no shore SDF is bound.
    const islandBounds = computeTileBoundsXZ(islandRoot, 0);
    this.oceanUniforms.uIslandBounds.value.copy(islandBounds);

    // Bake a top-down shore distance field so the outer foam hugs the actual coastline of the
    // grass mesh (cliff edges, gaps, corners) instead of a single rectangular bounding box.
    this.shoreSdf = buildShoreSdf(this.renderer, {
      object: islandRoot,
      padding: 8,
    });
    setOceanShoreSdf(this.oceanUniforms, this.shoreSdf);

    this.oceanMesh = new THREE.Mesh(oceanGeometry, material);
    this.oceanMesh.rotation.x = -Math.PI / 2;
    this.oceanMesh.position.y = SceneLayout.waterY;
    this.oceanMesh.frustumCulled = false;
    this.waterScene.add(this.oceanMesh);

    // === Sky + sun =========================================================
    this.sky = createSky();
    this.opaqueScene.add(this.sky.mesh);

    this.sunController = new SunController({ hour: 17.5 });
    this.sunController.bindSky(this.sky.uniforms);
    this.sunController.bindOceanLight(this.oceanUniforms.uLightDirWorld);
    // Push the sun color into the ocean too so specular highlights match the sky tint.
    this.sunController.subscribe((_dir, color) => {
      this.oceanUniforms.uSunColor.value.copy(color);
    });
    // Also drive the scene's directional light so opaque geometry (island, floor) catches sunset light.
    this.sunController.subscribe(() => this.syncDirectionalLight());

    this.buildControlPanel();

    this.onResize();
    this.renderer.setAnimationLoop(this.tick);
  }

  /**
   * Place the loaded grass tile (and clones of it) into an irregular L-shape so the demo exercises
   * the shore SDF.
   */
  private buildIslandLayout(template: THREE.Object3D): THREE.Object3D {
    const TILE = 4;
    const offsets: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [0, 1],
      [0, 2],
      [1, 2],
    ];

    const group = new THREE.Group();
    for (let i = 0; i < offsets.length; i++) {
      const [tx, tz] = offsets[i];
      const node = i === 0 ? template : template.clone(true);
      const placement = new THREE.Group();
      placement.position.set(tx * TILE, 0, tz * TILE);
      placement.add(node);
      group.add(placement);
    }

    const box = new THREE.Box3().setFromObject(group);
    group.position.set(-(box.min.x + box.max.x) * 0.5, 0, -(box.min.z + box.max.z) * 0.5);
    return group;
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

  /** Push the sun direction + warm color into the scene's directional light so opaque shading matches the sky. */
  private syncDirectionalLight(): void {
    const dir = this.sunController.direction;
    // DirectionalLight.position is the point the light streams *from*, so use the sun direction directly.
    this.dirLight.position.copy(dir).multiplyScalar(50);
    this.dirLight.color.copy(this.sky.uniforms.uSunColor.value);
    // Drop the light's brightness as the sun nears (and crosses) the horizon — at night the
    // hemisphere light alone provides a tiny ambient so the scene isn't pitch black.
    const el = this.sunController.elevationDeg;
    const day = THREE.MathUtils.clamp(el / 25, 0, 1);
    const night = THREE.MathUtils.clamp(-el / 6, 0, 1);
    this.dirLight.intensity = (0.35 + 0.95 * day) * (1.0 - night);
    this.hemiLight.intensity = 0.05 + (0.2 + 0.55 * day) * (1.0 - night * 0.7);
    this.hemiLight.color.copy(this.sky.uniforms.uZenithColor.value);
    this.hemiLight.groundColor.copy(this.sky.uniforms.uGroundColor.value);
  }

  // === Control panel =======================================================

  private buildControlPanel(): void {
    const panel = document.createElement("div");
    panel.className = "ocean-demo-panel";
    panel.style.cssText = [
      "position:fixed",
      "top:12px",
      "right:12px",
      "background:rgba(10,18,30,0.72)",
      "color:#e8f1ff",
      "font:12px/1.4 ui-monospace,Menlo,monospace",
      "padding:10px 12px",
      "border-radius:8px",
      "z-index:10",
      "backdrop-filter:blur(8px)",
      "-webkit-backdrop-filter:blur(8px)",
      "min-width:260px",
      "box-shadow:0 6px 24px rgba(0,0,0,0.35)",
    ].join(";");

    const heading = (text: string) => {
      const el = document.createElement("div");
      el.textContent = text;
      el.style.cssText = "font-weight:600;margin:6px 0 4px;letter-spacing:0.04em;opacity:0.85;";
      panel.appendChild(el);
    };

    const slider = (
      label: string,
      min: number,
      max: number,
      step: number,
      init: number,
      onChange: (v: number) => void,
      formatter: (v: number) => string = (v) => v.toFixed(2),
    ) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:8px;margin:3px 0;";
      const lbl = document.createElement("label");
      lbl.style.cssText = "flex:0 0 92px;opacity:0.8;";
      lbl.textContent = label;
      const inp = document.createElement("input");
      inp.type = "range";
      inp.min = String(min);
      inp.max = String(max);
      inp.step = String(step);
      inp.value = String(init);
      inp.style.cssText = "flex:1;accent-color:#7dc4ff;";
      const val = document.createElement("span");
      val.style.cssText = "flex:0 0 46px;text-align:right;opacity:0.7;";
      val.textContent = formatter(init);
      inp.addEventListener("input", () => {
        const v = parseFloat(inp.value);
        val.textContent = formatter(v);
        onChange(v);
      });
      row.append(lbl, inp, val);
      panel.appendChild(row);
    };

    const title = document.createElement("div");
    title.textContent = "Sun & Volumetric Clouds";
    title.style.cssText = "font-weight:700;margin-bottom:6px;font-size:13px;";
    panel.appendChild(title);

    heading("Time of day");
    // Hours and minutes feed the same `setHour(h + m/60)`. Cache the current value of the partner
    // slider in closures so dragging one doesn't reset the other.
    let curH = Math.floor(this.sunController.hour);
    let curM = Math.floor((this.sunController.hour - curH) * 60);
    const pushClock = () => this.sunController.setHour(curH + curM / 60);
    slider(
      "hour",
      0,
      23,
      1,
      curH,
      (v) => {
        curH = Math.floor(v);
        pushClock();
      },
      (v) => String(Math.floor(v)).padStart(2, "0"),
    );
    slider(
      "minute",
      0,
      59,
      1,
      curM,
      (v) => {
        curM = Math.floor(v);
        pushClock();
      },
      (v) => String(Math.floor(v)).padStart(2, "0"),
    );

    const u = this.sky.uniforms;
    heading("Clouds");
    slider("coverage", 0, 1, 0.01, u.uCloudCoverage.value, (v) => (u.uCloudCoverage.value = v));
    slider("density", 0, 3, 0.05, u.uCloudDensity.value, (v) => (u.uCloudDensity.value = v));
    slider("height", 20, 200, 1, u.uCloudHeight.value, (v) => (u.uCloudHeight.value = v));
    slider("thickness", 2, 80, 0.5, u.uCloudThickness.value, (v) => (u.uCloudThickness.value = v));
    slider("scale", 4, 80, 0.5, u.uCloudScale.value, (v) => (u.uCloudScale.value = v));
    slider("speed", 0, 10, 0.1, u.uCloudSpeed.value, (v) => (u.uCloudSpeed.value = v));

    document.body.appendChild(panel);
    this.controlPanel = panel;
  }

  // === Frame loop ==========================================================

  /** Minimum Y for the camera so the eye never sits at or below the water surface. */
  private static readonly CAMERA_MIN_Y = SceneLayout.waterY + 0.6;

  private readonly tick = (): void => {
    const dt = this.clock.getDelta();
    this.controls.update();
    // Belt-and-braces: even with polar-angle clamping, a sufficiently low target + tilt could still
    // dip the camera below the water. Lift it back up if so.
    if (this.camera.position.y < OceanApplication.CAMERA_MIN_Y) {
      this.camera.position.y = OceanApplication.CAMERA_MIN_Y;
      this.controls.update();
    }
    this.oceanUniforms.uTime.value += dt;
    this.sky.update(this.camera, dt);

    renderFrame({
      renderer: this.renderer,
      camera: this.camera,
      opaqueScene: this.opaqueScene,
      waterScene: this.waterScene,
      oceanMesh: this.oceanMesh,
      oceanUniforms: this.oceanUniforms,
      depthPass: this.depthPass,
      options: {
        adaptiveDepthScale: this.adaptiveDepthScale,
        frameDeltaMs: dt * 1000,
      },
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
    this.shoreSdf?.dispose();
    this.grassDispose?.();
    this.sky?.dispose();
    this.controlPanel?.remove();

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
