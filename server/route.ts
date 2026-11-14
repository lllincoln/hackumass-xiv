// Geometry helpers for "reports along a route" (the route itself is fetched by the browser from FOSSGIS OSRM).

export type LonLatTuple = [number, number];

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320;

function toMeters(p: LonLatTuple, lat0: number): [number, number] {
  return [p[0] * Math.cos((lat0 * Math.PI) / 180) * M_PER_DEG_LON, p[1] * M_PER_DEG_LAT];
}

/** Shortest distance in meters from a point to a polyline (equirectangular; fine at campus scale). */
export function distToPolylineM(point: LonLatTuple, line: LonLatTuple[]): number {
  if (line.length === 0) return Infinity;
  const lat0 = point[1];
  const [px, py] = toMeters(point, lat0);
  let best = Infinity;
  let [ax, ay] = toMeters(line[0], lat0);
  if (line.length === 1) return Math.hypot(px - ax, py - ay);
  for (let i = 1; i < line.length; i++) {
    const [bx, by] = toMeters(line[i], lat0);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d < best) best = d;
    ax = bx;
    ay = by;
  }
  return best;
}

/** A closed GeoJSON polygon ring: the line's bounding box grown by `bufferM` meters. Used as a cheap index prefilter. */
export function bufferedBBoxPolygon(line: LonLatTuple[], bufferM: number): { type: 'Polygon'; coordinates: LonLatTuple[][] } {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of line) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const midLat = (minLat + maxLat) / 2;
  const dLat = bufferM / M_PER_DEG_LAT;
  const dLon = bufferM / (M_PER_DEG_LON * Math.cos((midLat * Math.PI) / 180));
  const w = minLon - dLon;
  const e = maxLon + dLon;
  const s = minLat - dLat;
  const n = maxLat + dLat;
  // counter-clockwise, closed
  return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}

export function haversineM(a: LonLatTuple, b: LonLatTuple): number {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function parseLineString(body: unknown): LonLatTuple[] | null {
  const geom = body && typeof body === 'object' && 'geometry' in body ? (body as { geometry: unknown }).geometry : body;
  if (!geom || typeof geom !== 'object') return null;
  const g = geom as { type?: unknown; coordinates?: unknown };
  if (g.type !== 'LineString' || !Array.isArray(g.coordinates)) return null;
  if (g.coordinates.length < 2 || g.coordinates.length > 5000) return null;
  const out: LonLatTuple[] = [];
  for (const c of g.coordinates) {
    if (!Array.isArray(c) || !validLonLat(c[0], c[1])) return null;
    out.push([c[0], c[1]]);
  }
  return out;
}

export function validLonLat(lon: unknown, lat: unknown): lon is number {
  return (
    typeof lon === 'number' && typeof lat === 'number' && Number.isFinite(lon) && Number.isFinite(lat) &&
    lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90
  );
}
