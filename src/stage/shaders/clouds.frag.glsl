precision highp float;

// Painterly cloud band. The mesh is an inward-facing cylinder around the scene; vUv.x wraps
// once around the ring, vUv.y runs bottom→top of the band. The noise domain is built from the
// unit circle (cos/sin of the wrap angle), so the field tiles seamlessly at the u=0/1 seam.
//
// The look is deliberately NOT physical: density comes from a few fbm octaves, lighting is a
// single directional-derivative sample toward the sun, and the lit factor is quantized into a
// handful of bands so the shading reads as flat brush-stroke color blocks (oil-sketch style)
// instead of a smooth gradient.

uniform float uTime;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uCoverage;   // fbm threshold: lower = more cloud
uniform float uBrightness; // day/night dimming (colors here are final post-tonemap values)

varying vec2 vUv;

float hash13(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float noise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

float fbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.52;
  for (int i = 0; i < 5; i++) {
    sum += amp * noise3(p);
    p = p * 2.07 + vec3(31.7, 11.3, 7.9);
    amp *= 0.5;
  }
  return sum;
}

void main() {
  float ang = vUv.x * 6.2831853;
  vec3 q = vec3(cos(ang) * 2.4, vUv.y * 2.0, sin(ang) * 2.4);
  vec3 drift = uTime * vec3(0.010, 0.0, 0.006);

  // Domain-warped fbm: the warp pushes the field into clumped, billowy masses.
  float base = fbm(q * 1.1 + drift);
  float detail = fbm(q * 3.4 + drift * 1.6 + vec3(base * 1.8));
  float d = base * 0.72 + detail * 0.28;

  // Big cumulus masses pile up in the lower half of the band (towers rising off the horizon);
  // the top is a denser, darker slate ceiling. Both get a lower fbm threshold.
  float cumulusW = 1.0 - smoothstep(0.20, 0.60, vUv.y);
  float topW = smoothstep(0.72, 0.92, vUv.y);
  float cov = uCoverage * (1.0 - 0.18 * cumulusW - 0.28 * topW);

  // Fade the band's bottom/top edges so the ring never shows a hard geometric border.
  float edgeEnv = smoothstep(0.0, 0.10, vUv.y) * (1.0 - smoothstep(0.93, 1.0, vUv.y));

  float alpha = smoothstep(cov, cov + 0.06, d) * edgeEnv;
  if (alpha < 0.004) discard;

  // Sunlit side: extra fbm taps offset toward the sun and straight up. Density dropping in
  // either direction means this point faces the sun / is near a local cloud top. The detail
  // octave jitters the boundary so shading follows the cloud texture instead of smooth
  // iso-lines.
  vec3 sunStep = normalize(vec3(uSunDirection.x, max(uSunDirection.y, 0.05), uSunDirection.z)) * 0.5;
  float dSun = fbm(q * 1.1 + drift + sunStep);
  float dUp = fbm(q * 1.1 + drift + vec3(0.0, 0.35, 0.0));
  float lit = clamp(
    0.5 + (base - dSun) * 2.2 + (base - dUp) * 1.4 + (detail - 0.5) * 0.45,
    0.0,
    1.0
  );

  // Soft-edged quantization: tones still gather into a few painted bands, but each band
  // border is feathered (the hard floor() version reads as paint-bucket fills).
  float t = lit * 3.0;
  float band = floor(t);
  float litSoft = (band + smoothstep(0.25, 0.75, t - band)) / 3.0;
  lit = mix(lit, litSoft, 0.5);

  // Colors are FINAL pixel values: this pass runs after the composer's tone mapping, so what
  // is written here is what lands on screen (palette sampled from the painted-sky reference).
  vec3 litCol = vec3(0.97, 0.83, 0.82) * mix(vec3(1.0), uSunColor, 0.45);
  vec3 shadowCol = vec3(0.44, 0.49, 0.59);
  litCol = mix(litCol, vec3(0.55, 0.59, 0.66), topW * 0.85);
  shadowCol = mix(shadowCol, vec3(0.34, 0.38, 0.46), topW);
  vec3 col = mix(shadowCol, litCol, lit);

  // Faint warm rim where the silhouette thins out toward the sky.
  float rim = smoothstep(cov, cov + 0.04, d) * (1.0 - smoothstep(cov + 0.04, cov + 0.16, d));
  col += uSunColor * rim * 0.10 * lit;

  gl_FragColor = vec4(col * uBrightness, alpha);
}
