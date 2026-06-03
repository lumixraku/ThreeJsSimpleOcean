import * as THREE from "three";

import type { SkyUniforms } from "./SkySystem";

export type SunControllerOptions = {
  /** Hour of day in [0, 24). Defaults to 17.5 (late afternoon → sunset). */
  hour?: number;
  /** Maximum sun elevation at noon, in degrees. Lower = more horizontal "tropical" arc. */
  maxElevationDeg?: number;
};

/**
 * Drives a single sun direction shared between the sky shader, ocean material, and scene lights.
 *
 * Only `hour` is user-facing. The controller derives a sun position from a simple tilted-circle
 * orbit (east at 06:00, zenith at 12:00, west at 18:00, below horizon overnight) and lerps between
 * three colour presets (day / warm / night) based on the resulting elevation.
 */
export class SunController {
  private hourValue: number;
  private readonly maxElevationDeg: number;

  /** Listeners notified after every direction change. */
  private readonly listeners: Array<(dir: THREE.Vector3, sunColor: THREE.Color) => void> = [];

  /** Reused vectors / colors to avoid per-update GC churn. */
  private readonly dir = new THREE.Vector3();
  private readonly sunColor = new THREE.Color();
  private readonly horizonColor = new THREE.Color();
  private readonly zenithColor = new THREE.Color();
  private elevationDegCache = 0;

  // Three colour presets: warm sunrise/sunset, blue daylight, deep night.
  private static readonly SUN_WARM = new THREE.Color(1.0, 0.5, 0.22);
  private static readonly SUN_DAY = new THREE.Color(1.0, 0.96, 0.88);
  private static readonly SUN_NIGHT = new THREE.Color(0.06, 0.07, 0.1);
  private static readonly HORIZON_WARM = new THREE.Color(0.98, 0.5, 0.26);
  private static readonly HORIZON_DAY = new THREE.Color(0.62, 0.78, 0.92);
  private static readonly HORIZON_NIGHT = new THREE.Color(0.03, 0.05, 0.12);
  private static readonly ZENITH_WARM = new THREE.Color(0.08, 0.12, 0.24);
  private static readonly ZENITH_DAY = new THREE.Color(0.32, 0.55, 0.86);
  private static readonly ZENITH_NIGHT = new THREE.Color(0.01, 0.02, 0.06);

  constructor(opts: SunControllerOptions = {}) {
    this.hourValue = opts.hour ?? 17.5;
    this.maxElevationDeg = opts.maxElevationDeg ?? 60;
  }

  /**
   * Wire this controller to the sky system: sun direction, sun color, horizon and zenith tints all
   * follow the current azimuth/elevation. Re-runs `set(...)` once so the sky picks up initial values.
   */
  bindSky(uniforms: SkyUniforms): void {
    this.listeners.push((dir, sunColor) => {
      uniforms.uSunDir.value.copy(dir);
      uniforms.uSunColor.value.copy(sunColor);
      uniforms.uHorizonColor.value.copy(this.horizonColor);
      uniforms.uZenithColor.value.copy(this.zenithColor);
    });
    this.apply();
  }

  /** Wire this controller to the ocean material's directional light uniform. */
  bindOceanLight(uLightDirWorld: { value: THREE.Vector3 }): void {
    this.listeners.push((dir) => {
      uLightDirWorld.value.copy(dir);
    });
    this.apply();
  }

  /** Register a listener fired after every direction change. Returns an unsubscribe handle. */
  subscribe(fn: (dir: THREE.Vector3, sunColor: THREE.Color) => void): () => void {
    this.listeners.push(fn);
    fn(this.dir, this.sunColor);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Read-only access to the current sun color (do not mutate). */
  get color(): THREE.Color {
    return this.sunColor;
  }

  /** Read-only access to the cached current direction (do not mutate). */
  get direction(): THREE.Vector3 {
    return this.dir;
  }

  /** Current hour of day in [0, 24). */
  get hour(): number {
    return this.hourValue;
  }

  /** Cached elevation of the sun, in degrees. Negative when the sun is below the horizon. */
  get elevationDeg(): number {
    return this.elevationDegCache;
  }

  /** Set the hour of day. Out-of-range values are wrapped into [0, 24). */
  setHour(hour: number): void {
    let h = hour % 24;
    if (h < 0) h += 24;
    this.hourValue = h;
    this.apply();
  }

  private apply(): void {
    // Tilted circular orbit: at h=6 sun is at horizon east, at h=12 it peaks toward +Z (south),
    // at h=18 it sets in the west, and the rest of the day it's below the horizon.
    const theta = (this.hourValue / 24) * Math.PI * 2 - Math.PI / 2;
    const tilt = THREE.MathUtils.degToRad(90 - this.maxElevationDeg);
    const baseX = Math.cos(theta);
    const baseY = Math.sin(theta);
    // Rotate (baseX, baseY, 0) around +X by `tilt` so peak elevation = 90° - tilt = maxElevationDeg.
    const x = baseX;
    const y = baseY * Math.cos(tilt);
    const z = baseY * Math.sin(tilt);
    this.dir.set(x, y, z).normalize();
    this.elevationDegCache = THREE.MathUtils.radToDeg(Math.asin(this.dir.y));

    // Two-stage blend: night → warm at the horizon, warm → day climbing higher.
    const el = this.elevationDegCache;
    const dayFactor = THREE.MathUtils.clamp(el / 25, 0, 1);
    const nightFactor = THREE.MathUtils.clamp(-el / 6, 0, 1);

    this.sunColor.copy(SunController.SUN_WARM).lerp(SunController.SUN_DAY, dayFactor);
    this.sunColor.lerp(SunController.SUN_NIGHT, nightFactor);
    this.horizonColor.copy(SunController.HORIZON_WARM).lerp(SunController.HORIZON_DAY, dayFactor);
    this.horizonColor.lerp(SunController.HORIZON_NIGHT, nightFactor);
    this.zenithColor.copy(SunController.ZENITH_WARM).lerp(SunController.ZENITH_DAY, dayFactor);
    this.zenithColor.lerp(SunController.ZENITH_NIGHT, nightFactor);

    for (const fn of this.listeners) fn(this.dir, this.sunColor);
  }
}
