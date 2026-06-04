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
import { CloudLayer, Clouds } from "@takram/three-clouds/r3f";
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
import { getDepthPrePassMaterial } from "./rendering/DepthPrePassMaterial";
import {
  OCEAN_DEPTH_CASTER_LAYER,
  tagOceanDepthCasters,
} from "./rendering/OceanDepthLayers";
import { computeTileBoundsXZ } from "./stage/TileBounds";
import {
  loadGrassTile,
  makeGrassPlaceholder,
  type GrassLoadResult,
} from "./stage/GrassTileLoader";

const WATER_Y = 1.5;
const FLOOR_Y = -2.0;
const FLOOR_COLOR = new THREE.Color(0.01, 0.05, 0.11);
const CAMERA_MIN_Y = WATER_Y + 0.6;

const SUN_DAY = new THREE.Color(1.0, 0.96, 0.88);
const SUN_NIGHT = new THREE.Color(0.06, 0.07, 0.1);
const OCEAN_RENDER_LAYER = 2;

// Anchor the scene origin onto the WGS84 ellipsoid so the atmosphere/sun math has a real frame.
const SCENE_LONGITUDE = 0;
const SCENE_LATITUDE = 30;
const SCENE_HEIGHT_M = 10;
const SCENE_DATE = new Date("2025-06-01T16:00:00Z");

function buildIslandLayout(template: THREE.Object3D): THREE.Object3D {
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
  group.position.set(
    -(box.min.x + box.max.x) * 0.5,
    0,
    -(box.min.z + box.max.z) * 0.5,
  );
  return group;
}

type SceneAssets = {
  textures: OceanTextureBundle;
  grass: GrassLoadResult;
};

