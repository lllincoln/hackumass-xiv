// USGS 3DEP 1 m lidar (bare earth) → public/data/terrain.json + terrain.bin. Run after the campus pack
// (`npm run terrain`): it reads the pack's origin and extent so both share one frame.
//
// The area is downloaded once as GeoTIFF tiles (NAD83 Massachusetts State Plane, meters) from the 3DEP elevation
// service and cached locally (gitignored); `npm run terrain -- --refresh` downloads it again. The app never calls
// USGS. Output: an elevation grid for draping the x-ray scene, and 3 m contour lines traced from that grid.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromENU, toENU, type Vec2 } from '../src/geo/index';
import type { CampusPack } from '../src/data/types';
import type { TerrainFile } from '../src/data/terrain';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = resolve(HERE, '../public/data/campus.json');
const OUT_JSON = resolve(HERE, '../public/data/terrain.json');
const OUT_BIN = resolve(HERE, '../public/data/terrain.bin');
/** Downloaded tiles, gitignored. */
const CACHE_DIR = resolve(HERE, '.terrain-cache');
const REFRESH = process.argv.includes('--refresh');

const SERVICE = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
/** Terrain reaches this far past the outermost mapped building or path. */
const MARGIN_M = 300;
/** Download resolution (the service resamples its 1 m lidar), and the stored grid's spacing. */
const SOURCE_M = 2;
/** Tile size per request, pixels. */
const TILE_PX = 400;
const CELL_M = 5;
const CONTOUR_INTERVAL_M = 3;
const INDEX_EVERY_M = 15;
/** Contours are traced on a lightly smoothed copy so lidar micro-relief does not make them ragged. */
const CONTOUR_SMOOTH_PASSES = 2;
const SIMPLIFY_M = 1;
/** Contour runs shorter than this are lidar noise (tiny closed loops around bumps). */
const MIN_CONTOUR_M = 25;

// ------------------------------------------------------------------------------------------ projection

/**
 * Lambert Conformal Conic (2SP) for NAD83 Massachusetts State Plane Mainland (EPSG:26986), meters.
 * Snyder, Map Projections: A Working Manual, eqs. 15-1…15-11. NAD83 and WGS84 agree to about a meter here.
 */
const statePlane = (() => {
  const a = 6378137;
  const f = 1 / 298.257222101;
  const e = Math.sqrt(2 * f - f * f);
  const rad = Math.PI / 180;
  const phi1 = 41.71666666666667 * rad;
  const phi2 = 42.68333333333333 * rad;
  const phi0 = 41 * rad;
  const lam0 = -71.5 * rad;
  const FE = 200000;
  const FN = 750000;
  const m = (phi: number) => Math.cos(phi) / Math.sqrt(1 - e * e * Math.sin(phi) ** 2);
  const t = (phi: number) => Math.tan(Math.PI / 4 - phi / 2) / ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2);
  const n = (Math.log(m(phi1)) - Math.log(m(phi2))) / (Math.log(t(phi1)) - Math.log(t(phi2)));
  const F = m(phi1) / (n * t(phi1) ** n);
  const rho0 = a * F * t(phi0) ** n;
  return {
    forward(lon: number, lat: number): { x: number; y: number } {
      const rho = a * F * t(lat * rad) ** n;
      const theta = n * (lon * rad - lam0);
      return { x: FE + rho * Math.sin(theta), y: FN + rho0 - rho * Math.cos(theta) };
    },
    inverse(x: number, y: number): { lon: number; lat: number } {
      const dx = x - FE;
      const dy = rho0 - (y - FN);
      const rho = Math.sign(n) * Math.hypot(dx, dy);
      const tt = (rho / (a * F)) ** (1 / n);
      let phi = Math.PI / 2 - 2 * Math.atan(tt);
      for (let i = 0; i < 8; i++) {
        const es = e * Math.sin(phi);
        phi = Math.PI / 2 - 2 * Math.atan(tt * ((1 - es) / (1 + es)) ** (e / 2));
      }
      return { lon: (Math.atan2(dx, dy) / n + lam0) / rad, lat: phi / rad };
    },
  };
})();

// ------------------------------------------------------------------------------------------ GeoTIFF

