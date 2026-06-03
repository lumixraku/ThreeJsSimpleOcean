precision highp float;

uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform vec3 uGroundColor;
uniform vec3 uCameraPos;
uniform mat4 uInverseProjection;
uniform mat4 uInverseView;

uniform float uCloudCoverage;
uniform float uCloudDensity;
uniform float uCloudHeight;
uniform float uCloudThickness;
uniform float uCloudScale;
uniform float uCloudSpeed;
uniform float uCloudAbsorb;
uniform vec2 uCloudWind;

varying vec2 vUv;

const float PI = 3.14159265359;

// === Hash + value noise + FBM ============================================

vec3 hash3(vec3 p) {
  p = vec3(
    dot(p, vec3(127.1, 311.7, 74.7)),
    dot(p, vec3(269.5, 183.3, 246.1)),
    dot(p, vec3(113.5, 271.9, 124.6))
  );
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

float noise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(dot(hash3(i + vec3(0.0, 0.0, 0.0)), f - vec3(0.0, 0.0, 0.0)),
          dot(hash3(i + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0)), u.x),
      mix(dot(hash3(i + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0)),
          dot(hash3(i + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0)), u.x), u.y),
    mix(
      mix(dot(hash3(i + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0)),
          dot(hash3(i + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0)), u.x),
      mix(dot(hash3(i + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0)),
          dot(hash3(i + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0)), u.x), u.y),
    u.z);
}

float fbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  // Rotated-and-scaled lacunarity matrix avoids axis-aligned banding without trig.
  mat3 m = mat3(0.00, 1.60, 1.20,
               -1.60, 0.72, -0.96,
               -1.20, -0.96, 1.28);
  // Per-octave temporal jitter so higher-frequency detail "boils" while the low-frequency shape
  // translates with the wind. Without this the clouds look like a slowly-sliding photograph.
  float tEvolve = uTime * uCloudSpeed * 0.35;
  for (int i = 0; i < 4; i++) {
    vec3 offset = vec3(
      sin(tEvolve * (1.0 + 0.7 * float(i))),
      cos(tEvolve * (0.8 + 0.5 * float(i))),
      sin(tEvolve * (1.3 + 0.4 * float(i)) + 1.7)
    ) * 0.35;
    v += a * noise(p + offset);
    p = m * p;
    a *= 0.5;
  }
  return v;
}

// === Cloud density ========================================================

float cloudDensity(vec3 worldPos) {
  float yBot = uCloudHeight - uCloudThickness * 0.5;
  float yTop = uCloudHeight + uCloudThickness * 0.5;
  float relH = clamp((worldPos.y - yBot) / max(uCloudThickness, 1e-3), 0.0, 1.0);
  // Bell-shape vertical profile so the cloud top/bottom is wispy, middle is dense.
  float vertical = smoothstep(0.0, 0.25, relH) * smoothstep(1.0, 0.55, relH);

  vec3 wind = vec3(uCloudWind.x, 0.0, uCloudWind.y) * uTime * uCloudSpeed;
  vec3 q = (worldPos + wind) / max(uCloudScale, 1e-3);
  // FBM in [-1,1] → remap to [0,1].
  float n = fbm(q) * 0.5 + 0.5;
  // coverage in [0,1] subtracts a threshold; higher coverage → larger surviving regions.
  float d = max(0.0, n - (1.0 - uCloudCoverage));
  // Sharpen the contrast a touch so coverage feels like a real knob.
  d = d * d * (3.0 - 2.0 * d);
  return d * vertical * uCloudDensity;
}

// === Henyey-Greenstein phase ==============================================

float henyey(float mu, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
}

// === Slab intersection ====================================================

// Returns vec2(tEnter, tExit). If tExit <= tEnter the ray misses.
vec2 slabIntersect(vec3 ro, vec3 rd, float yBot, float yTop) {
  // Treat the slab as the region yBot <= y <= yTop.
  if (abs(rd.y) < 1e-4) {
    if (ro.y > yBot && ro.y < yTop) return vec2(0.0, 1.0e4);
    return vec2(1.0, 0.0);
  }
  float t1 = (yBot - ro.y) / rd.y;
  float t2 = (yTop - ro.y) / rd.y;
  float tEnter = max(0.0, min(t1, t2));
  float tExit = max(t1, t2);
  return vec2(tEnter, tExit);
}

// === Cloud raymarch =======================================================

