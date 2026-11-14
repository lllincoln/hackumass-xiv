import { describe, expect, it } from 'vitest';
import {
  angleDiff,
  bearing,
  bearingENU,
  clockFace,
  compassWord,
  cumulativeLengths,
  fromENU,
  pointAlong,
  pointInPolygon,
  projectOnPolyline,
  projectOnSegment,
  relativeWords,
  toENU,
} from './index';

const origin = { lat: 42.39, lon: -72.525 };

describe('ENU conversion', () => {
  it('round-trips', () => {
    const p = toENU(origin, -72.5262, 42.3915);
    const back = fromENU(origin, p.x, p.y);
    expect(back.lon).toBeCloseTo(-72.5262, 9);
    expect(back.lat).toBeCloseTo(42.3915, 9);
  });

  it('puts north at +y and east at +x, in meters', () => {
    const north = toENU(origin, origin.lon, origin.lat + 0.001);
    expect(north.x).toBeCloseTo(0, 6);
    expect(north.y).toBeCloseTo(110.54, 2);
    const east = toENU(origin, origin.lon + 0.001, origin.lat);
    expect(east.y).toBeCloseTo(0, 6);
    expect(east.x).toBeGreaterThan(80);
    expect(east.x).toBeLessThan(84);
  });
});

describe('bearings', () => {
  it('measures clockwise from north', () => {
    expect(bearingENU({ x: 0, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(0);
    expect(bearingENU({ x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(90);
    expect(bearingENU({ x: 0, y: 0 }, { x: 0, y: -10 })).toBeCloseTo(180);
    expect(bearingENU({ x: 0, y: 0 }, { x: -10, y: 0 })).toBeCloseTo(270);
    expect(bearing(origin, { lon: origin.lon + 0.001, lat: origin.lat })).toBeCloseTo(90);
  });

  it('angleDiff is the signed turn, wrapping at ±180', () => {
    expect(angleDiff(350, 10)).toBe(20);
    expect(angleDiff(10, 350)).toBe(-20);
    expect(angleDiff(0, 180)).toBe(180);
    expect(angleDiff(90, 90)).toBe(0);
    expect(angleDiff(0, 270)).toBe(-90);
  });

  it('describes directions', () => {
    expect(clockFace(0)).toBe(12);
    expect(clockFace(60)).toBe(2);
    expect(clockFace(-90)).toBe(9);
    expect(clockFace(180)).toBe(6);
    expect(clockFace(350)).toBe(12);
    expect(compassWord(44)).toBe('northeast');
    expect(compassWord(359)).toBe('north');
    expect(relativeWords(5)).toBe('ahead');
    expect(relativeWords(90)).toBe('on your right');
    expect(relativeWords(-45)).toBe('ahead, on your left');
    expect(relativeWords(180)).toBe('behind you');
  });
});

describe('polygons and polylines', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  const hole = [
    { x: 4, y: 4 },
    { x: 6, y: 4 },
    { x: 6, y: 6 },
    { x: 4, y: 6 },
  ];

  it('point in polygon respects holes', () => {
    expect(pointInPolygon({ x: 2, y: 2 }, square, [hole])).toBe(true);
    expect(pointInPolygon({ x: 5, y: 5 }, square, [hole])).toBe(false);
    expect(pointInPolygon({ x: 12, y: 5 }, square, [hole])).toBe(false);
  });

  it('projects onto a segment and clamps to its ends', () => {
    const mid = projectOnSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(mid.point).toEqual({ x: 5, y: 0 });
    expect(mid.dist).toBeCloseTo(3);
    const end = projectOnSegment({ x: 15, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(end.point).toEqual({ x: 10, y: 0 });
    expect(end.t).toBe(1);
  });

  it('tracks distance along a polyline', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    const cum = cumulativeLengths(line);
    expect(cum).toEqual([0, 10, 20]);
    const pr = projectOnPolyline({ x: 12, y: 4 }, line, cum);
    expect(pr.along).toBeCloseTo(14);
    expect(pr.dist).toBeCloseTo(2);
    expect(pointAlong(line, cum, 15)).toEqual({ x: 10, y: 5 });
    expect(pointAlong(line, cum, 99)).toEqual({ x: 10, y: 10 });
    expect(pointAlong(line, cum, -1)).toEqual({ x: 0, y: 0 });
  });
});
