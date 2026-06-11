import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { EffectComposer, ToneMapping } from "@react-three/postprocessing";
import {
  AerialPerspective,
  Atmosphere,
  Sky,
  SkyLight,
  SunLight,
  type AtmosphereApi,
} from "@takram/three-atmosphere/r3f";
import { Ellipsoid, Geodetic, radians } from "@takram/three-geospatial";
import { ToneMappingMode } from "postprocessing";
import * as THREE from "three";

import { AssetPaths } from "./config/AssetPaths";
import {
  loadOceanTextures,
  type OceanTextureBundle,
} from "./loading/TextureBundleLoader";
import {
  bindOceanMatrices,
  createOceanMaterial,
  setOceanReflectionMap,
  setOceanShoreSdf,
  type OceanMaterialUniforms,
} from "./ocean/OceanMaterial";
import { buildShoreSdf, type ShoreSdf } from "./ocean/ShoreSdf";
import { DepthPrePassTarget } from "./rendering/DepthPrePassTarget";
import { PlanarReflection } from "./rendering/PlanarReflection";
import { getDepthPrePassMaterial } from "./rendering/DepthPrePassMaterial";
import {
  OCEAN_DEPTH_CASTER_LAYER,
  tagOceanDepthCasters,
} from "./rendering/OceanDepthLayers";
import { computeTileBoundsXZ } from "./stage/TileBounds";
import { buildSandBeach, type SandBeach } from "./stage/SandBeach";
import { buildMountainRing } from "./stage/MountainRing";
import { buildPainterlyClouds } from "./stage/PainterlyClouds";

const WATER_Y = 1.5;
const FLOOR_Y = -2.0;
const FLOOR_COLOR = new THREE.Color(0.01, 0.05, 0.11);
const CAMERA_MIN_Y = WATER_Y + 0.6;

const SUN_DAY = new THREE.Color(1.0, 0.96, 0.88);
const SUN_NIGHT = new THREE.Color(0.06, 0.07, 0.1);
const OCEAN_RENDER_LAYER = 2;
const CLOUD_RENDER_LAYER = 3;

// Anchor the scene origin onto the WGS84 ellipsoid so the atmosphere/sun math has a real frame.
const SCENE_LONGITUDE = 0;
const SCENE_LATITUDE = 30;
const SCENE_HEIGHT_M = 10;
// Low-angle morning sun: at lat 30 / lon 0 on June 1, 05:30Z puts the sun at azimuth ~75°
// (ENE) and altitude ~12° — above the ~5° mountain horizon, in front of the default camera
// (which looks at azimuth ~47°, NE). The sun disc renders inside the FOV and the atmosphere
// shader still warms everything (warm low-sun lerp in OceanLayer's uSunColor).
const SCENE_DATE = new Date("2025-06-01T05:30:00Z");

function useOceanTextures(): OceanTextureBundle | null {
  const [textures, setTextures] = useState<OceanTextureBundle | null>(null);
  useEffect(() => {
    let alive = true;
    let loaded: OceanTextureBundle | null = null;
    (async () => {
      const texLoader = new THREE.TextureLoader();
      const bundle = await loadOceanTextures(texLoader, AssetPaths.ocean, 4);
      loaded = bundle;
      if (alive) setTextures(bundle);
      else {
        bundle.baseColor.dispose();
        bundle.normal.dispose();
        bundle.height.dispose();
        bundle.foamMask?.dispose();
      }
    })();
    return () => {
      alive = false;
      // StrictMode re-runs the effect; dispose what was already set.
      if (loaded) {
        loaded.baseColor.dispose();
        loaded.normal.dispose();
        loaded.height.dispose();
        loaded.foamMask?.dispose();
      }
    };
  }, []);
  return textures;
}