function useSceneAssets(): SceneAssets | null {
  const [assets, setAssets] = useState<SceneAssets | null>(null);
  useEffect(() => {
    let alive = true;
    let loaded: SceneAssets | null = null;
    (async () => {
      const texLoader = new THREE.TextureLoader();
      const textures = await loadOceanTextures(texLoader, AssetPaths.ocean, 4);
      let grass: GrassLoadResult;
      try {
        grass = await loadGrassTile(AssetPaths.grass.model, {
          baseColorUrl: AssetPaths.grass.baseColor,
          normalUrl: AssetPaths.grass.normal,
        });
      } catch (e) {
        console.warn("[Grass] FBX load failed, using placeholder box.", e);
        grass = makeGrassPlaceholder();
      }
      loaded = { textures, grass };
      if (alive) setAssets(loaded);
      else {
        grass.dispose();
        textures.baseColor.dispose();
        textures.normal.dispose();
        textures.height.dispose();
        textures.foamMask?.dispose();
      }
    })();
    return () => {
      alive = false;
      // If StrictMode re-runs this effect after mount, dispose the previously-set assets.
      if (loaded) {
        loaded.grass.dispose();
        loaded.textures.baseColor.dispose();
        loaded.textures.normal.dispose();
        loaded.textures.height.dispose();
        loaded.textures.foamMask?.dispose();
      }
    };
  }, []);
  return assets;
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
    g.computeTangents();
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
      fresnelStrength: 1.0,
      shallowAlpha: 0.15,
      absorption: 1.0,
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

  // Reflection map: framebuffer after the EffectComposer pass but before the ocean draw. The ocean
  // mesh lives on OCEAN_RENDER_LAYER, so composer renders sky/clouds/island without water. We then
  // copy that no-water frame for reflection and draw only the ocean layer on top.
  const reflectionRT = useMemo(
    () =>
      new THREE.WebGLRenderTarget(1, 1, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        generateMipmaps: false,
        depthBuffer: false,
        stencilBuffer: false,
      }),
    [],
  );

  useEffect(() => {
    setOceanReflectionMap(uniforms, reflectionRT.texture);
    return () => setOceanReflectionMap(uniforms, null);
  }, [uniforms, reflectionRT]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
      depthPass.dispose();
      shoreSdf.dispose();
      reflectionRT.dispose();
    },
    [geometry, material, depthPass, shoreSdf, reflectionRT],
  );

  const tmpSize = useMemo(() => new THREE.Vector2(), []);

  // Priority 2 runs AFTER the EffectComposer (priority 1). Build a reflection map of the
  // post-composer frame (sky + clouds + island, no water) and then render the ocean on top.
  //
  // Step 1: render the no-water scene to reflectionRT. This forces GPU allocation of the texture
  // at the current size, dodging the "Offset overflows" crash that bare copyFramebufferToTexture
  // hits on the lazily-allocated 1×1 default.
  // Step 2: copyFramebufferToTexture overlays the post-effects canvas FB (which DOES contain the
  // clouds postprocessing pass) onto the now-allocated texture.
  useFrame((state) => {
    state.gl.getDrawingBufferSize(tmpSize);
    if (reflectionRT.width !== tmpSize.x || reflectionRT.height !== tmpSize.y) {
      reflectionRT.setSize(tmpSize.x, tmpSize.y);
    }

    const cam = state.camera as THREE.PerspectiveCamera;
    const prevLayers = cam.layers.mask;
    const prevAutoClear = state.gl.autoClear;
    const prevRT = state.gl.getRenderTarget();

    // Force-allocate the texture at the right size by rendering anything to it.
    cam.layers.disable(OCEAN_RENDER_LAYER);
    state.gl.autoClear = true;
    state.gl.setRenderTarget(reflectionRT);
    state.gl.render(scene, cam);
    state.gl.setRenderTarget(prevRT);

    // Now overlay the actual post-composer image (with clouds) on top.
    state.gl.copyFramebufferToTexture(reflectionRT.texture, new THREE.Vector2(0, 0));

    // Render just the ocean layer on top of the canvas backbuffer.
    cam.layers.set(OCEAN_RENDER_LAYER);
    state.gl.autoClear = false;
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
  const assets = useSceneAssets();
  const islandRoot = useMemo(
    () => (assets ? buildIslandLayout(assets.grass.root) : null),
    [assets],
  );

  // Push date + scene→ECEF frame into AtmosphereApi ONCE so Sky/SkyLight/SunLight/Clouds pick up
  // a stable transform. Rewriting worldToECEFMatrix every frame (as the three-clouds-demo does)
  // invalidates the volumetric cloud temporal accumulation — the TAA reprojection treats the
  // mutated matrix as a camera transform change and rejects history every frame, leaving the
  // Bayer dither pattern visible as static sparkle around cloud edges. We use a ref guard
  // (instead of useEffect) so we don't race the <Atmosphere> ref population.
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
        {islandRoot && assets && (
          <>
            <DepthCasterTag object={islandRoot} />
            <OceanFloor />
            <OceanLayer
              textures={assets.textures}
              islandRoot={islandRoot}
              atmosphereRef={atmosphereRef}
            />
          </>
        )}
        <EffectComposer multisampling={0}>
          <Clouds
            coverage={0.2}
            qualityPreset="ultra"
            turbulence={false}
            lightShafts={false}
            shapeDetail={false}
            haze={false}
            powderScale={0}
            skyLightScale={3.5}
            scatterAnisotropy1={0.4}
            scatterAnisotropyMix={0.7}
            localWeatherVelocity={[0.00133, 0]}
            shapeVelocity={[0.002, 0, 0.000667]}
            shapeDetailVelocity={[0.003, 0, 0.001]}
            shadow-maxFar={1e5}
            disableDefaultLayers
          >
            <CloudLayer
              channel="r"
              altitude={1000}
              height={1000}
              shapeAmount={0.8}
              weatherExponent={0.6}
              densityScale={0.4}
              shadow
            />
            <CloudLayer
              channel="g"
              altitude={2000}
              height={800}
              shapeAmount={0.8}
              shapeAlteringBias={0.5}
              densityScale={0.1}
            />
            <CloudLayer
              channel="b"
              altitude={2000}
              height={2000}
              densityScale={2e-3}
              shapeAmount={0.3}
            />
          </Clouds>
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
