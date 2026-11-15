// Loads the campus pack and precomputes everything in ENU meters.

import {
  dist,
  fromENU,
  pointInPolygon,
  projectOnRing,
  projectOnSegment,
  rayRingCrossings,
  ringArea,
  ringCentroid,
  toENU,
  type LonLat,
  type Vec2,
} from '../geo';
import { loadTerrain } from './terrain';
import type { CampusPack, FeatureKind, GazetteerEntry, WayKind } from './types';

export type BBox = { minX: number; minY: number; maxX: number; maxY: number };

export type BuildingX = BBox & {
  id: string;
  name?: string;
  heightM: number;
  /** Counter-clockwise outline. */
  outer: Vec2[];
  holes: Vec2[][];
  centroid: Vec2;
  area: number;
  entrances: FeatureX[];
};

export type WayX = BBox & { id: string; kind: WayKind; pts: Vec2[] };

export type FeatureX = {
  id: string;
  kind: FeatureKind;
  name?: string;
  /** Display/guidance position (snapped beside the path when available). */
  pos: Vec2;
  lon: number;
  lat: number;
  buildingId?: string;
  /** Entrances: direction of the wall the door is in, radians from +x (east), counter-clockwise. */
  wallAngle?: number;
  /** Snapped features: direction toward the path they stand beside, radians from +x (east), counter-clockwise. */
  facing?: number;
};

export type PlaceX = GazetteerEntry & { id: string; pos: Vec2; keys: string[] };

export type PackIndex = {
  origin: LonLat;
  raw: CampusPack;
  buildings: BuildingX[];
  buildingById: Map<string, BuildingX>;
  ways: WayX[];
  features: FeatureX[];
  featureById: Map<string, FeatureX>;
  places: PlaceX[];
};

