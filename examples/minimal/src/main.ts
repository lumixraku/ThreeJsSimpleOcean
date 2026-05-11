import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  BlitPass,
  createOceanMaterial,
  DepthPrePassTarget,
  loadOceanTextures,
  renderFrame,
} from "ocean-simple";

const waterY = 1.5;
const floorY = -2.0;

const root = document.body;
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
root.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(7.5, 5.2, 9.2);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, waterY, 0);
controls.update();

const opaqueScene = new THREE.Scene();
const waterScene = new THREE.Scene();
opaqueScene.background = new THREE.Color(0x87b6e8);
waterScene.background = null;

const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x3a4a30, 0.85);
const dir = new THREE.DirectionalLight(0xffffff, 1.1);
dir.position.set(-4, 10, 6);
opaqueScene.add(hemi, dir);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200, 1, 1),
  new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.01, 0.05, 0.11),
    roughness: 1,
    metalness: 0,
  }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = floorY;
opaqueScene.add(floor);

const depthPass = new DepthPrePassTarget();
const blitPass = new BlitPass();

const texLoader = new THREE.TextureLoader();
// Intentionally missing URLs → library uses built-in placeholder textures (no assets required).
const textures = await loadOceanTextures(
  texLoader,
  {
    baseColor: "/__ocean_simple_missing__/base.png",
    normal: "/__ocean_simple_missing__/normal.png",
    height: "/__ocean_simple_missing__/height.png",
    foamMask: "/__ocean_simple_missing__/foam.png",
  },
  4,
);

const oceanGeometry = new THREE.PlaneGeometry(120, 120, 240, 240);
oceanGeometry.computeTangents();

const { material, uniforms } = createOceanMaterial(textures, depthPass.depthTexture);
const oceanMesh = new THREE.Mesh(oceanGeometry, material);
oceanMesh.rotation.x = -Math.PI / 2;
oceanMesh.position.y = waterY;
oceanMesh.frustumCulled = false;
waterScene.add(oceanMesh);

const clock = new THREE.Clock();

function onResize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

window.addEventListener("resize", onResize);
onResize();

renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  controls.update();
  uniforms.uTime.value += dt;

  renderFrame({
    renderer,
    camera,
    opaqueScene,
    waterScene,
    oceanMesh,
    oceanUniforms: uniforms,
    depthPass,
    blitPass,
  });
});
