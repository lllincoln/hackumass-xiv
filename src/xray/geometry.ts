// Geometry builders for the x-ray scene. Scene axes: ENU x → x, up → y, ENU y (north) → −z.
// Everything stands on the terrain: `height` arguments are meters above the ground at that point.

import * as THREE from 'three';
import type { BuildingX, WayX } from '../data/pack';
import { groundAt } from '../data/terrain';
import type { WayKind } from '../data/types';
import type { Vec2 } from '../geo';

export type P3 = [number, number, number];

export const EYE_HEIGHT_M = 1.6;

export function toScene(p: Vec2, height = 0): P3 {
  return [p.x, groundAt(p) + height, -p.y];
}

/**
 * Ground lines longer than this are split so they follow the terrain instead of cutting through hills or floating
 * over dips. Half the terrain's 5 m cell: a span then crosses at most one fold of the ground mesh.
 */
const DRAPE_STEP_M = 2.5;

/** A polyline with extra points so no span is longer than DRAPE_STEP_M. */
export function densify(line: readonly Vec2[], step = DRAPE_STEP_M): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[i];
    out.push(a);
    const b = line[i + 1];
    if (!b) break;
    const n = Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / step);
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / (n + 1), y: a.y + ((b.y - a.y) * k) / (n + 1) });
  }
  return out;
}

const bases = new WeakMap<BuildingX, number>();

/**
 * Scene height of a building's floor: the highest ground along its walls. On a slope the whole building then stands
 * on the ground and its downhill walls reach down to meet it, instead of the uphill side sitting inside the hill
 * (which the lowest-corner rule did for hundreds of buildings, South College among them).
 */
export function buildingBase(b: BuildingX): number {
  let base = bases.get(b);
  if (base === undefined) {
    base = -Infinity;
    for (const p of drapedRing(b.outer)) base = Math.max(base, groundAt(p));
    if (!Number.isFinite(base)) base = 0;
    bases.set(b, base);
  }
  return base;
}

/**
 * A closed outline with extra points along each wall (no span longer than DRAPE_STEP_M), so a wall's bottom edge can
 * follow the ground between corners instead of running straight from corner to corner (which left buildings
 * floating over dips or sunk into rises on a slope). The first point is not repeated at the end.
 */
function drapedRing(ring: readonly Vec2[]): Vec2[] {
  if (ring.length < 2) return [...ring];
  const out = densify([...ring, ring[0]]);
  out.pop();
  return out;
}

/** Scene height of a building's roof. */
export function buildingTop(b: BuildingX): number {
  return buildingBase(b) + b.heightM;
}

/** True when the outline bends at vertex i (so a vertical edge belongs there, as EdgesGeometry would draw). */
function isCorner(ring: readonly Vec2[], i: number): boolean {
  const n = ring.length;
  const a = ring[(i + n - 1) % n];
  const b = ring[i];
  const c = ring[(i + 1) % n];
  const ux = b.x - a.x, uy = b.y - a.y;
  const vx = c.x - b.x, vy = c.y - b.y;
  const cross = ux * vy - uy * vx;
  const dot = ux * vx + uy * vy;
  return Math.abs(Math.atan2(cross, dot)) > 0.2; // ~11°
}

/** Wireframe of an extruded footprint as line-segment pairs: ground outline, flat roof outline, corner verticals. */
export function buildingEdgePoints(b: BuildingX, out: P3[] = []): P3[] {
  const top = buildingTop(b);
  for (const ring of [b.outer, ...b.holes]) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % n];
      out.push([p.x, top, -p.y], [q.x, top, -q.y]);
      if (isCorner(ring, i)) out.push(toScene(p), [p.x, top, -p.y]);
    }
    // Bottom edge: along the ground.
    const ground = drapedRing(ring);
    for (let i = 0; i < ground.length; i++) out.push(toScene(ground[i]), toScene(ground[(i + 1) % ground.length]));
  }
  return out;
}

const STOREY_M = 3.2;
const MAX_FLOOR_LINES = 10;

/** Horizontal outlines at each storey, as line-segment pairs: makes a building's height and scale readable. */
export function floorLinePoints(b: BuildingX, out: P3[] = []): P3[] {
  const storeys = Math.floor((b.heightM - 0.5) / STOREY_M);
  if (storeys < 1) return out;
  // Towers would turn into a solid block of lines: draw every 2nd or 3rd storey instead.
  const every = Math.ceil(storeys / MAX_FLOOR_LINES);
  const base = buildingBase(b);
  for (let k = every; k <= storeys; k += every) {
    const h = base + k * STOREY_M;
    const ring = b.outer;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      out.push([p.x, h, -p.y], [q.x, h, -q.y]);
    }
  }
  return out;
}

