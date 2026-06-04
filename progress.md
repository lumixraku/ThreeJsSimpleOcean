# 进展与改动记录

把原本 SimpleOcean 自带的体积云（写在 `sky.frag.glsl` 里的 raymarch）整套替换成 [`@takram/three-clouds`](https://github.com/takram-design-engineering/three-geospatial/tree/main/packages/clouds)，顺带把主循环从 vanilla Three.js 迁到 React Three Fiber。

## 删除的文件

- `src/sky/SkySystem.ts` — 旧的天空 + 体积云 RawShaderMaterial
- `src/sky/SunController.ts` — 手写的小时-时辰太阳轨迹/颜色控制器
- `src/sky/shaders/sky.frag.glsl` / `sky.vert.glsl` — 旧 sky shader（含云 raymarch）
- `src/app/OceanApplication.ts` — vanilla Three.js 主应用
- `src/main.ts` — vanilla 入口

## 新增的文件

- `src/main.tsx` — React 根
- `src/Scene.tsx` — R3F 场景，包含 `<Atmosphere>` + `<Sky>` + `<SkyLight>` + `<SunLight>` + `<EffectComposer>` (`<Clouds>` / `<AerialPerspective>` / `<ToneMapping>`)，复用现有 ocean 工具
- `docs/preview.jpg` — README demo 截图

## 配置改动

- `package.json` — 新增 React/R3F/postprocessing/`@takram/*`/`three@0.184`
- `tsconfig.json` / `tsconfig.build.json` — 加 `"jsx": "react-jsx"`、include `*.tsx`
- `vite.config.ts` — 加 esbuild `jsx: automatic`
- `index.html` — 加 `<div id="root">`，入口改 `main.tsx`

## 关键问题与修复历程

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| 黑山一片，整体异常 | `useEffect` 设 `worldToECEFMatrix` 跟 `<Atmosphere>` ref 注入时序赛跑，StrictMode 双挂载下经常拿到 `null`，矩阵保持单位阵 → 场景被当成位于地心 | 改用 `useFrame(cb, -1)`，在下游 Sky/Clouds 之前每帧写入 |
| 云不在天上而是糊在水面 | demo 配置第 4 个 `CloudLayer` 默认 `altitude=0, height=300` 是地面雾，相机 ~15m 海拔直接被埋在里面 | 删掉第 4 个 layer |
| 海面被冲成白色，比天空还亮 | demo 的 `toneMappingExposure: 10` 是给纯 HDR 大气准备，ocean shader 输出 SDR 颜色被乘 10 爆掉 | 曝光 → 1.5；ToneMapping 改 AGX → `ACES_FILMIC` 与原管线对齐 |
| 海面 + 远处一道黑带 | ocean plane 只有 120×120，相机海拔 15m 视野远超 60m，超出 ocean 边的「无几何区」黑掉 | ocean plane 扩到 20000×20000 |
| 天空灰暗，乌云压顶 | `coverage=0.5` 太密 + 时辰 17:30 太晚 | `coverage=0.2`；时辰 → 16:00（黄金时刻） |
| 云朵颗粒感明显 | 默认 `qualityPreset` 是 high，raymarching 步进密度不够 | `qualityPreset="ultra"`；`turbulence={false}` 关掉动态高频噪声 |
| 云背光面太黑 | 默认 `powderScale=0.8` + 物理散射对自遮挡过强 | `powderScale={0}`；`skyLightScale={3.5}` 增强天光填充；`scatterAnisotropy1={0.4}` + `scatterAnisotropyMix={0.7}` 散射更各向同性；主云层 `densityScale={0.4}` 云体变稀薄 |
| 云缘静态亮点（晶莹剔透） | 每帧重写 `worldToECEFMatrix` 让 cloud temporal pass 误以为视图变了，每帧 reject 历史 → TAA 永远不累积 → Bayer 抖动模式直接显示成静态噪点 | atmosphere 改成只设一次（`atmosphereReadyRef` 守门）；附加关掉 `lightShafts/shapeDetail/haze` 降低 HDR spike |
| 云朵静止不动 | `localWeatherVelocity` / `shapeVelocity` / `shapeDetailVelocity` 默认全 0 | 三组速度向量调节，最终：`[0.004, 0]` / `[0.006, 0, 0.002]` / `[0.009, 0, 0.003]` |

## Ocean 适配

- `uSurfaceBrightness` 从原 1.4 → 0.3：原值给原管线 ACES@0.9 调的，现在新管线下亮度过头
- 每帧把 `atmosphere.sunDirection` 同步到 `uLightDirWorld`
- 按 sunDir.y 推导 sun color 渐变到 `uSunColor`（仿原 SunController 的 warm/day/night 三色 lerp）

## 渲染管线对接

- R3F + `<EffectComposer>` 时 priority=1，自动接管渲染
- ocean 的 depth pre-pass 用 `useFrame(cb, -1)` 放在 composer 之前
- 用 `cam.layers.set(OCEAN_DEPTH_CASTER_LAYER)` + scene `overrideMaterial = MeshDepthMaterial` 过滤只渲染岛屿/海底 caster
- `bindOceanMatrices` + 同步 sun 都在 pre-pass 末尾完成

## 当前关键参数（`src/Scene.tsx`）

```tsx
SCENE_DATE = '2025-06-01T16:00:00Z'
SCENE_LATITUDE = 30
SCENE_LONGITUDE = 0
SCENE_HEIGHT_M = 10
toneMappingExposure = 1.5
<ToneMapping mode={ToneMappingMode.ACES_FILMIC} />

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
  localWeatherVelocity={[0.004, 0]}
  shapeVelocity={[0.006, 0, 0.002]}
  shapeDetailVelocity={[0.009, 0, 0.003]}
/>

createOceanMaterial(textures, depth, { surfaceBrightness: 0.3 })
```

## 提交

- `ca1ceb5` 添加了第三方云朵效果（删旧 sky/clouds、迁 R3F、接 `@takram/three-clouds`）
- `f9fabe5` 调整云朵速度（含 TAA 闪烁修复、README 截图）
