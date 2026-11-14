// OpenStreetMap → public/data/campus.json. Run once (`npm run pack`) and commit the output.
// Source: the main OSM API's bbox download (a few seconds), falling back to Overpass mirrors if it is down.
// The app itself never calls either.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pointInRing, projectOnRing, projectOnSegment, ringArea, ringCentroid, toENU, fromENU, type Vec2 } from '../src/geo/index';
import type { CampusPack, FeatureKind, GazetteerEntry, LL, PackBuilding, PackFeature, PackWay, WayKind } from '../src/data/types';

// UMass Amherst campus plus a margin (south, west, north, east).
const BBOX = { s: 42.38, w: -72.54, n: 42.4, e: -72.51 };
const ORIGIN = { lat: (BBOX.s + BBOX.n) / 2, lon: (BBOX.w + BBOX.e) / 2 };
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../public/data/campus.json');
// Raw Overpass response, kept locally (gitignored) so the pack can be rebuilt while the mirrors are busy.
// A cached part is reused while its query text is unchanged; `npm run pack -- --refresh` fetches everything again.
const CACHE = resolve(HERE, '.overpass-cache.json');
const REFRESH = process.argv.includes('--refresh');
const OSM_QUERY_KEY = `map:${BBOX.w},${BBOX.s},${BBOX.e},${BBOX.n}:${2}`;
const PER_TRY_MS = 45_000;
const ROUNDS = 4;

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const SNAP_MAX_M = 12;
/** Distance from the path's centre line: half a path's width plus room for the object itself. */
const SNAP_OFFSET_M = 1.6;
const MAX_TREES = 400;
const LEVEL_M = 3.2;
const DEFAULT_HEIGHT_M = 8;

const HEAD = `[out:json][timeout:60][bbox:${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e}];`;
// Three small queries instead of one big one: each is quick for a busy server to accept, and each is cached on its own.
// `out geom` (not `out tags geom`): the default verbosity keeps relation members, which multipolygon buildings need.
const QUERIES: Record<string, string> = {
  buildings: `${HEAD}(way["building"];relation["building"];);out geom;`,
  ways: `${HEAD}way["highway"~"^(footway|path|pedestrian|steps|service|residential|living_street|unclassified|tertiary|secondary)$"];out geom;`,
  points: `${HEAD}(node["amenity"~"^(bench|waste_basket|bicycle_parking|drinking_water|toilets|bus_station)$"];node["highway"="bus_stop"];node["leisure"="picnic_table"];node["entrance"];node["natural"="tree"];);out geom;`,
};

type Tags = Record<string, string>;
type Pt = { lat: number; lon: number };
type OsmNode = { type: 'node'; id: number; lat: number; lon: number; tags?: Tags };
type OsmWay = { type: 'way'; id: number; geometry?: Pt[]; tags?: Tags };
type OsmRelation = {
  type: 'relation';
  id: number;
  tags?: Tags;
  members?: { type: string; role: string; geometry?: Pt[] }[];
};
type OsmElement = OsmNode | OsmWay | OsmRelation;

/** Names people actually say → matched against OSM names in the pack. Verify the printed matches after each run. */
const ALIAS_TABLE: { match: RegExp; aliases: string[] }[] = [
  { match: /computer science lab/i, aliases: ['CS Labs', 'Computer Science Labs', 'CSL', 'Computer Science Laboratory', 'CS Lab'] },
  { match: /lederle graduate research (tower|center)/i, aliases: ['LGRT', 'Lederle', 'Lederle Tower'] },
  { match: /integrative learning cent/i, aliases: ['ILC'] },
  { match: /manning|computer science building|information and computer sciences/i, aliases: ['CICS building', 'Manning', 'CICS', 'Manning CICS'] },
  { match: /du ?bois library/i, aliases: ['Du Bois', 'the tower', 'the library', 'library', 'Du Bois Library'] },
  { match: /lincoln campus center|^campus center$/i, aliases: ['Campus Center', 'the Campus Center'] },
  { match: /student union/i, aliases: ['Student Union', 'the Union'] },
  { match: /recreation center/i, aliases: ['Rec Center', 'the Rec', 'the gym'] },
  { match: /mullins/i, aliases: ['Mullins', 'Mullins Center'] },
  { match: /worcester (dining|commons)/i, aliases: ['Worcester', 'Woo', 'Worcester Dining Commons', 'Worcester DC'] },
  { match: /franklin (dining|commons)/i, aliases: ['Franklin', 'Frank', 'Franklin Dining Commons', 'Franklin DC'] },
  { match: /hampshire (dining|commons)/i, aliases: ['Hampshire', 'Hamp', 'Hampshire Dining Commons', 'Hampshire DC'] },
  { match: /berkshire (dining|commons)/i, aliases: ['Berkshire', 'Berk', 'Berkshire Dining Commons', 'Berkshire DC'] },
];