function OceanLayer({
  textures,
  islandRoot,
  atmosphereRef,
}: {
  textures: OceanTextureBundle;
  islandRoot: THREE.Object3D;
  atmosphereRef: React.RefObject<AtmosphereApi | null>;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const { scene, gl } = useThree();

  const depthPass = useMemo(() => new DepthPrePassTarget(), []);
  const geometry = useMemo(() => {
    // Big enough to cover the camera's horizon at ~15m altitude (~14 km on WGS84).
    // Coarse tessellation far out is fine — the shader's surface detail comes from tiling textures.
    const g = new THREE.PlaneGeometry(20000, 20000, 256, 256);
    return g;
  }, []);

  const { material, uniforms } = useMemo(() => {
    const r = createOceanMaterial(textures, depthPass.depthTexture, {
      surfaceBrightness: 0.7,
      displacement: 0.45,
      heightScroll: new THREE.Vector2(0.00024, 0.00016),
      albedoScroll: new THREE.Vector2(0.0012, 0.0008),
      normalScroll: new THREE.Vector2(-0.0007, 0.0011),
      specStrength: 0.3,
      fresnelStrength: 1.4,
      shallowAlpha: 0.15,
      absorption: 1.0,
      // Beefier surf line at the sand edge. The default 0.1m inner ring is invisible at this
      // scene's camera distance; ~1.2m + wider outer patches reads as a proper breaking wave.
      foamBaseRingWidth: 1.2,
      foamWidth: 1.8,
      foamStrength: 1.0,
      foamMaskThreshold: 0.25,
    });
    r.uniforms.uIslandBounds.value.copy(computeTileBoundsXZ(islandRoot, 0));
    return r;
  }, [textures, depthPass, islandRoot]);

  const shoreSdf = useMemo<ShoreSdf>(
    () => buildShoreSdf(gl, { object: islandRoot, padding: 8 }),
    [gl, islandRoot],
  );

  useEffect(() => {
    setOceanShoreSdf(uniforms, shoreSdf);
    return () => setOceanShoreSdf(uniforms, null);
  }, [uniforms, shoreSdf]);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.layers.set(OCEAN_RENDER_LAYER);
  }, []);

  // True planar reflection: the scene rendered each frame from a camera mirrored across the
  // water plane (HDR pass → ACES tonemap → cloud overlay, see PlanarReflection). Valid at any
  // camera angle — the previous screen-space mirror ran out of data as soon as the camera rose.
  const planarReflection = useMemo(() => new PlanarReflection(WATER_Y), []);

  useEffect(() => {
    setOceanReflectionMap(uniforms, planarReflection.texture);
    return () => setOceanReflectionMap(uniforms, null);
  }, [uniforms, planarReflection]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
      depthPass.dispose();
      shoreSdf.dispose();
      planarReflection.dispose();
    },
    [geometry, material, depthPass, shoreSdf, planarReflection],
  );

  const tmpSize = useMemo(() => new THREE.Vector2(), []);

  // Priority 2 runs AFTER the EffectComposer (priority 1): render the reflection, overlay the
  // cloud band on the canvas, then draw the ocean on top.
  useFrame((state) => {
    state.gl.getDrawingBufferSize(tmpSize);
    planarReflection.setSize(tmpSize.x, tmpSize.y, 0.5);

    const cam = state.camera as THREE.PerspectiveCamera;
    const prevLayers = cam.layers.mask;
    const prevAutoClear = state.gl.autoClear;

    planarReflection.render(state.gl, scene, cam, CLOUD_RENDER_LAYER);
    uniforms.uMirrorMatrix.value.copy(planarReflection.textureMatrix);

    // Paint the cloud band over the composer output. Drawing it here (after AerialPerspective
    // and tone mapping) keeps the painted colors literal — the atmosphere's inscatter would
    // otherwise wash them out to white haze.
    cam.layers.set(CLOUD_RENDER_LAYER);
    state.gl.autoClear = false;
    state.gl.render(scene, cam);

    // Render just the ocean layer on top of the canvas backbuffer.
    cam.layers.set(OCEAN_RENDER_LAYER);
    try {
      state.gl.render(scene, cam);
    } finally {
      cam.layers.mask = prevLayers;
      state.gl.autoClear = prevAutoClear;
    }
  }, 2);

  // Depth pre-pass + per-frame uniform sync. Priority -1 runs before the EffectComposer
  // (which registers itself at priority 1), so we own the depth target before the main render.
  useFrame((state, dt) => {
    const mesh = meshRef.current;
    if (mesh == null) return;
    const cam = state.camera as THREE.PerspectiveCamera;

    // Camera-above-water guard (the OrbitControls polar clamp may still allow it through).
    if (cam.position.y < CAMERA_MIN_Y) cam.position.y = CAMERA_MIN_Y;

    uniforms.uTime.value += dt;
    gl.getDrawingBufferSize(tmpSize);
    uniforms.uResolution.value.set(tmpSize.x, tmpSize.y);
    depthPass.setSize(tmpSize.x, tmpSize.y, 0.5);

    const prevRT = gl.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevLayers = cam.layers.mask;
    const prevShadowAuto = gl.shadowMap.autoUpdate;
    const prevShadowEnabled = gl.shadowMap.enabled;

    gl.setRenderTarget(depthPass.renderTarget);
    gl.clear(false, true, false);
    scene.overrideMaterial = getDepthPrePassMaterial();
    cam.layers.set(OCEAN_DEPTH_CASTER_LAYER);
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.enabled = false;

    try {
      gl.render(scene, cam);
    } finally {
      scene.overrideMaterial = prevOverride;
      cam.layers.mask = prevLayers;
      gl.shadowMap.autoUpdate = prevShadowAuto;
      gl.shadowMap.enabled = prevShadowEnabled;
      gl.setRenderTarget(prevRT);
    }

    bindOceanMatrices(uniforms, mesh, cam);

    // Sync sun direction + a sun-elevation-driven color from atmosphere so the ocean's specular,
    // fresnel and warm-tint paths match the sky. Without this, uSunColor stays white and the
    // fresnel/specular code paths blow out at low viewing angles.
    const atm = atmosphereRef.current;
    const sunDir = (atm as { sunDirection?: THREE.Vector3 } | null)?.sunDirection;
    if (sunDir) {
      uniforms.uLightDirWorld.value.copy(sunDir);
      const day = THREE.MathUtils.clamp(sunDir.y * 4, 0, 1);
      const night = THREE.MathUtils.clamp(-sunDir.y * 4, 0, 1);
      uniforms.uSunColor.value
        .setRGB(1.0, 0.5, 0.22) // warm low-sun
        .lerp(SUN_DAY, day)
        .lerp(SUN_NIGHT, night);
    }
  }, -1);

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, WATER_Y, 0]}
      frustumCulled={false}
      renderOrder={10}
    />
  );
}

