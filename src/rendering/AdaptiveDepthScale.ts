export type AdaptiveDepthScaleOptions = {
  /** Target frame time in milliseconds (default 16.6 ≈ 60 fps). */
  frameTimeBudgetMs?: number;
  /** Depth resolution scale when under budget (default 0.5). */
  highScale?: number;
  /** Depth resolution scale when over budget (default 0.25). */
  lowScale?: number;
  /** Consecutive under-budget frames required before stepping back up (default 30). */
  recoverFrames?: number;
  /** EMA smoothing factor for frame time (default 0.08). */
  smoothing?: number;
};

/**
 * Adapts depth pre-pass resolution between high and low scales based on frame time.
 * Starts at `highScale` (0.5×) and drops to `lowScale` (0.25×) when over budget.
 */
export class AdaptiveDepthScale {
  private readonly frameTimeBudgetMs: number;
  private readonly highScale: number;
  private readonly lowScale: number;
  private readonly recoverFrames: number;
  private readonly smoothing: number;

  private emaMs = 0;
  private currentScale: number;
  private underBudgetCount = 0;

  constructor(options: AdaptiveDepthScaleOptions = {}) {
    this.frameTimeBudgetMs = options.frameTimeBudgetMs ?? 16.6;
    this.highScale = options.highScale ?? 0.5;
    this.lowScale = options.lowScale ?? 0.25;
    this.recoverFrames = options.recoverFrames ?? 30;
    this.smoothing = options.smoothing ?? 0.08;
    this.currentScale = this.highScale;
  }

  /** Call once per frame with the elapsed frame time in milliseconds. Returns the depth scale to use. */
  update(frameDeltaMs: number): number {
    if (frameDeltaMs <= 0) return this.currentScale;

    this.emaMs =
      this.emaMs === 0
        ? frameDeltaMs
        : this.emaMs + this.smoothing * (frameDeltaMs - this.emaMs);

    if (this.emaMs > this.frameTimeBudgetMs) {
      this.currentScale = this.lowScale;
      this.underBudgetCount = 0;
    } else {
      this.underBudgetCount++;
      if (this.underBudgetCount >= this.recoverFrames) {
        this.currentScale = this.highScale;
      }
    }

    return this.currentScale;
  }

  /** Current depth resolution scale without updating. */
  get scale(): number {
    return this.currentScale;
  }

  reset(): void {
    this.emaMs = 0;
    this.currentScale = this.highScale;
    this.underBudgetCount = 0;
  }
}
