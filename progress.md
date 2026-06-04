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

- `uSurfaceBrightness` 从原 1.4 → 0.7：原值给原管线 ACES@0.9 调的，新管线下亮度过头；曾短暂降到 0.3 但用户反馈太暗，取中间值
- 每帧把 `atmosphere.sunDirection` 同步到 `uLightDirWorld`
- 按 sunDir.y 推导 sun color 渐变到 `uSunColor`（仿原 SunController 的 warm/day/night 三色 lerp）— uniform 保留，但目前未被 shader 使用（见下）

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

createOceanMaterial(textures, depth, {
  surfaceBrightness: 0.7,
  displacement: 0.45,
  heightScroll: new THREE.Vector2(0.00024, 0.00016),
  albedoScroll: new THREE.Vector2(0.0012, 0.0008),
  normalScroll: new THREE.Vector2(-0.0007, 0.0011),
  specStrength: 0.3,
  fresnelStrength: 0.093,
  shallowAlpha: 0.15,
  absorption: 1.0,
})

// 云朵速度（已减速到原 1/3）
<Clouds
  localWeatherVelocity={[0.00133, 0]}
  shapeVelocity={[0.002, 0, 0.000667]}
  shapeDetailVelocity={[0.003, 0, 0.001]}
/>
```

## 提交

- `ca1ceb5` 添加了第三方云朵效果（删旧 sky/clouds、迁 R3F、接 `@takram/three-clouds`）
- `f9fabe5` 调整云朵速度（含 TAA 闪烁修复、README 截图）

## 云朵 PR 之后的水面回调（未 commit）

云朵 commit 顺手把水着色和岸边泡沫也改了，但 commit message 没提，结果水的"质感"和岸边一圈白与原来不一致。本轮迭代只回滚了**水着色**，泡沫部分（哈希噪声 + ShoreSdf 128² 分辨率）保留云朵 commit 之后的状态。

### 水着色（`src/ocean/shaders/ocean.frag.glsl`）

云朵 commit 引入 `uSunColor` 把 specular 和 fresnel 全染上日落暖色，加 sunGlare 项，菲涅尔在低日角时也整体偏暖。回滚到 `5493272` 的版本：

```glsl
// specular：去掉 sunGlare 和 uSunColor 乘子
vec3 specular = vec3(spec) * uSpecStrength;

// fresnel：恢复硬编码冷色 sky tint
vec3 fresnel = vec3(0.78, 0.88, 1.0) * fres * uFresnelStrength;
```

`uniform vec3 uSunColor;` 声明保留（不被着色器引用，但 JS 端 `Scene.tsx` 仍按帧写入；属于无害冗余）。

### 水面波浪 / 流速 / 反射 / 通透感（`src/Scene.tsx`）

经过 7~8 轮迭代逐项压。关键发现：水面感知到的"流"由 **三股 scroll** 叠加，前几轮只调了 `heightScroll`，`albedoScroll` / `normalScroll` 一直跑默认速度——这才是"压了一档还嫌快"的真正来源。最后三股一起 ÷10。

| 参数 | 默认 | 当前 | 用意 |
| --- | --- | --- | --- |
| `displacement` | 0.12 | **0.45** | 波浪起伏明显（~×3.75） |
| `heightScroll` | (0.006, 0.004) | **(0.00024, 0.00016)** | 流速 ÷25（默认基准） |
| `albedoScroll` | (0.012, 0.008) | **(0.0012, 0.0008)** | ÷10，跟其他 scroll 对齐 |
| `normalScroll` | (-0.007, 0.011) | **(-0.0007, 0.0011)** | ÷10 |
| `surfaceBrightness` | 1.4 | **0.7** | 新管线下 1.4 过曝，0.3 过暗，取中 |
| `specStrength` | 0.9 | **0.3** | 反射强度 ÷3 |
| `fresnelStrength` | 0.28 | **0.093** | 同上 ÷3 |
| `shallowAlpha` | 0.25 | **0.15** | 浅水更透 |
| `absorption` | 1.6 | **1.0** | 深水变暗减缓，保留远水蓝层次 |

通透感 = `shallowAlpha` ↓ + `absorption` ↓（深度衰减放缓）；`depthTintAmount` 未动（0.55），再要更透可继续降到 0.3~0.4。

### 反射开关试验

中途用户问"水面是不是在反射云朵的流动？"。答案是 **没有真反射**——shader 里 fresnel 是硬编码冷色 `vec3(0.78, 0.88, 1.0)`，specular 只是法线贴图 + 太阳方向算的高光。视觉上的"飘动暗斑"其实是 `<CloudLayer channel="r" shadow />` 把第一层主云投影到水面的结果。

为验证，曾把 `specStrength` / `fresnelStrength` 都设为 0 关掉所有反射，确认云影依旧存在 → 之后恢复到 0.3 / 0.093。

如果将来要做**真**镜面反射云：要么 planar reflection（每帧多渲一遍含云的场景到 RT，从水面 mirror 视角），要么环境立方体 + cloud cube 采样喂给 fresnel 项；代价是每帧多一次 raymarch。

### 云朵速度

云投影的飘动节奏直接喂"反射感"，跟水流一起减速。从 `f9fabe5` 调过的基准再 ÷3：

| 速度向量 | f9fabe5 | 当前 |
| --- | --- | --- |
| `localWeatherVelocity` | [0.004, 0] | [0.00133, 0] |
| `shapeVelocity` | [0.006, 0, 0.002] | [0.002, 0, 0.000667] |
| `shapeDetailVelocity` | [0.009, 0, 0.003] | [0.003, 0, 0.001] |

### 踩坑

- 中途连续改 shader 时 Vite HMR 缓存导致岛屿一度渲染成纯白（覆盖了 `MeshStandardMaterial`），硬刷新即恢复。改 RawShaderMaterial 的 `?raw` 导入 GLSL 时偶尔会出现这种状态。
- 用户首次提"水不对了，岸上一圈白"时一并提了两个问题，第一次按"完全回滚水+泡沫"全部回到 8cf26d0；第二次纠正为"水回到 5493272，泡沫保留 HEAD"。差异点：5493272 是云朵 commit **之前**的状态，但泡沫的哈希噪声/ShoreSdf 降分辨率早在 5493272（merge commit）里就引入了。