function DepthCasterTag({ object }: { object: THREE.Object3D }) {
  useEffect(() => {
    tagOceanDepthCasters(object);
  }, [object]);
  return <primitive object={object} />;
}

function MountainHorizon() {
  // Two layered ridges over the SAME ~50° arc behind the island (relative to the default
  // camera). Near ridge shorter/closer, far ridge taller/farther. AerialPerspective tints them
  // toward sky color, producing the dark-navy distant silhouette read. The ocean's SSR picks
  // them up because they live on the default layer (no special tagging needed).
  const arcCenter = Math.PI / 4;
  const arcWidth = (50 * Math.PI) / 180;
  const rings = useMemo(
    () => [
      buildMountainRing({
        radius: 3500,
        baseY: -30,
        minHeight: 40,
        maxHeight: 220,
        segments: 512,
        color: new THREE.Color(0.18, 0.16, 0.14),
        seed: 53,
        arcCenter,
        arcWidth,
        endFade: 0.18,
      }),
      buildMountainRing({
        radius: 5200,
        baseY: -40,
        minHeight: 120,
        maxHeight: 460,
        segments: 512,
        color: new THREE.Color(0.13, 0.12, 0.12),
        seed: 17,
        arcCenter,
        arcWidth,
        endFade: 0.18,
      }),
    ],
    [arcCenter, arcWidth],
  );
  useEffect(
    () => () => {
      for (const r of rings) r.dispose();
    },
    [rings],
  );
  return (
    <group position={[0, WATER_Y, 0]}>
      {rings.map((r, i) => (
        <primitive key={i} object={r.mesh} />
      ))}
    </group>
  );
}