type Raster = { width: number; height: number; data: Float32Array; x0: number; y0: number; sx: number; sy: number };

/** Reads the uncompressed, tiled or stripped, single-band Float32 GeoTIFF the 3DEP service returns. */
function readGeoTiff(buf: Buffer): Raster {
  const le = buf.toString('latin1', 0, 2) === 'II';
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const f64 = (o: number) => (le ? buf.readDoubleLE(o) : buf.readDoubleBE(o));
  const f32 = (o: number) => (le ? buf.readFloatLE(o) : buf.readFloatBE(o));
  if (u16(2) !== 42) throw new Error('not a classic TIFF');

  const ifd = u32(4);
  const tags = new Map<number, number[]>();
  const SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8 };
  for (let i = 0, n = u16(ifd); i < n; i++) {
    const at = ifd + 2 + i * 12;
    const tag = u16(at);
    const type = u16(at + 2);
    const count = u32(at + 4);
    const size = (SIZES[type] ?? 1) * count;
    const base = size <= 4 ? at + 8 : u32(at + 8);
    const vals: number[] = [];
    for (let k = 0; k < count && type !== 2; k++) {
      if (type === 3) vals.push(u16(base + k * 2));
      else if (type === 4) vals.push(u32(base + k * 4));
      else if (type === 12) vals.push(f64(base + k * 8));
    }
    tags.set(tag, vals);
  }
  const one = (t: number) => tags.get(t)?.[0];
  const width = one(256)!;
  const height = one(257)!;
  if (one(258) !== 32 || one(339) !== 3) throw new Error('expected Float32 samples');
  if ((one(259) ?? 1) !== 1) throw new Error(`compressed TIFF (compression ${one(259)}) not supported`);
  const scale = tags.get(33550);
  const tie = tags.get(33922);
  if (!scale || !tie) throw new Error('GeoTIFF has no georeferencing');

  const data = new Float32Array(width * height);
  const tileW = one(322);
  const tileH = one(323);
  if (tileW && tileH) {
    const offsets = tags.get(324)!;
    const across = Math.ceil(width / tileW);
    offsets.forEach((off, ti) => {
      const tx = (ti % across) * tileW;
      const ty = Math.floor(ti / across) * tileH;
      for (let y = 0; y < tileH && ty + y < height; y++) {
        for (let x = 0; x < tileW && tx + x < width; x++) data[(ty + y) * width + tx + x] = f32(off + (y * tileW + x) * 4);
      }
    });
  } else {
    const offsets = tags.get(273)!;
    const rowsPer = one(278) ?? height;
    offsets.forEach((off, si) => {
      for (let y = 0; y < rowsPer && si * rowsPer + y < height; y++) {
        for (let x = 0; x < width; x++) data[(si * rowsPer + y) * width + x] = f32(off + (y * width + x) * 4);
      }
    });
  }
  // Tie point maps raster (0, 0), the top-left corner of the first pixel, to (X, Y); y grows downward.
  return { width, height, data, x0: tie[3] - tie[0] * scale[0], y0: tie[4] + tie[1] * scale[1], sx: scale[0], sy: scale[1] };
}

/** Mean of the valid pixels within `r` meters of a State Plane point (a small box filter), or NaN. */
function sample(ras: Raster, x: number, y: number, r: number): number {
  const c0 = Math.max(0, Math.floor((x - r - ras.x0) / ras.sx));
  const c1 = Math.min(ras.width - 1, Math.floor((x + r - ras.x0) / ras.sx));
  const r0 = Math.max(0, Math.floor((ras.y0 - (y + r)) / ras.sy));
  const r1 = Math.min(ras.height - 1, Math.floor((ras.y0 - (y - r)) / ras.sy));
  let sum = 0;
  let n = 0;
  for (let rr = r0; rr <= r1; rr++) {
    for (let cc = c0; cc <= c1; cc++) {
      const v = ras.data[rr * ras.width + cc];
      if (Number.isFinite(v) && v > -1000 && v < 10000) {
        sum += v;
        n++;
      }
    }
  }
  return n ? sum / n : NaN;
}

// ------------------------------------------------------------------------------------------ contours