function bboxOf(pts: readonly Vec2[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|of|at|umass|building|hall)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function indexPack(raw: CampusPack): PackIndex {
  const origin = { lon: raw.origin.lon, lat: raw.origin.lat };
  const en = (p: readonly [number, number]) => toENU(origin, p[0], p[1]);

  const buildings: BuildingX[] = raw.buildings.map((b) => {
    let outer = b.outer.map(en);
    const signed = ringArea(outer);
    if (signed < 0) outer = outer.reverse();
    return {
      id: b.id,
      name: b.name,
      heightM: b.heightM,
      outer,
      holes: (b.holes ?? []).map((h) => h.map(en)),
      centroid: ringCentroid(outer),
      area: Math.abs(signed),
      entrances: [],
      ...bboxOf(outer),
    };
  });
  const buildingById = new Map(buildings.map((b) => [b.id, b]));

  const ways: WayX[] = raw.ways.map((w) => {
    const pts = w.coords.map(en);
    return { id: w.id, kind: w.kind, pts, ...bboxOf(pts) };
  });

  const features: FeatureX[] = raw.features.map((f) => {
    const lon = f.snapped?.lon ?? f.lon;
    const lat = f.snapped?.lat ?? f.lat;
    const fx: FeatureX = { id: f.id, kind: f.kind, name: f.name, pos: toENU(origin, lon, lat), lon, lat, buildingId: f.buildingId, facing: f.snapped?.facing };
    if (f.kind === 'entrance' && f.buildingId) {
      const b = buildingById.get(f.buildingId);
      if (b) {
        const pr = projectOnRing(fx.pos, b.outer);
        const a = b.outer[pr.segIndex];
        const c = b.outer[(pr.segIndex + 1) % b.outer.length];
        fx.wallAngle = Math.atan2(c.y - a.y, c.x - a.x);
        b.entrances.push(fx);
      }
    }
    return fx;
  });
  const featureById = new Map(features.map((f) => [f.id, f]));

  const places: PlaceX[] = raw.gazetteer.map((g, i) => ({
    ...g,
    id: `g:${i}`,
    pos: toENU(origin, g.lon, g.lat),
    keys: [...new Set([g.name, ...g.aliases].map(normalizeName).filter(Boolean))],
  }));

  return { origin, raw, buildings, buildingById, ways, features, featureById, places };
}

export async function loadPack(url = '/data/campus.json'): Promise<PackIndex> {
  // Terrain loads alongside, so the x-ray scene is built on the real ground from the start (it is optional).
  const [res] = await Promise.all([fetch(url), loadTerrain()]);
  if (!res.ok) throw new Error(`campus pack: HTTP ${res.status}`);
  return indexPack((await res.json()) as CampusPack);
}

/** The building containing `p` (the smallest one if footprints nest), or null. */
export function buildingAt(index: PackIndex, p: Vec2): BuildingX | null {
  let best: BuildingX | null = null;
  for (const b of index.buildings) {
    if (p.x < b.minX || p.x > b.maxX || p.y < b.minY || p.y > b.maxY) continue;
    if (pointInPolygon(p, b.outer, b.holes) && (!best || b.area < best.area)) best = b;
  }
  return best;
}

const WALKABLE: readonly WayKind[] = ['footway', 'sidewalk', 'path', 'crossing', 'steps'];

/** Closest point on any walkable way within `maxM`. */
export function nearestWalkway(index: PackIndex, p: Vec2, maxM: number): { point: Vec2; dist: number; way: WayX } | null {
  let best: { point: Vec2; dist: number; way: WayX } | null = null;
  for (const w of index.ways) {
    if (!WALKABLE.includes(w.kind)) continue;
    if (p.x < w.minX - maxM || p.x > w.maxX + maxM || p.y < w.minY - maxM || p.y > w.maxY + maxM) continue;
    for (let i = 0; i < w.pts.length - 1; i++) {
      const pr = projectOnSegment(p, w.pts[i], w.pts[i + 1]);
      if (pr.dist <= maxM && (!best || pr.dist < best.dist)) best = { point: pr.point, dist: pr.dist, way: w };
    }
  }
  return best;
}

export function nearestFeatures(index: PackIndex, p: Vec2, kind: FeatureKind, limit: number): { feature: FeatureX; dist: number }[] {
  return index.features
    .filter((f) => f.kind === kind)
    .map((feature) => ({ feature, dist: dist(p, feature.pos) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit);
}

export function featuresWithin(index: PackIndex, p: Vec2, radiusM: number): { feature: FeatureX; dist: number }[] {
  const out: { feature: FeatureX; dist: number }[] = [];
  for (const feature of index.features) {
    const dx = feature.pos.x - p.x;
    const dy = feature.pos.y - p.y;
    if (Math.abs(dx) > radiusM || Math.abs(dy) > radiusM) continue;
    const d = Math.hypot(dx, dy);
    if (d <= radiusM) out.push({ feature, dist: d });
  }
  return out.sort((a, b) => a.dist - b.dist);
}

export function buildingsWithin(index: PackIndex, p: Vec2, radiusM: number): BuildingX[] {
  return index.buildings.filter(
    (b) => p.x > b.minX - radiusM && p.x < b.maxX + radiusM && p.y > b.minY - radiusM && p.y < b.maxY + radiusM,
  );
}

/** Shallower than this along the line means a clipped corner. */
const MIN_RAY_DEPTH_M = 2;

export type RayHit = { building: BuildingX; enterM: number; exitM: number };

/**
 * Buildings a straight line from `p` (bearing in degrees from north) passes through, nearest first, out to
 * `maxM`. A building containing `p` comes first with enterM 0. Holes (courtyards) are ignored.
 */
export function buildingsAlongRay(index: PackIndex, p: Vec2, bearingDeg: number, maxM: number): RayHit[] {
  const hits: RayHit[] = [];
  for (const b of buildingsWithin(index, p, maxM)) {
    const t = rayRingCrossings(p, bearingDeg, b.outer);
    if (t.length === 0) continue;
    const inside = t.length % 2 === 1;
    const enterM = inside ? 0 : t[0];
    if (enterM > maxM) continue;
    // A line that only clips a corner does not put the building "on" the line.
    if (!inside && t[t.length - 1] - enterM < MIN_RAY_DEPTH_M) continue;
    hits.push({ building: b, enterM, exitM: t[t.length - 1] });
  }
  return hits.sort((a, b) => a.enterM - b.enterM);
}

export function toLonLat(index: PackIndex, p: Vec2): LonLat {
  return fromENU(index.origin, p.x, p.y);
}

export function toLocal(index: PackIndex, ll: LonLat): Vec2 {
  return toENU(index.origin, ll.lon, ll.lat);
}
