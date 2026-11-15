// Pure mapping from heading error to feedback parameters (kept separate so it can be unit-tested).

export const DEADBAND_DEG = 8;
/** Leave the deadband only past this, so the chime does not chatter at the edge. */
export const DEADBAND_EXIT_DEG = 10;
export const MIN_RATE_HZ = 2;
export const MAX_RATE_HZ = 8;
/** Feedback is at full intensity from this error on (facing sideways is already as wrong as it gets). */
export const FULL_ERROR_DEG = 90;

export type TickParams = {
  /** Ticks per second. */
  rateHz: number;
  /** Stereo pan, −1 (left) … 1 (right): the side to turn toward. */
  pan: number;
  /** Oscillator frequency, Hz. */
  pitchHz: number;
  /** Vibration pulse length, ms. */
  vibrateMs: number;
};

/** @param diff signed turn needed, degrees: positive = turn right. */
export function tickParams(diff: number): TickParams {
  const error = Math.min(180, Math.abs(diff));
  const t = Math.min(1, Math.max(0, (error - DEADBAND_DEG) / (FULL_ERROR_DEG - DEADBAND_DEG)));
  return {
    rateHz: MIN_RATE_HZ + (MAX_RATE_HZ - MIN_RATE_HZ) * t,
    pan: Math.sign(diff) * Math.min(1, error / 90),
    pitchHz: 660 + 440 * t,
    vibrateMs: Math.round(20 + 60 * t),
  };
}

export function inDeadband(diff: number, wasInside: boolean): boolean {
  return Math.abs(diff) <= (wasInside ? DEADBAND_EXIT_DEG : DEADBAND_DEG);
}