/** A closed loop (first point repeated) just above the floor, for the containing building's floor outline. */
export function floorOutline(ring: readonly Vec2[], height = 0.05): P3[] {
  // On the ground, like the user standing in it, rather than at the building's (highest-corner) floor level.
  const pts: P3[] = drapedRing(ring).map((p) => toScene(p, height));
  if (pts.length) pts.push(pts[0]);
  return pts;
}

/** Outer walls of many buildings merged into one mesh. Faces point outward (outlines are counter-clockwise). */
export function wallsGeometry(buildings: readonly BuildingX[]): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const b of buildings) {
    const ring = drapedRing(b.outer);
    const h = buildingTop(b);
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      const gp = groundAt(p);
      const gq = groundAt(q);
      // two triangles: (p0, q0, q1) and (p0, q1, p1)
      pos.push(p.x, gp, -p.y, q.x, gq, -q.y, q.x, h, -q.y);
      pos.push(p.x, gp, -p.y, q.x, h, -q.y, p.x, h, -p.y);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

const WAY_STYLE: Record<WayKind, { width: number; lift: number; color: [number, number, number] }> = {
  // Low-vision palette: roads a dark cyan-grey, walkways mid cyan, steps yellow (like stair nosings), crossings white.
  road: { width: 5, lift: 0.01, color: [0.03, 0.1, 0.11] },
  footway: { width: 1.8, lift: 0.03, color: [0.0, 0.42, 0.48] },
  sidewalk: { width: 1.6, lift: 0.03, color: [0.0, 0.42, 0.48] },
  path: { width: 1.5, lift: 0.03, color: [0.0, 0.3, 0.35] },
  steps: { width: 1.8, lift: 0.04, color: [1.0, 0.83, 0.0] },
  crossing: { width: 2.2, lift: 0.05, color: [0.95, 0.97, 0.97] },
};
const STRIPE_M = 0.6;
const TREAD_M = 0.32;

/** Walkable ways as flat ribbons with vertex colors: roads darker, crossings striped. */
export function waysGeometry(ways: readonly WayX[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];

  const quad = (a: Vec2, b: Vec2, nx: number, ny: number, half: number, lift: number, c: [number, number, number]) => {
    const ax1 = a.x + nx * half, ay1 = a.y + ny * half;
    const ax2 = a.x - nx * half, ay2 = a.y - ny * half;
    const bx1 = b.x + nx * half, by1 = b.y + ny * half;
    const bx2 = b.x - nx * half, by2 = b.y - ny * half;
    // Ribbon follows the ground along its length (the ends are close enough together to be flat across).
    const ya = groundAt(a) + lift;
    const yb = groundAt(b) + lift;
    pos.push(ax1, ya, -ay1, ax2, ya, -ay2, bx2, yb, -by2);
    pos.push(ax1, ya, -ay1, bx2, yb, -by2, bx1, yb, -by1);
    for (let i = 0; i < 6; i++) col.push(c[0], c[1], c[2]);
  };

  for (const w of ways) {
    const style = WAY_STYLE[w.kind];
    const pts = densify(w.pts);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.05) continue;
      const dx = (b.x - a.x) / len;
      const dy = (b.y - a.y) / len;
      const nx = -dy;
      const ny = dx;
      if (w.kind === 'crossing' || w.kind === 'steps') {
        // zebra crossing, or stair treads: alternate painted and bare stripes along the way
        const stripe = w.kind === 'steps' ? TREAD_M : STRIPE_M;
        for (let s = 0; s < len; s += stripe * 2) {
          const e = Math.min(len, s + stripe);
          quad({ x: a.x + dx * s, y: a.y + dy * s }, { x: a.x + dx * e, y: a.y + dy * e }, nx, ny, style.width / 2, style.lift, style.color);
        }
      } else {
        quad(a, b, nx, ny, style.width / 2, style.lift, style.color);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/** Tube along a ground polyline (the active route). */
export function routeTube(line: readonly Vec2[], radius: number, height = 0.35): THREE.TubeGeometry | null {
  // Drop repeated points: a zero-length span breaks the curve's frames.
  const pts: THREE.Vector3[] = [];
  for (const p of densify(line)) {
    const v = new THREE.Vector3(p.x, groundAt(p) + height, -p.y);
    if (!pts.length || pts[pts.length - 1].distanceToSquared(v) > 0.01) pts.push(v);
  }
  if (pts.length < 2) return null;
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.05);
  return new THREE.TubeGeometry(curve, Math.min(3000, pts.length * 4), radius, 6, false);
}
