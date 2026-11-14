import { describe, expect, it } from 'vitest';
import { indexPack } from '../data/pack';
import type { CampusPack, LL } from '../data/types';
import { fromENU } from '../geo';
import { Fusion, INDOOR_AFTER_MS, STEP_LENGTH_M } from './fusion';

const origin = { lat: 42.39, lon: -72.525 };
const ll = (x: number, y: number): LL => {
  const p = fromENU(origin, x, y);
  return [p.lon, p.lat];
};

// A 20 m square building with one door in the middle of its south wall, and a path 30 m to the east.
const pack: CampusPack = {
  origin,
  buildings: [{ id: 'b1', name: 'Test Hall', heightM: 8, outer: [ll(0, 0), ll(20, 0), ll(20, 20), ll(0, 20)] }],
  ways: [{ id: 'w1', kind: 'footway', coords: [ll(50, -50), ll(50, 50)] }],
  features: [{ id: 'e1', kind: 'entrance', lon: ll(10, 0)[0], lat: ll(10, 0)[1], buildingId: 'b1' }],
  gazetteer: [],
};
const index = indexPack(pack);

describe('Fusion', () => {
  it('takes the first fix even when it is poor, and records the uncertainty', () => {
    const f = new Fusion(index);
    f.gps({ x: 100, y: 100 }, 40, 0);
    expect(f.pos).toEqual({ x: 100, y: 100 });
    expect(f.sigma).toBe(40);
  });

  it('ignores later poor fixes but blends good ones', () => {
    const f = new Fusion(index);
    f.reset({ x: 100, y: 100 }, 10, 0);
    f.gps({ x: 200, y: 200 }, 60, 1000);
    expect(f.pos).toEqual({ x: 100, y: 100 });
    f.gps({ x: 110, y: 100 }, 10, 2000);
    // equal uncertainty → halfway, and σ shrinks by √2
    expect(f.pos?.x).toBeCloseTo(105);
    expect(f.sigma).toBeCloseTo(10 / Math.SQRT2);
  });

  it('dead-reckons along the heading and grows σ', () => {
    const f = new Fusion(index);
    f.reset({ x: 100, y: 100 }, 3, 0);
    for (let i = 0; i < 10; i++) f.step(90);
    expect(f.pos?.x).toBeCloseTo(100 + 10 * STEP_LENGTH_M);
    expect(f.pos?.y).toBeCloseTo(100);
    expect(f.sigma).toBeCloseTo(4.5);
  });

  it('keeps the estimate inside the building when it would cross a wall far from a door', () => {
    const f = new Fusion(index);
    f.reset({ x: 19.8, y: 15 }, 3, 0);
    f.step(90); // east wall, door is on the south side
    expect(f.pos?.x).toBeCloseTo(19.8);
    expect(f.building?.id).toBe('b1');
  });

  it('lets the estimate leave through a mapped door', () => {
    const f = new Fusion(index);
    f.reset({ x: 10, y: 0.3 }, 3, 0);
    f.step(180); // south, through the door
    expect(f.pos?.y).toBeLessThan(0);
    expect(f.building).toBeNull();
  });

  it('pulls an outdoor estimate toward the nearest path', () => {
    const f = new Fusion(index);
    f.gps({ x: 54, y: 0 }, 5, 0); // good fix, 4 m east of the path
    f.step(0);
    expect(f.pos?.x).toBeLessThan(54);
    expect(f.pos?.x).toBeGreaterThan(50);
  });

  it('reports indoors inside a footprint, or after 10 s of poor GPS', () => {
    const inside = new Fusion(index);
    inside.reset({ x: 10, y: 10 }, 3, 0);
    expect(inside.indoors(0)).toBe(true);

    const outside = new Fusion(index);
    outside.reset({ x: 100, y: 100 }, 3, 0);
    expect(outside.indoors(1000)).toBe(false);
    outside.gps({ x: 100, y: 100 }, 50, 1000);
    expect(outside.indoors(5000)).toBe(false);
    expect(outside.indoors(1000 + INDOOR_AFTER_MS + 1)).toBe(true);
    outside.gps({ x: 100, y: 100 }, 8, 20_000);
    expect(outside.indoors(20_001)).toBe(false);
  });
});
