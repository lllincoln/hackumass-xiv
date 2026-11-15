// Local ENU (east-north-up) geometry in meters. Pure functions: also used by the Node build scripts.

export type LonLat = { lon: number; lat: number };
export type Vec2 = { x: number; y: number };

const M_PER_DEG_LON = 111320;
const M_PER_DEG_LAT = 110540;
const RAD = Math.PI / 180;

/** Equirectangular projection around `origin`: x east, y north, in meters. */
export function toENU(origin: LonLat, lon: number, lat: number): Vec2 {
  return {
    x: (lon - origin.lon) * Math.cos(origin.lat * RAD) * M_PER_DEG_LON,
    y: (lat - origin.lat) * M_PER_DEG_LAT,
  };
}

export function fromENU(origin: LonLat, x: number, y: number): LonLat {
  return {
    lon: origin.lon + x / (Math.cos(origin.lat * RAD) * M_PER_DEG_LON),
    lat: origin.lat + y / M_PER_DEG_LAT,
  };
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Bearing in degrees clockwise from true north, between two ENU points. */
export function bearingENU(from: Vec2, to: Vec2): number {
  return norm360(Math.atan2(to.x - from.x, to.y - from.y) / RAD);
}

/** Bearing in degrees clockwise from true north, between two lon/lat points. */
export function bearing(from: LonLat, to: LonLat): number {
  return bearingENU({ x: 0, y: 0 }, toENU(from, to.lon, to.lat));
}

export function distanceLL(a: LonLat, b: LonLat): number {
  const p = toENU(a, b.lon, b.lat);
  return Math.hypot(p.x, p.y);
}

/** Signed turn from heading `a` to heading `b`, in −180…180. Positive = clockwise (turn right). */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export function pointInRing(p: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(p: Vec2, outer: readonly Vec2[], holes: readonly (readonly Vec2[])[] = []): boolean {
  if (!pointInRing(p, outer)) return false;
  for (const h of holes) if (pointInRing(p, h)) return false;
  return true;
}

export type SegmentProjection = { point: Vec2; t: number; dist: number };

/** Closest point to `p` on segment a→b. */
export function projectOnSegment(p: Vec2, a: Vec2, b: Vec2): SegmentProjection {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const point = { x: a.x + t * dx, y: a.y + t * dy };
  return { point, t, dist: dist(p, point) };
}

/** cum[i] = distance along the polyline from its start to vertex i. */
export function cumulativeLengths(line: readonly Vec2[]): number[] {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + dist(line[i - 1], line[i]));
  return cum;
}

export type PolylineProjection = { point: Vec2; dist: number; segIndex: number; along: number };

/** Closest point on a polyline, with the distance travelled along it to that point. */
export function projectOnPolyline(p: Vec2, line: readonly Vec2[], cum?: readonly number[]): PolylineProjection {
  if (line.length === 0) return { point: p, dist: Infinity, segIndex: 0, along: 0 };
  if (line.length === 1) return { point: line[0], dist: dist(p, line[0]), segIndex: 0, along: 0 };
  const c = cum ?? cumulativeLengths(line);
  let best: PolylineProjection = { point: line[0], dist: Infinity, segIndex: 0, along: 0 };
  for (let i = 0; i < line.length - 1; i++) {
    const pr = projectOnSegment(p, line[i], line[i + 1]);
    if (pr.dist < best.dist) {
      best = { point: pr.point, dist: pr.dist, segIndex: i, along: c[i] + pr.t * (c[i + 1] - c[i]) };
    }
  }
  return best;
}

/** The point `s` meters along a polyline (clamped to its ends). */
export function pointAlong(line: readonly Vec2[], cum: readonly number[], s: number): Vec2 {
  if (line.length === 0) return { x: 0, y: 0 };
  if (s <= 0) return line[0];
  const total = cum[cum.length - 1];
  if (s >= total) return line[line.length - 1];
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const seg = cum[i] - cum[i - 1];
  const t = seg === 0 ? 0 : (s - cum[i - 1]) / seg;
  return { x: line[i - 1].x + t * (line[i].x - line[i - 1].x), y: line[i - 1].y + t * (line[i].y - line[i - 1].y) };
}

/** Clock-face hour (1…12) for a direction relative to where the user faces. 12 = straight ahead. */
export function clockFace(relativeDeg: number): number {
  const h = Math.round(norm360(relativeDeg) / 30) % 12;
  return h === 0 ? 12 : h;
}

export function clockPhrase(relativeDeg: number): string {
  return `${clockFace(relativeDeg)} o'clock`;
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
export function compassWord(deg: number): string {
  return COMPASS[Math.round(norm360(deg) / 45) % 8];
}

/** "straight ahead", "ahead, on your right", "on your right", "behind you"… for a signed relative angle. */
export function relativeWords(relativeDeg: number): string {
  const d = angleDiff(0, relativeDeg);
  const a = Math.abs(d);
  const side = d >= 0 ? 'right' : 'left';
  if (a <= 20) return 'straight ahead';
  if (a <= 60) return `ahead, on your ${side}`;
  if (a <= 120) return `on your ${side}`;
  if (a <= 160) return `behind you, on your ${side}`;
  return 'behind you';
}

export function ringArea(ring: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
  return a / 2;
}

export function ringCentroid(ring: readonly Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j].x * ring[i].y - ring[i].x * ring[j].y;
    x += (ring[j].x + ring[i].x) * f;
    y += (ring[j].y + ring[i].y) * f;
    a += f;
  }
  if (Math.abs(a) < 1e-9) {
    // degenerate ring: fall back to the vertex mean
    const n = Math.max(1, ring.length);
    return { x: ring.reduce((s, p) => s + p.x, 0) / n, y: ring.reduce((s, p) => s + p.y, 0) / n };
  }
  return { x: x / (3 * a), y: y / (3 * a) };
}

/** Closest point on a closed ring's outline. */
export function projectOnRing(p: Vec2, ring: readonly Vec2[]): SegmentProjection & { segIndex: number } {
  let best: SegmentProjection & { segIndex: number } = { point: ring[0] ?? p, t: 0, dist: Infinity, segIndex: 0 };
  for (let i = 0; i < ring.length; i++) {
    const pr = projectOnSegment(p, ring[i], ring[(i + 1) % ring.length]);
    if (pr.dist < best.dist) best = { ...pr, segIndex: i };
  }
  return best;
}

/**
 * Distances along a ray (from `origin`, bearing in degrees clockwise from north) at which it crosses the
 * edges of a closed ring, sorted ascending. An even count means the origin is outside the ring.
 */
export function rayRingCrossings(origin: Vec2, bearingDeg: number, ring: readonly Vec2[]): number[] {
  const dx = Math.sin(bearingDeg * RAD);
  const dy = Math.cos(bearingDeg * RAD);
  const out: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue; // parallel
    const ax = a.x - origin.x;
    const ay = a.y - origin.y;
    const t = (ax * ey - ay * ex) / den; // along the ray
    const u = (ax * dy - ay * dx) / den; // along the edge
    if (t >= 0 && u >= 0 && u < 1) out.push(t);
  }
  return out.sort((p, q) => p - q);
}

/** Approximate gap between two closed rings' outlines: vertex-to-edge distance, both ways (near 0 when they touch). */
export function ringGap(a: readonly Vec2[], b: readonly Vec2[]): number {
  let best = Infinity;
  for (const p of a) best = Math.min(best, projectOnRing(p, b).dist);
  for (const p of b) best = Math.min(best, projectOnRing(p, a).dist);
  return best;
}