vec4 raymarchClouds(vec3 ro, vec3 rd, float mu) {
  float yBot = uCloudHeight - uCloudThickness * 0.5;
  float yTop = uCloudHeight + uCloudThickness * 0.5;
  vec2 hit = slabIntersect(ro, rd, yBot, yTop);
  float tEnter = hit.x;
  float tExit = min(hit.y, 1200.0);
  if (tExit <= tEnter) return vec4(0.0);

  const int STEPS = 14;
  float dt = (tExit - tEnter) / float(STEPS);

  // Forward-biased dual HG phase: backscatter + forward scatter, weighted toward forward.
  // Keep HG in natural sr^-1 units; a small fixed scatter scale stops the lit side of clouds from
  // burning through ACES tone mapping when looking straight at the sun.
  float phase = mix(henyey(mu, -0.2), henyey(mu, 0.55), 0.7);
  const float scatterScale = 1.4;

  // Ambient sky-light: a sample point sees the full hemisphere of sky overhead, so the shaded
  // side of a cloud is never truly black — it's lit by the surrounding sky.
  // We also add a cheap "multi-scattering" term tinted by the sun, since photons that entered the
  // sunlit side bounce around and re-emerge everywhere. Without this term clouds read as black smoke.
  vec3 ambientSky = mix(uHorizonColor, uZenithColor, 0.55) * 0.9;
  vec3 ambientSun = uSunColor * 0.28;
  vec3 ambient = ambientSky + ambientSun;

  // Small per-pixel jitter to break up banding from the fixed step count.
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  float t = tEnter + dt * jitter;

  float transmittance = 1.0;
  vec3 scattering = vec3(0.0);

  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * t;
    float d = cloudDensity(p);
    if (d > 0.003) {
      // Short march toward the sun to gather absorption.
      float ltDensity = 0.0;
      float lStep = uCloudThickness * 0.28;
      for (int j = 1; j <= 3; j++) {
        vec3 lp = p + uSunDir * lStep * float(j);
        ltDensity += cloudDensity(lp) * lStep;
      }
      float sunVis = exp(-ltDensity * uCloudAbsorb);
      // Powdered-sugar trick: a small inverse exponential boosts edge brightness.
      float powder = 1.0 - exp(-d * 4.0);
      vec3 sunLight = uSunColor * sunVis * phase * scatterScale * (0.6 + 0.4 * powder);
      vec3 lum = sunLight + ambient;
      float stepT = exp(-d * dt * uCloudAbsorb);
      scattering += transmittance * (1.0 - stepT) * lum;
      transmittance *= stepT;
      if (transmittance < 0.01) break;
    }
    t += dt;
  }
  return vec4(scattering, 1.0 - transmittance);
}

// === Main =================================================================

void main() {
  // Reconstruct world ray direction from clip-space UV.
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 viewPos = uInverseProjection * vec4(ndc, 1.0, 1.0);
  vec3 viewDir = normalize(viewPos.xyz / viewPos.w);
  vec3 dir = normalize(mat3(uInverseView) * viewDir);

  float mu = clamp(dot(dir, uSunDir), -1.0, 1.0);

  // === Sky gradient =======================================================
  float h = clamp(dir.y, -1.0, 1.0);
  float t = pow(max(0.0, h), 0.42);
  vec3 sky = mix(uHorizonColor, uZenithColor, t);
  // Below horizon fades to a darker ground color (water reflection still draws over this).
  sky = mix(sky, uGroundColor, smoothstep(0.0, -0.25, h));

  // Sun-side warming concentrated near the horizon.
  float warmFactor = pow(max(mu, 0.0), 3.0) * (1.0 - smoothstep(0.0, 0.6, max(0.0, h)));
  sky += uSunColor * warmFactor * 0.28;

  // Mie-ish narrow glow around the sun.
  sky += uSunColor * pow(max(mu, 0.0), 14.0) * 0.45;
  // Wider faint halo.
  sky += uSunColor * pow(max(mu, 0.0), 2.0) * 0.06;

  // Sun disk (smoothstep over a narrow cone — disc looks crisp without aliasing).
  // Keep the peak in LDR-ish range so ACES doesn't crush it (and everything around it) to pure white.
  float diskCos = 0.99965;
  float disk = smoothstep(diskCos, diskCos + 0.00025, mu);
  sky = mix(sky, uSunColor * 1.6, disk);

  // === Clouds =============================================================
  vec3 col = sky;
  if (dir.y > -0.01) {
    vec4 cloud = raymarchClouds(uCameraPos, dir, mu);
    // Premultiplied "over" composite.
    col = sky * (1.0 - cloud.a) + cloud.rgb;
  }

  // === Horizon haze =======================================================
  // Pull everything near the horizon toward the horizon color so distant clouds blend in.
  float hazeT = 1.0 - smoothstep(0.0, 0.10, max(0.0, dir.y));
  col = mix(col, uHorizonColor, hazeT * 0.45);

  gl_FragColor = vec4(col, 1.0);
}