const FEATURE_LABEL: Record<FeatureKind, string> = {
  bench: 'bench',
  trash: 'trash can',
  bike_parking: 'bike parking',
  water: 'drinking water',
  toilets: 'toilets',
  bus_stop: 'bus stop',
  entrance: 'entrance',
  picnic_table: 'picnic table',
  tree: 'tree',
};

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const ll = (p: Pt): LL => [r6(p.lon), r6(p.lat)];
const enu = (p: LL): Vec2 => toENU(ORIGIN, p[0], p[1]);

type Cache = Record<string, { query: string; elements: OsmElement[] }>;

function readCache(): Cache {
  if (REFRESH || !existsSync(CACHE)) return {};
  try {
    return JSON.parse(readFileSync(CACHE, 'utf8')) as Cache;
  } catch {
    return {};
  }
}

/** One query against one mirror. */
async function queryMirror(url: string, query: string, signal: AbortSignal): Promise<OsmElement[]> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Wayfinder-HackUMass-pack-builder/0.1' },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.any([signal, AbortSignal.timeout(PER_TRY_MS)]),
  });
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  const json = (await res.json()) as { elements?: OsmElement[]; remark?: string };
  if (!json.elements?.length) throw new Error(`${new URL(url).host}: empty result${json.remark ? ` (${json.remark})` : ''}`);
  return json.elements;
}

/** Ask every mirror at once and take the first good answer; the slower requests are cancelled. */
async function raceMirrors(name: string, query: string): Promise<OsmElement[]> {
  let lastErr: unknown;
  for (let round = 1; round <= ROUNDS; round++) {
    const started = Date.now();
    const cancel = new AbortController();
    try {
      const elements = await Promise.any(OVERPASS_ENDPOINTS.map((url) => queryMirror(url, query, cancel.signal)));
      console.log(`  ${name}: ${elements.length} elements in ${((Date.now() - started) / 1000).toFixed(1)} s`);
      return elements;
    } catch (err) {
      lastErr = err instanceof AggregateError ? err.errors.map(String).join('; ') : err;
      console.warn(`  ${name}: round ${round}/${ROUNDS} failed (${String(lastErr)})`);
      if (round < ROUNDS) await new Promise((r) => setTimeout(r, 5000));
    } finally {
      cancel.abort();
    }
  }
  throw new Error(`Overpass: "${name}" failed on every mirror: ${String(lastErr)}`);
}

// ---- Primary source: api.openstreetmap.org "map" call -------------------------------------------------

const OSM_API = 'https://api.openstreetmap.org/api/0.6/map.json';
/** The bbox is split into TILES×TILES pieces to stay well under the API's 50,000-node limit per call. */
const TILES = 2;

type RawNode = { type: 'node'; id: number; lat: number; lon: number; tags?: Tags };
type RawWay = { type: 'way'; id: number; nodes: number[]; tags?: Tags };
type RawRelation = { type: 'relation'; id: number; members: { type: string; ref: number; role: string }[]; tags?: Tags };
type RawElement = RawNode | RawWay | RawRelation;

async function fetchTile(w: number, s: number, e: number, n: number): Promise<RawElement[]> {
  const url = `${OSM_API}?bbox=${w},${s},${e},${n}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Wayfinder-HackUMass-pack-builder/0.1' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`OSM API HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return ((await res.json()) as { elements: RawElement[] }).elements;
}