function simplify(pts: Vec2[], tol: number): Vec2[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const a = pts[i];
    const b = pts[j];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1e-9;
    let worst = -1;
    let worstD = tol;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs(dy * (pts[k].x - a.x) - dx * (pts[k].y - a.y)) / len;
      if (d > worstD) {
        worstD = d;
        worst = k;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([i, worst], [worst, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

/**
 * Marching squares at one level, with the crossing segments joined into polylines. Crossings are identified by
 * the grid edge they lie on, which two neighbouring cells share, so chaining is exact.
 */
function traceLevel(h: Float32Array, cols: number, rows: number, level: number, at: (c: number, r: number) => Vec2): Vec2[][] {
  const key = (c: number, r: number, vertical: boolean) => (r * cols + c) * 2 + (vertical ? 1 : 0);
  const point = new Map<number, Vec2>();
  const links = new Map<number, number[]>();
  const cross = (c: number, r: number, vertical: boolean): number => {
    const k = key(c, r, vertical);
    if (!point.has(k)) {
      const a = h[r * cols + c];
      const b = vertical ? h[(r + 1) * cols + c] : h[r * cols + c + 1];
      const t = (level - a) / (b - a);
      const pa = at(c, r);
      const pb = vertical ? at(c, r + 1) : at(c + 1, r);
      point.set(k, { x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t });
    }
    return k;
  };
  const link = (p: number, q: number) => {
    links.set(p, [...(links.get(p) ?? []), q]);
    links.set(q, [...(links.get(q) ?? []), p]);
  };

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const v00 = h[r * cols + c], v10 = h[r * cols + c + 1], v01 = h[(r + 1) * cols + c], v11 = h[(r + 1) * cols + c + 1];
      const idx = (v00 >= level ? 1 : 0) | (v10 >= level ? 2 : 0) | (v11 >= level ? 4 : 0) | (v01 >= level ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      const S = () => cross(c, r, false); // south edge
      const N = () => cross(c, r + 1, false);
      const W = () => cross(c, r, true);
      const E = () => cross(c + 1, r, true);
      switch (idx) {
        case 1: case 14: link(W(), S()); break;
        case 2: case 13: link(S(), E()); break;
        case 3: case 12: link(W(), E()); break;
        case 4: case 11: link(E(), N()); break;
        case 6: case 9: link(S(), N()); break;
        case 7: case 8: link(W(), N()); break;
        case 5: case 10: {
          // Saddle: decide by the cell's centre value which corners are connected.
          const up = (v00 + v10 + v01 + v11) / 4 >= level;
          if ((idx === 5) === up) { link(W(), N()); link(S(), E()); } else { link(W(), S()); link(E(), N()); }
          break;
        }
      }
    }
  }

  const used = new Set<number>();
  const lines: Vec2[][] = [];
  const walk = (start: number) => {
    const chain = [start];
    used.add(start);
    let cur = start;
    for (;;) {
      const next = (links.get(cur) ?? []).find((k) => !used.has(k));
      if (next === undefined) break;
      used.add(next);
      chain.push(next);
      cur = next;
    }
    return chain;
  };
  // Open lines first (from an end, a crossing with one link), then closed loops.
  for (const [k, l] of links) if (l.length === 1 && !used.has(k)) lines.push(walk(k).map((x) => point.get(x)!));
  for (const k of links.keys()) {
    if (used.has(k)) continue;
    const loop = walk(k).map((x) => point.get(x)!);
    loop.push(loop[0]);
    lines.push(loop);
  }
  return lines;
}

// ------------------------------------------------------------------------------------------ main

/** One GeoTIFF from the 3DEP service for a State Plane box at SOURCE_M, retried a few times (it times out under load). */
async function fetchTile(minX: number, minY: number, w: number, h: number): Promise<Buffer> {
  const params = new URLSearchParams({
    bbox: [minX, minY, minX + w * SOURCE_M, minY + h * SOURCE_M].join(','),
    bboxSR: '26986',
    imageSR: '26986',
    size: `${w},${h}`,
    format: 'tiff',
    pixelType: 'F32',
    noDataInterpretation: 'esriNoDataMatchAny',
    interpolation: 'RSP_BilinearInterpolation',
    compression: 'None',
    f: 'image',
  });
  let last = '';
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const res = await fetch(`${SERVICE}?${params}`, { signal: AbortSignal.timeout(120_000) });
      if (res.ok && (res.headers.get('content-type') ?? '').includes('tiff')) return Buffer.from(await res.arrayBuffer());
      last = `HTTP ${res.status} ${(await res.text()).slice(0, 120).replace(/\s+/g, ' ')}`;
    } catch (err) {
      last = String(err);
    }
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }
  throw new Error(`3DEP export failed after retries: ${last}`);
}

/**
 * The whole box as one raster, fetched as TILE_PX tiles (one large request times out at the USGS gateway).
 * Tiles are cached by position, so a rerun downloads nothing.
 */
async function download(spMin: { x: number; y: number }, spMax: { x: number; y: number }): Promise<Raster> {
  // Snap to the source pixel grid so tiles line up exactly.
  const minX = Math.floor(spMin.x / SOURCE_M) * SOURCE_M;
  const minY = Math.floor(spMin.y / SOURCE_M) * SOURCE_M;
  const width = Math.ceil((spMax.x - minX) / SOURCE_M);
  const height = Math.ceil((spMax.y - minY) / SOURCE_M);
  const data = new Float32Array(width * height).fill(NaN);
  mkdirSync(CACHE_DIR, { recursive: true });

  const across = Math.ceil(width / TILE_PX);
  const down = Math.ceil(height / TILE_PX);
  let fetched = 0;
  for (let ty = 0; ty < down; ty++) {
    for (let tx = 0; tx < across; tx++) {
      const w = Math.min(TILE_PX, width - tx * TILE_PX);
      const h = Math.min(TILE_PX, height - ty * TILE_PX);
      // Tile rows count up from the south; raster rows count down from the north.
      const tMinX = minX + tx * TILE_PX * SOURCE_M;
      const tMinY = minY + ty * TILE_PX * SOURCE_M;
      const file = resolve(CACHE_DIR, `${tMinX}_${tMinY}_${w}x${h}@${SOURCE_M}.tif`);
      let buf: Buffer;
      if (!REFRESH && existsSync(file)) buf = readFileSync(file);
      else {
        buf = await fetchTile(tMinX, tMinY, w, h);
        writeFileSync(file, buf);
        fetched++;
        process.stdout.write(`\r  downloaded ${fetched} tiles…`);
      }
      const tile = readGeoTiff(buf);
      // Place by georeference, not by assumption.
      const col0 = Math.round((tile.x0 - minX) / SOURCE_M);
      const row0 = Math.round((minY + height * SOURCE_M - tile.y0) / SOURCE_M);
      for (let r = 0; r < tile.height; r++) {
        const rr = row0 + r;
        if (rr < 0 || rr >= height) continue;
        for (let c = 0; c < tile.width; c++) {
          const cc = col0 + c;
          if (cc < 0 || cc >= width) continue;
          data[rr * width + cc] = tile.data[r * tile.width + c];
        }
      }
    }
  }
  if (fetched) process.stdout.write('\n');
  console.log(`  ${across * down} tiles (${fetched} downloaded, the rest cached)`);
  return { width, height, data, x0: minX, y0: minY + height * SOURCE_M, sx: SOURCE_M, sy: SOURCE_M };
}

async function main(): Promise<void> {
  const pack = JSON.parse(readFileSync(PACK, 'utf8')) as CampusPack;
  const origin = pack.origin;

  // Extent of the pack in ENU, plus a margin.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (lon: number, lat: number) => {
    const p = toENU(origin, lon, lat);
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  };
  for (const b of pack.buildings) for (const [lon, lat] of b.outer) grow(lon, lat);
  for (const w of pack.ways) for (const [lon, lat] of w.coords) grow(lon, lat);
  const x0 = Math.floor((minX - MARGIN_M) / CELL_M) * CELL_M;
  const y0 = Math.floor((minY - MARGIN_M) / CELL_M) * CELL_M;
  const cols = Math.ceil((maxX + MARGIN_M - x0) / CELL_M) + 1;
  const rows = Math.ceil((maxY + MARGIN_M - y0) / CELL_M) + 1;
  const enuAt = (c: number, r: number): Vec2 => ({ x: x0 + c * CELL_M, y: y0 + r * CELL_M });

  // The same box in State Plane (ENU and State Plane are nearly aligned here; pad for the small rotation).
  let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity;
  for (const [c, r] of [[0, 0], [cols - 1, 0], [0, rows - 1], [cols - 1, rows - 1]]) {
    const p = enuAt(c, r);
    const ll = fromENU(origin, p.x, p.y);
    const sp = statePlane.forward(ll.lon, ll.lat);
    sMinX = Math.min(sMinX, sp.x); sMinY = Math.min(sMinY, sp.y);
    sMaxX = Math.max(sMaxX, sp.x); sMaxY = Math.max(sMaxY, sp.y);
  }
  const pad = 20;
  const spMin = { x: sMinX - pad, y: sMinY - pad };
  const spMax = { x: sMaxX + pad, y: sMaxY + pad };

  const ras = await download(spMin, spMax);
  console.log(`  raster ${ras.width}×${ras.height} at ${ras.sx.toFixed(2)} m`);

  // ---- grid: each cell averages the lidar within half a cell of its centre
  const h = new Float32Array(cols * rows);
  let missing = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p = enuAt(c, r);
      const ll = fromENU(origin, p.x, p.y);
      const sp = statePlane.forward(ll.lon, ll.lat);
      const v = sample(ras, sp.x, sp.y, CELL_M / 2);
      h[r * cols + c] = v;
      if (!Number.isFinite(v)) missing++;
    }
  }
  if (missing === h.length) throw new Error('no lidar values inside the area');
  if (missing) {
    // Gaps (no coverage): fill from the nearest valid cell, breadth first.
    const queue: number[] = [];
    for (let i = 0; i < h.length; i++) if (Number.isFinite(h[i])) queue.push(i);
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      const c = i % cols;
      const r = (i - c) / cols;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const j = nr * cols + nc;
        if (Number.isFinite(h[j])) continue;
        h[j] = h[i];
        queue.push(j);
      }
    }
    console.log(`  filled ${missing} cells with no lidar coverage`);
  }

  // ---- contours, from a smoothed copy
  let sm = h.slice();
  for (let pass = 0; pass < CONTOUR_SMOOTH_PASSES; pass++) {
    const next = new Float32Array(sm.length);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let s = 0, n = 0;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          s += sm[rr * cols + cc];
          n++;
        }
        next[r * cols + c] = s / n;
      }
    }
    sm = next;
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of h) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const contours: TerrainFile['contours'] = [];
  const lengthOf = (pts: Vec2[]) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0), 0);
  for (let level = Math.ceil(lo / CONTOUR_INTERVAL_M) * CONTOUR_INTERVAL_M; level <= hi; level += CONTOUR_INTERVAL_M) {
    for (const line of traceLevel(sm, cols, rows, level, enuAt)) {
      if (lengthOf(line) < MIN_CONTOUR_M) continue;
      contours.push({
        e: level,
        ...(level % INDEX_EVERY_M === 0 ? { i: 1 as const } : {}),
        p: simplify(line, SIMPLIFY_M).flatMap((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]),
      });
    }
  }

  // ---- write: heights as raw Int16 decimeters next to the JSON
  const dm = new Int16Array(cols * rows);
  for (let i = 0; i < h.length; i++) dm[i] = Math.round(h[i] * 10);
  writeFileSync(OUT_BIN, Buffer.from(dm.buffer));
  const out: TerrainFile = {
    source: 'USGS 3D Elevation Program (3DEP) 1 m lidar, bare earth; contours traced from it',
    cellM: CELL_M,
    x0,
    y0,
    cols,
    rows,
    heightsFile: 'terrain.bin',
    contours,
  };
  const json = JSON.stringify(out);
  writeFileSync(OUT_JSON, json);
  const points = contours.reduce((s, c) => s + c.p.length / 2, 0);
  console.log(`  grid ${cols}×${rows} at ${CELL_M} m, elevation ${lo.toFixed(1)}…${hi.toFixed(1)} m`);
  console.log(`  ${contours.length} contour lines, ${points} points`);
  console.log(`wrote ${OUT_JSON} (${(json.length / 1024).toFixed(0)} KB) and ${OUT_BIN} (${(dm.byteLength / 1024).toFixed(0)} KB)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
