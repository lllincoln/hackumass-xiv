// Step detection for pedestrian dead reckoning, from DeviceMotionEvent acceleration magnitude.

import { emit } from './bus';

export type StepDetectorOptions = {
  /** Minimum time between steps, ms. */
  minIntervalMs: number;
  /** Peak height above the running mean that counts as a step, m/s². Calibrate on a team member. */
  threshold: number;
};

export const STEP_DEFAULTS: StepDetectorOptions = { minIntervalMs: 300, threshold: 1.1 };

/** Pure detector: feed acceleration magnitudes (including gravity), get `true` on each step. */
export class StepDetector {
  private smooth = 9.81;
  private mean = 9.81;
  private lastStep = -Infinity;
  private rising = false;
  private peak = 0;
  private opts: StepDetectorOptions;

  constructor(opts: Partial<StepDetectorOptions> = {}) {
    this.opts = { ...STEP_DEFAULTS, ...opts };
  }

  update(magnitude: number, timeMs: number): boolean {
    // Low-pass to remove jitter; a much slower average tracks gravity.
    this.smooth += 0.25 * (magnitude - this.smooth);
    this.mean += 0.02 * (this.smooth - this.mean);
    const v = this.smooth - this.mean;

    if (v > this.opts.threshold) {
      this.rising = true;
      if (v > this.peak) this.peak = v;
      return false;
    }
    // A step is counted when the signal falls back after a peak above the threshold.
    if (this.rising && v < this.opts.threshold * 0.5) {
      this.rising = false;
      const peak = this.peak;
      this.peak = 0;
      if (peak < 8 && timeMs - this.lastStep >= this.opts.minIntervalMs) {
        this.lastStep = timeMs;
        return true;
      }
    }
    return false;
  }
}

let stop: (() => void) | null = null;

export function startMotion(opts?: Partial<StepDetectorOptions>): () => void {
  if (stop) return stop;
  const detector = new StepDetector(opts);
  const onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    const now = performance.now();
    if (detector.update(Math.hypot(a.x, a.y, a.z), now)) emit('step', { time: now });
  };
  window.addEventListener('devicemotion', onMotion);
  stop = () => {
    window.removeEventListener('devicemotion', onMotion);
    stop = null;
  };
  return stop;
}