function PainterlyCloudRing({
  atmosphereRef,
}: {
  atmosphereRef: React.RefObject<AtmosphereApi | null>;
}) {
  const built = useMemo(
    () =>
      buildPainterlyClouds({
        // Band bottom sits above the mountain silhouette as seen from the camera (~4.6° at
        // 5.2 km): the cloud pass has no depth buffer on the canvas, so the mountains can't
        // occlude it — the band must simply start higher than they reach.
        radius: 9000,
        baseY: 800,
        height: 4200,
        coverage: 0.52,
        brightness: 1.0,
      }),
    [],
  );
  useEffect(() => {
    built.mesh.layers.set(CLOUD_RENDER_LAYER);
  }, [built]);
  useEffect(() => () => built.dispose(), [built]);

  // Cloud colors are authored as final (post-tonemap) values, so day/night is a plain
  // brightness ramp; the hue still warms at low sun via uSunColor (slower ×2 day ramp than
  // the ocean's, keeping sunrise/sunset clouds pink for longer).
  useFrame((_, dt) => {
    built.uniforms.uTime.value += dt;
    const atm = atmosphereRef.current;
    const sunDir = (atm as { sunDirection?: THREE.Vector3 } | null)?.sunDirection;
    if (sunDir) {
      built.uniforms.uSunDirection.value.copy(sunDir);
      const day = THREE.MathUtils.clamp(sunDir.y * 2, 0, 1);
      built.uniforms.uSunColor.value
        .setRGB(1.0, 0.62, 0.45)
        .lerp(SUN_DAY, day);
      built.uniforms.uBrightness.value = THREE.MathUtils.clamp(
        sunDir.y * 5 + 0.4,
        0.08,
        1.0,
      );
    }
  });

  return <primitive object={built.mesh} />;
}

function WaterPosts() {
  // Remnant wooden pier: a curving line of pilings with cross-beams connecting most adjacent
  // pairs (some missing, suggesting weathering). Each piling has its own height, tilt and
  // slight radial offset, so the structure reads as varied and decayed — not regimented.
  //
  // Default layer (not OCEAN_RENDER_LAYER) so the meshes land in the reflection RT and SSR
  // picks them up; tagged as depth casters so the water shader cuts the above-water portion
  // through the transparent water plane (and the new near-land gate in ocean.frag.glsl
  // suppresses the foam contact ring around them).
  const built = useMemo(() => {
    const group = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.13, 0.07, 0.04), // dark weathered wood
      roughness: 0.95,
      metalness: 0,
    });
    // Two shared unit geometries; per-instance scale.y sets length.
    const postGeom = new THREE.CylinderGeometry(0.14, 0.18, 1, 10, 1);
    const beamGeom = new THREE.CylinderGeometry(0.07, 0.07, 1, 6, 1);

    // Deterministic hash → [0, 1).
    const rand = (i: number, s: number): number => {
      const v = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453;
      return v - Math.floor(v);
    };

    const N = 28;
    const baseRadius = 115;          // pushed further out
    const arcCenter = Math.PI / 4;    // +X +Z — default camera look direction
    const sweep = 0.95;               // wider arc (≈ 54°)
    const submerged = 2.8;
    const seed = 9001;

    type Post = { x: number; z: number; topY: number };
    const posts: Post[] = [];

    for (let i = 0; i < N; i++) {
      const t = i / (N - 1) - 0.5;
      const angleBase = arcCenter + t * sweep;
      // Tangential jitter: shift along the arc by up to ~half a slot, breaks the regular spacing
      // so adjacent posts can clump or open a gap — reads as "naturally distributed", not "rail".
      const slotSize = sweep / Math.max(1, N - 1);
      const angle = angleBase + (rand(i, seed + 700) - 0.5) * slotSize * 1.0;
      // Radial jitter: ±9m off the main arc, so the row has actual depth/width.
      const r = baseRadius + (rand(i, seed) - 0.5) * 18;
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;

      // Wider above-water range: 0.25m short stumps up to 3.4m tall intact pilings.
      const aboveWater = 0.25 + rand(i, seed + 100) * 3.15;
      const len = aboveWater + submerged;
      const topY = WATER_Y + aboveWater;
      const centerY = topY - len / 2;

      // Heavier tilts (±~17°) for the more decayed look.
      const tiltX = (rand(i, seed + 200) - 0.5) * 0.30;
      const tiltZ = (rand(i, seed + 300) - 0.5) * 0.30;

      const mesh = new THREE.Mesh(postGeom, material);
      mesh.scale.set(1, len, 1);
      mesh.position.set(x, centerY, z);
      mesh.rotation.set(tiltX, 0, tiltZ);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);

      posts.push({ x, z, topY });
    }

    // Cross-beams between adjacent posts. Skip if either post is too short (stumps don't
    // hold a rail), if they're too far apart (radial jitter pulled them apart), or randomly
    // (40% missing — more decay than the previous 25%).
    const Y_AXIS = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < N - 1; i++) {
      const a = posts[i];
      const b = posts[i + 1];
      if (a.topY < WATER_Y + 0.8 || b.topY < WATER_Y + 0.8) continue;
      const gap = Math.hypot(a.x - b.x, a.z - b.z);
      if (gap > 12) continue;
      if (rand(i, seed + 500) < 0.40) continue;

      // Drop beam slightly below the post tops so it reads as attached, not floating.
      const inset = 0.15;
      const p1 = new THREE.Vector3(a.x, a.topY - inset, a.z);
      const p2 = new THREE.Vector3(b.x, b.topY - inset, b.z);
      const dir = new THREE.Vector3().subVectors(p2, p1);
      const len = dir.length();
      const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);

      const beam = new THREE.Mesh(beamGeom, material);
      beam.scale.set(1, len, 1);
      beam.position.copy(mid);
      beam.quaternion.setFromUnitVectors(Y_AXIS, dir.normalize());
      beam.castShadow = false;
      beam.receiveShadow = false;
      beam.matrixAutoUpdate = false;
      beam.updateMatrix();
      group.add(beam);
    }

    return {
      group,
      dispose: () => {
        postGeom.dispose();
        beamGeom.dispose();
        material.dispose();
      },
    };
  }, []);

  useEffect(() => () => built.dispose(), [built]);
  return <DepthCasterTag object={built.group} />;
}

