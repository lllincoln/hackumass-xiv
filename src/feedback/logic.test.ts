import { describe, expect, it } from 'vitest';
import { HeadingFilter, lookHeading } from '../sensors/orientation';
import { StepDetector } from '../sensors/motion';
import { scoreKey } from '../data/gazetteer';
import { inDeadband, tickParams } from './logic';

describe('bearing feedback', () => {
  it('is silent inside ±8°, with hysteresis on the way out', () => {
    expect(inDeadband(5, false)).toBe(true);
    expect(inDeadband(-8, false)).toBe(true);
    expect(inDeadband(9, false)).toBe(false);
    expect(inDeadband(9, true)).toBe(true);
    expect(inDeadband(11, true)).toBe(false);
  });

  it('ticks faster, higher and further to the side as the error grows', () => {
    const small = tickParams(12);
    const big = tickParams(80);
    expect(small.rateHz).toBeGreaterThanOrEqual(2);
    expect(tickParams(90).rateHz).toBeCloseTo(8);
    expect(tickParams(180).rateHz).toBeCloseTo(8);
    expect(big.rateHz).toBeGreaterThan(small.rateHz);
    expect(big.pitchHz).toBeGreaterThan(small.pitchHz);
    expect(big.vibrateMs).toBeGreaterThan(small.vibrateMs);
    expect(tickParams(45).pan).toBeCloseTo(0.5);
    expect(tickParams(-45).pan).toBeCloseTo(-0.5);
    expect(tickParams(120).pan).toBe(1);
  });
});

describe('heading', () => {
  it('reads the back-camera direction when the phone is upright', () => {
    expect(lookHeading(0, 90, 0)).toBeCloseTo(0);
    expect(lookHeading(270, 90, 0)).toBeCloseTo(90); // alpha is counter-clockwise
    expect(lookHeading(90, 90, 0)).toBeCloseTo(270);
    // tilted past vertical: still the same direction, no 180° flip
    expect(lookHeading(270, 120, 0)).toBeCloseTo(90);
    expect(lookHeading(270, 60, 0)).toBeCloseTo(90);
  });

  it('reads the top-edge direction when the phone lies flat', () => {
    expect(lookHeading(0, 0, 0)).toBeCloseTo(0);
    expect(lookHeading(270, 5, 0)).toBeCloseTo(90);
  });

  it('smooths across north without swinging through south', () => {
    const f = new HeadingFilter(0.5);
    f.update(350);
    const h = f.update(10);
    expect(h > 355 || h < 5).toBe(true);
  });
});

describe('step detector', () => {
  it('counts one step per bounce and ignores stillness', () => {
    const d = new StepDetector();
    let steps = 0;
    // 5 s of standing still
    for (let t = 0; t < 5000; t += 20) if (d.update(9.81, t)) steps++;
    expect(steps).toBe(0);
    // 10 s of walking at 2 steps per second (±3 m/s² bounce)
    for (let t = 5000; t < 15000; t += 20) {
      const a = 9.81 + 3 * Math.sin((2 * Math.PI * 2 * (t - 5000)) / 1000);
      if (d.update(a, t)) steps++;
    }
    expect(steps).toBeGreaterThanOrEqual(18);
    expect(steps).toBeLessThanOrEqual(21);
  });
});

describe('gazetteer scoring', () => {
  it('prefers exact aliases over partial matches', () => {
    expect(scoreKey('ilc', 'ilc')).toBe(1);
    expect(scoreKey('cs labs', 'cs labs')).toBe(1);
    expect(scoreKey('library', 'du bois library')).toBeGreaterThan(0.8);
    expect(scoreKey('lederle', 'lederle graduate research tower')).toBeGreaterThan(0.8);
    expect(scoreKey('pizza', 'integrative learning center')).toBe(0);
  });
});