/** Download the bbox from the OSM API and reshape it like Overpass `out geom` (ways and members carry coordinates). */
async function fetchOsmApi(): Promise<OsmElement[]> {
  const started = Date.now();
  const tiles: [number, number, number, number][] = [];
  const dLon = (BBOX.e - BBOX.w) / TILES;
  const dLat = (BBOX.n - BBOX.s) / TILES;
  for (let i = 0; i < TILES; i++) {
    for (let j = 0; j < TILES; j++) {
      tiles.push([BBOX.w + i * dLon, BBOX.s + j * dLat, BBOX.w + (i + 1) * dLon, BBOX.s + (j + 1) * dLat]);
    }
  }

  // Two downloads at a time (the OSM API usage policy asks for at most two threads).
  const raw: RawElement[] = [];
  for (let i = 0; i < tiles.length; i += 2) {
    const batch = await Promise.all(tiles.slice(i, i + 2).map((t) => fetchTile(...t)));
    for (const b of batch) raw.push(...b);
  }

  const nodes = new Map<number, RawNode>();
  const ways = new Map<number, RawWay>();
  const relations = new Map<number, RawRelation>();
  for (const el of raw) {
    if (el.type === 'node') nodes.set(el.id, el);
    else if (el.type === 'way') ways.set(el.id, el);
    else relations.set(el.id, el);
  }

  const geometryOf = (w: RawWay): Pt[] =>
    w.nodes.map((id) => nodes.get(id)).filter((nd): nd is RawNode => nd !== undefined).map((nd) => ({ lat: nd.lat, lon: nd.lon }));

  const out: OsmElement[] = [];
  for (const nd of nodes.values()) if (nd.tags) out.push({ type: 'node', id: nd.id, lat: nd.lat, lon: nd.lon, tags: nd.tags });
  for (const w of ways.values()) if (w.tags) out.push({ type: 'way', id: w.id, geometry: geometryOf(w), tags: w.tags });
  for (const r of relations.values()) {
    if (!r.tags?.building) continue;
    out.push({
      type: 'relation',
      id: r.id,
      tags: r.tags,
      members: r.members
        .filter((m) => m.type === 'way' && ways.has(m.ref))
        .map((m) => ({ type: 'way', role: m.role, geometry: geometryOf(ways.get(m.ref) as RawWay) })),
    });
  }
  console.log(`  OSM API: ${raw.length} raw elements → ${out.length} tagged, in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return out;
}

async function fetchElements(): Promise<OsmElement[]> {
  const cache = readCache();
  const hit = cache['osm-api'];
  if (hit && hit.query === OSM_QUERY_KEY) {
    console.log(`  OSM API: ${hit.elements.length} elements from cache (pass --refresh to download again)`);
    return hit.elements;
  }
  try {
    const elements = await fetchOsmApi();
    writeFileSync(CACHE, JSON.stringify({ ...cache, 'osm-api': { query: OSM_QUERY_KEY, elements } }));
    return elements;
  } catch (err) {
    console.warn(`  OSM API failed (${String(err)}); trying Overpass mirrors…`);
    return fetchOverpass();
  }
}

// ---- Fallback: Overpass ------------------------------------------------------------------------------

async function fetchOverpass(): Promise<OsmElement[]> {
  const cache = readCache();
  const all: OsmElement[] = [];
  // One part at a time, so each mirror only ever sees one request from us (they allow very few per IP).
  for (const [name, query] of Object.entries(QUERIES)) {
    const hit = cache[name];
    if (hit && hit.query === query) {
      console.log(`  ${name}: ${hit.elements.length} elements from cache`);
      all.push(...hit.elements);
      continue;
    }
    const elements = await raceMirrors(name, query);
    cache[name] = { query, elements };
    writeFileSync(CACHE, JSON.stringify(cache)); // keep what we have even if a later part fails
    all.push(...elements);
  }
  return all;
}

function closeRing(pts: LL[]): LL[] | null {
  const out: LL[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out.length >= 3 ? out : null;
}

/** Join multipolygon member ways end to end into closed rings. */
function stitchRings(parts: LL[][]): LL[][] {
  const key = (p: LL) => `${p[0]},${p[1]}`;
  const rings: LL[][] = [];
  const pool = parts.filter((p) => p.length >= 2).map((p) => [...p]);
  while (pool.length) {
    let cur = pool.shift() as LL[];
    let grew = true;
    while (key(cur[0]) !== key(cur[cur.length - 1]) && grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const cand = pool[i];
        const tail = key(cur[cur.length - 1]);
        if (key(cand[0]) === tail) cur = cur.concat(cand.slice(1));
        else if (key(cand[cand.length - 1]) === tail) cur = cur.concat([...cand].reverse().slice(1));
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (key(cur[0]) === key(cur[cur.length - 1])) {
      const ring = closeRing(cur);
      if (ring) rings.push(ring);
    }
  }
  return rings;
}

function heightOf(tags: Tags): number {
  const h = parseFloat(tags.height ?? '');
  if (Number.isFinite(h) && h > 0) return Math.round(Math.min(h, 120) * 10) / 10;
  const levels = parseFloat(tags['building:levels'] ?? '');
  if (Number.isFinite(levels) && levels > 0) return Math.round(Math.min(levels * LEVEL_M, 120) * 10) / 10;
  return DEFAULT_HEIGHT_M;
}

function altNamesOf(tags: Tags): string[] {
  const out = new Set<string>();
  for (const k of ['alt_name', 'short_name', 'official_name', 'old_name', 'loc_name']) {
    for (const v of (tags[k] ?? '').split(';')) if (v.trim() && v.trim() !== tags.name) out.add(v.trim());
  }
  return [...out];
}

const WAY_CLASSES = new Set([
  'footway', 'path', 'pedestrian', 'steps', 'service', 'residential', 'living_street', 'unclassified', 'tertiary', 'secondary',
]);

function wayKind(tags: Tags): WayKind | null {
  const hw = tags.highway;
  if (!hw || !WAY_CLASSES.has(hw)) return null;
  if (tags.access === 'private' || tags.foot === 'no') return null;
  if (hw === 'steps') return 'steps';
  if (hw === 'footway') {
    if (tags.footway === 'sidewalk') return 'sidewalk';
    if (tags.footway === 'crossing') return 'crossing';
    return 'footway';
  }
  if (hw === 'pedestrian') return 'footway';
  if (hw === 'path') return 'path';
  return 'road';
}

function featureKind(tags: Tags): FeatureKind | null {
  switch (tags.amenity) {
    case 'bench':
      return 'bench';
    case 'waste_basket':
      return 'trash';
    case 'bicycle_parking':
      return 'bike_parking';
    case 'drinking_water':
      return 'water';
    case 'toilets':
      return 'toilets';
    case 'bus_station':
      return 'bus_stop';
  }
  if (tags.highway === 'bus_stop') return 'bus_stop';
  if (tags.leisure === 'picnic_table') return 'picnic_table';
  if (tags.entrance && tags.entrance !== 'no' && tags.entrance !== 'emergency') return 'entrance';
  if (tags.natural === 'tree') return 'tree';
  return null;
}

type Seg = { a: Vec2; b: Vec2; wayId: string };

function nearestSeg(p: Vec2, segs: Seg[], maxM: number): { seg: Seg; point: Vec2; dist: number } | null {
  let best: { seg: Seg; point: Vec2; dist: number } | null = null;
  for (const seg of segs) {
    // cheap reject before the projection
    if (Math.min(seg.a.x, seg.b.x) - p.x > maxM || p.x - Math.max(seg.a.x, seg.b.x) > maxM) continue;
    if (Math.min(seg.a.y, seg.b.y) - p.y > maxM || p.y - Math.max(seg.a.y, seg.b.y) > maxM) continue;
    const pr = projectOnSegment(p, seg.a, seg.b);
    if (pr.dist <= maxM && (!best || pr.dist < best.dist)) best = { seg, point: pr.point, dist: pr.dist };
  }
  return best;
}

async function main() {
  const elements = await fetchElements();
  console.log(`Fetched ${elements.length} OSM elements`);

  const buildings: PackBuilding[] = [];
  const ways: PackWay[] = [];
  const features: PackFeature[] = [];
  const trees: PackFeature[] = [];
  const plazaIds = new Set<string>();

  for (const el of elements) {
    const tags = el.tags ?? {};
    if (el.type === 'way') {
      if (!el.geometry?.length) continue;
      const coords = (el.geometry as (Pt | null)[]).filter((p): p is Pt => p !== null).map(ll);
      if (tags.building && tags.building !== 'no') {
        const outer = closeRing(coords);
        if (!outer) continue;
        const alt = altNamesOf(tags);
        buildings.push({
          id: `w${el.id}`,
          ...(tags.name ? { name: tags.name } : {}),
          ...(alt.length ? { altNames: alt } : {}),
          heightM: heightOf(tags),
          outer,
        });
      } else {
        const kind = wayKind(tags);
        if (kind && coords.length >= 2) {
          ways.push({ id: `w${el.id}`, kind, coords });
          // Plazas are mapped as closed "area" ways: their outline is not a path to line benches up along.
          if (tags.area === 'yes') plazaIds.add(`w${el.id}`);
        }
      }
    } else if (el.type === 'relation') {
      if (!tags.building || tags.building === 'no' || !el.members) continue;
      // Member geometry can contain nulls for nodes the server left out; an empty role means "outer".
      const part = (role: 'outer' | 'inner') =>
        (el.members ?? [])
          .filter((m) => m.type === 'way' && (m.role || 'outer') === role && m.geometry?.length)
          .map((m) => (m.geometry as (Pt | null)[]).filter((p): p is Pt => p !== null).map(ll));
      const outers = stitchRings(part('outer'));
      if (!outers.length) continue;
      const area = (r: LL[]) => Math.abs(ringArea(r.map(enu)));
      outers.sort((a, b) => area(b) - area(a));
      const holes = stitchRings(part('inner'));
      const alt = altNamesOf(tags);
      buildings.push({
        id: `r${el.id}`,
        ...(tags.name ? { name: tags.name } : {}),
        ...(alt.length ? { altNames: alt } : {}),
        heightM: heightOf(tags),
        outer: outers[0],
        ...(holes.length ? { holes } : {}),
      });
    } else if (el.type === 'node') {
      const kind = featureKind(tags);
      if (!kind) continue;
      const f: PackFeature = {
        id: `n${el.id}`,
        kind,
        lon: r6(el.lon),
        lat: r6(el.lat),
        ...(tags.name ? { name: tags.name } : {}),
      };
      (kind === 'tree' ? trees : features).push(f);
    }
  }

  // Trees: keep the ones closest to the campus center, capped.
  trees.sort((a, b) => Math.hypot(enu([a.lon, a.lat]).x, enu([a.lon, a.lat]).y) - Math.hypot(enu([b.lon, b.lat]).x, enu([b.lon, b.lat]).y));
  features.push(...trees.slice(0, MAX_TREES));

  // Entrances → the building whose outline they sit on.
  const outlines = buildings.map((b) => {
    const ring = b.outer.map(enu);
    const xs = ring.map((p) => p.x);
    const ys = ring.map((p) => p.y);
    return { id: b.id, ring, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  });
  let attached = 0;
  for (const f of features) {
    if (f.kind !== 'entrance') continue;
    const p = enu([f.lon, f.lat]);
    let best: { id: string; d: number } | null = null;
    for (const o of outlines) {
      if (p.x < o.minX - 2 || p.x > o.maxX + 2 || p.y < o.minY - 2 || p.y > o.maxY + 2) continue;
      const d = projectOnRing(p, o.ring).dist;
      if (d <= 1.5 && (!best || d < best.d)) best = { id: o.id, d };
    }
    if (best) {
      f.buildingId = best.id;
      attached++;
    }
  }

  // Snap small features beside the nearest sidewalk/footway/path.
  const segs: Seg[] = [];
  for (const w of ways) {
    if (w.kind !== 'sidewalk' && w.kind !== 'footway' && w.kind !== 'path') continue;
    if (plazaIds.has(w.id)) continue;
    const pts = w.coords.map(enu);
    for (let i = 0; i < pts.length - 1; i++) segs.push({ a: pts[i], b: pts[i + 1], wayId: w.id });
  }
  let snapped = 0;
  for (const f of features) {
    if (f.kind === 'entrance' || f.kind === 'tree') continue;
    const p = enu([f.lon, f.lat]);
    // Things inside a building (lobby benches, indoor bins) stay where they are: pulling them to an outdoor path is wrong.
    if (outlines.some((o) => p.x >= o.minX && p.x <= o.maxX && p.y >= o.minY && p.y <= o.maxY && pointInRing(p, o.ring))) continue;
    const hit = nearestSeg(p, segs, SNAP_MAX_M);
    if (!hit) continue;
    // Stand the object square to the path: straight out from the centre line, on the side it was mapped on.
    // (Mapped exactly on the line, or beyond the end of a segment: use the segment's left-hand normal.)
    const sx = hit.seg.b.x - hit.seg.a.x;
    const sy = hit.seg.b.y - hit.seg.a.y;
    const sl = Math.hypot(sx, sy) || 1;
    let nx = -sy / sl;
    let ny = sx / sl;
    if ((p.x - hit.point.x) * nx + (p.y - hit.point.y) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const s = fromENU(ORIGIN, hit.point.x + nx * SNAP_OFFSET_M, hit.point.y + ny * SNAP_OFFSET_M);
    f.snapped = {
      lon: r6(s.lon),
      lat: r6(s.lat),
      wayId: hit.seg.wayId,
      // direction from the object back toward the path, radians counter-clockwise from east
      facing: Math.round(Math.atan2(-ny, -nx) * 1000) / 1000,
    };
    snapped++;
  }

  // Gazetteer: every named building and named feature, plus the hand-maintained alias table.
  const gazetteer: GazetteerEntry[] = [];
  const seen = new Set<string>();
  for (const b of buildings) {
    if (!b.name) continue;
    const c = ringCentroid(b.outer.map(enu));
    const cll = fromENU(ORIGIN, c.x, c.y);
    gazetteer.push({ name: b.name, aliases: [...(b.altNames ?? [])], lon: r6(cll.lon), lat: r6(cll.lat), kind: 'building', buildingId: b.id });
    seen.add(b.name.toLowerCase());
  }
  for (const f of features) {
    if (!f.name || f.kind === 'tree') continue;
    const key = `${f.name.toLowerCase()}|${f.kind}`;
    // an entrance named like its building adds nothing
    if (seen.has(key) || (f.kind === 'entrance' && seen.has(f.name.toLowerCase()))) continue;
    seen.add(key);
    gazetteer.push({
      name: f.name,
      aliases: [`${f.name} ${FEATURE_LABEL[f.kind]}`],
      lon: f.snapped?.lon ?? f.lon,
      lat: f.snapped?.lat ?? f.lat,
      kind: f.kind,
      ...(f.buildingId ? { buildingId: f.buildingId } : {}),
    });
  }

  console.log('\nAlias table:');
  for (const row of ALIAS_TABLE) {
    const matches = gazetteer.filter((g) => g.kind === 'building' && row.match.test(g.name));
    if (!matches.length) {
      console.warn(`  !! no OSM building matches ${row.match} (${row.aliases[0]})`);
      continue;
    }
    // Several buildings can match ("Campus Center Parking Garage"): the shortest name is the plain one.
    matches.sort((a, b) => a.name.length - b.name.length);
    const target = matches[0];
    target.aliases = [...new Set([...target.aliases, ...row.aliases])];
    console.log(`  ${row.aliases[0].padEnd(22)} → ${target.name}${matches.length > 1 ? `   (also matched: ${matches.slice(1).map((m) => m.name).join('; ')})` : ''}`);
  }

  const pack: CampusPack = { origin: ORIGIN, buildings, ways, features, gazetteer };
  const json = JSON.stringify(pack);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);

  const count = (k: FeatureKind) => features.filter((f) => f.kind === k).length;
  console.log(`\nWrote ${OUT}`);
  console.log(`  size        ${(json.length / 1e6).toFixed(2)} MB`);
  console.log(`  buildings   ${buildings.length} (${buildings.filter((b) => b.name).length} named)`);
  console.log(`  ways        ${ways.length}`);
  console.log(`  features    ${features.length}  bench ${count('bench')}, trash ${count('trash')}, bike ${count('bike_parking')}, entrance ${count('entrance')} (${attached} on a building), bus ${count('bus_stop')}, tree ${count('tree')}`);
  console.log(`  snapped     ${snapped}`);
  console.log(`  gazetteer   ${gazetteer.length}`);
  if (json.length > 3e6) console.warn('  !! pack is over the ~3 MB target: shrink the bbox or drop service roads/trees');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
