// Ground elevation for the x-ray scene, from public/data/terrain.json + terrain.bin (scripts/build-terrain.ts,
// USGS 3DEP lidar).
// Heights are relative to the ground at the pack origin, so the scene stays near y = 0. Without the file
// (or outside it) the ground is flat at 0, exactly as before terrain existed.

import type { Vec2 } from '../geo';

export type TerrainFile = {
  source: string;
  /** Grid spacing, meters; cell (c, r) is at ENU (x0 + c·cellM, y0 + r·cellM). */
  cellM: number;
  x0: number;
  y0: number;
  cols: number;
  rows: number;
  /** File next to this one holding little-endian Int16 elevations in decimeters, row-major from the south-west corner. */
  heightsFile: string;
  /** Contour runs: elevation in meters, index contour flag, flat [x, y, x, y, …] ENU meters. */
  contours: { e: number; i?: 1; p: number[] }[];
};

export type Contour = { elev: number; index: boolean; pts: Vec2[]; minX: number; minY: number; maxX: number; maxY: number };

export type Terrain = {
  cellM: number;
  x0: number;
  y0: number;
  cols: number;
  rows: number;
  /** Absolute elevation, meters. */
  heights: Float32Array;
  /** Absolute elevation of the scene's y = 0. */
  ref: number;
  contours: Contour[];
};

let terrain: Terrain | null = null;

export function currentTerrain(): Terrain | null {
  return terrain;
}

export function indexTerrain(raw: TerrainFile, heightsBin: ArrayBuffer): Terrain {
  const dv = new DataView(heightsBin);
  const n = raw.cols * raw.rows;
  if (dv.byteLength < n * 2) throw new Error(`terrain heights: expected ${n * 2} bytes, got ${dv.byteLength}`);
  const heights = new Float32Array(n);
  for (let i = 0; i < n; i++) heights[i] = dv.getInt16(i * 2, true) / 10;

  const contours: Contour[] = raw.contours.map((c) => {
    const pts: Vec2[] = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < c.p.length; i += 2) {
      const p = { x: c.p[i], y: c.p[i + 1] };
      pts.push(p);
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    return { elev: c.e, index: c.i === 1, pts, minX, minY, maxX, maxY };
  });

  const t: Terrain = { cellM: raw.cellM, x0: raw.x0, y0: raw.y0, cols: raw.cols, rows: raw.rows, heights, ref: 0, contours };
  t.ref = elevationIn(t, { x: 0, y: 0 }) ?? 0;
  return t;
}

/**
 * Absolute elevation (meters) at an ENU point; null outside the grid. Interpolated on the same two triangles per
 * cell that the x-ray terrain mesh draws (split along the SE–NW diagonal), so things placed with it sit exactly
 * on the drawn ground.
 */
export function elevationIn(t: Terrain, p: Vec2): number | null {
  const fx = (p.x - t.x0) / t.cellM;
  const fy = (p.y - t.y0) / t.cellM;
  if (fx < 0 || fy < 0 || fx > t.cols - 1 || fy > t.rows - 1) return null;
  const c = Math.min(t.cols - 2, Math.floor(fx));
  const r = Math.min(t.rows - 2, Math.floor(fy));
  const u = fx - c;
  const v = fy - r;
  const i = r * t.cols + c;
  const h = t.heights;
  const h00 = h[i], h10 = h[i + 1], h01 = h[i + t.cols], h11 = h[i + t.cols + 1];
  return u + v <= 1 ? h00 + u * (h10 - h00) + v * (h01 - h00) : h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
}

/** Absolute elevation (meters above sea level) at an ENU point, or null when there is no terrain there. */
export function elevationAt(p: Vec2): number | null {
  return terrain ? elevationIn(terrain, p) : null;
}

/** Scene height of the ground at an ENU point (0 where there is no terrain). */
export function groundAt(p: Vec2): number {
  if (!terrain) return 0;
  const e = elevationIn(terrain, p);
  return e === null ? 0 : e - terrain.ref;
}

/** Optional: a missing or broken terrain file leaves the ground flat. */
export async function loadTerrain(url = '/data/terrain.json'): Promise<Terrain | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const raw = (await res.json()) as TerrainFile;
    // The heights file sits next to the JSON.
    const bin = await fetch(url.replace(/[^/]*$/, '') + raw.heightsFile);
    if (!bin.ok) return null;
    terrain = indexTerrain(raw, await bin.arrayBuffer());
    return terrain;
  } catch (err) {
    console.warn('[terrain] not loaded; the ground stays flat', err);
    return null;
  }
}