function OceanFloor() {
  const meshRef = useRef<THREE.Mesh>(null);
  useEffect(() => {
    if (meshRef.current) tagOceanDepthCasters(meshRef.current);
  }, []);
  return (
    <mesh
      ref={meshRef}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, FLOOR_Y, 0]}
    >
      <planeGeometry args={[200, 200, 1, 1]} />
      <meshStandardMaterial
        color={FLOOR_COLOR}
        roughness={1}
        metalness={0}
      />
    </mesh>
  );
}

const geodetic = new Geodetic();
const ecef = new THREE.Vector3();

function SceneContent() {
  const atmosphereRef = useRef<AtmosphereApi | null>(null);
  const atmosphereReadyRef = useRef(false);
  const oceanTextures = useOceanTextures();
  const beach = useMemo<SandBeach>(() => buildSandBeach({ waterY: WATER_Y }), []);
  useEffect(() => () => beach.dispose(), [beach]);

  // Push date + scene→ECEF frame into AtmosphereApi ONCE so Sky/SkyLight/SunLight pick up a
  // stable transform. We use a ref guard (instead of useEffect) so we don't race the
  // <Atmosphere> ref population.
  useFrame(() => {
    if (atmosphereReadyRef.current) return;
    const atm = atmosphereRef.current;
    if (atm == null) return;
    atm.updateByDate(SCENE_DATE);
    geodetic.set(
      radians(SCENE_LONGITUDE),
      radians(SCENE_LATITUDE),
      SCENE_HEIGHT_M,
    );
    Ellipsoid.WGS84.getNorthUpEastFrame(
      geodetic.toECEF(ecef),
      atm.worldToECEFMatrix,
    );
    atmosphereReadyRef.current = true;
  }, -1);

  return (
    <>
      <OrbitControls
        target={[0, WATER_Y, 0]}
        minDistance={4}
        maxDistance={80}
        maxPolarAngle={Math.PI / 2 - 0.05}
        enablePan={false}
      />
      <Atmosphere ref={atmosphereRef}>
        <Sky />
        <SkyLight />
        <SunLight />
        <MountainHorizon />
        {oceanTextures && (
          <>
            <DepthCasterTag object={beach.mesh} />
            <OceanFloor />
            <WaterPosts />
            <OceanLayer
              textures={oceanTextures}
              islandRoot={beach.shoreProxy}
              atmosphereRef={atmosphereRef}
            />
          </>
        )}
        <PainterlyCloudRing atmosphereRef={atmosphereRef} />
        <EffectComposer multisampling={0}>
          <AerialPerspective />
          <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
        </EffectComposer>
      </Atmosphere>
    </>
  );
}

export function Scene() {
  return (
    <Canvas
      gl={{ depth: false, toneMappingExposure: 3, antialias: false }}
      camera={{
        position: [-12, 5.5, -13],
        near: 0.1,
        far: 1e5,
        fov: 55,
      }}
    >
      <SceneContent />
    </Canvas>
  );
}
