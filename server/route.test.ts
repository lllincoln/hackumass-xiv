import { describe, expect, it } from 'vitest';
import { bufferedBBoxPolygon, distToPolylineM, haversineM, parseLineString, type LonLatTuple } from './route';

// A north-south line about 111 m long near the ILC.
const line: LonLatTuple[] = [
  [-72.5258, 42.39],
  [-72.5258, 42.391],
];

describe('route geometry', () => {
  it('measures distance to a polyline in meters', () => {
    expect(distToPolylineM([-72.5258, 42.3905], line)).toBeCloseTo(0, 1);
    // 0.0001° of longitude at this latitude is about 8.2 m
    expect(distToPolylineM([-72.5257, 42.3905], line)).toBeGreaterThan(7.5);
    expect(distToPolylineM([-72.5257, 42.3905], line)).toBeLessThan(9);
    // beyond the end of the line: distance to the endpoint
    expect(distToPolylineM([-72.5258, 42.3912], line)).toBeCloseTo(22.1, 0);
  });

  it('agrees with haversine over short distances', () => {
    expect(haversineM(line[0], line[1])).toBeGreaterThan(110);
    expect(haversineM(line[0], line[1])).toBeLessThan(112);
  });

  it('builds a closed bbox polygon that contains the buffered line', () => {
    const poly = bufferedBBoxPolygon(line, 15);
    const ring = poly.coordinates[0];
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
    const lons = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    expect(Math.min(...lons)).toBeLessThan(-72.5258);
    expect(Math.max(...lons)).toBeGreaterThan(-72.5258);
    expect(Math.min(...lats)).toBeLessThan(42.39);
    expect(Math.max(...lats)).toBeGreaterThan(42.391);
  });

  it('validates LineString input', () => {
    expect(parseLineString({ type: 'LineString', coordinates: line })).toEqual(line);
    expect(parseLineString({ geometry: { type: 'LineString', coordinates: line } })).toEqual(line);
    expect(parseLineString({ type: 'Point', coordinates: line[0] })).toBeNull();
    expect(parseLineString({ type: 'LineString', coordinates: [[1, 2]] })).toBeNull();
    expect(parseLineString({ type: 'LineString', coordinates: [[1, 2], ['a', 3]] })).toBeNull();
    expect(parseLineString(null)).toBeNull();
  });
});
