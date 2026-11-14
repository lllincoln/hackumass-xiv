// Geometry builders for the x-ray scene. Scene axes: ENU x → x, up → y, ENU y (north) → −z.

import * as THREE from 'three';
import type { BuildingX, WayX } from '../data/pack';
import type { WayKind } from '../data/types';
import type { Vec2 } from '../geo';

export type P3 = [number, number, number];

export const EYE_HEIGHT_M = 1.6;

export function toScene(p: Vec2, height = 0): P3 {
  return [p.x, height, -p.y];
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

/** Wireframe of an extruded footprint as line-segment pairs: floor outline, roof outline, corner verticals. */
export function buildingEdgePoints(b: BuildingX, out: P3[] = []): P3[] {
  for (const ring of [b.outer, ...b.holes]) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % n];
      out.push(toScene(p, 0), toScene(q, 0));
      out.push(toScene(p, b.heightM), toScene(q, b.heightM));
      if (isCorner(ring, i)) out.push(toScene(p, 0), toScene(p, b.heightM));
    }
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
  for (let k = every; k <= storeys; k += every) {
    const h = k * STOREY_M;
    const ring = b.outer;
    for (let i = 0; i < ring.length; i++) out.push(toScene(ring[i], h), toScene(ring[(i + 1) % ring.length], h));
  }
  return out;
}

/** A closed loop (first point repeated) just above the floor, for the containing building's floor outline. */
export function floorOutline(ring: readonly Vec2[], height = 0.05): P3[] {
  const pts = ring.map((p) => toScene(p, height));
  if (pts.length) pts.push(pts[0]);
  return pts;
}

/** Outer walls of many buildings merged into one mesh. Faces point outward (outlines are counter-clockwise). */
export function wallsGeometry(buildings: readonly BuildingX[]): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const b of buildings) {
    const ring = b.outer;
    const h = b.heightM;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      // two triangles: (p0, q0, q1) and (p0, q1, p1)
      pos.push(p.x, 0, -p.y, q.x, 0, -q.y, q.x, h, -q.y);
      pos.push(p.x, 0, -p.y, q.x, h, -q.y, p.x, h, -p.y);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

const WAY_STYLE: Record<WayKind, { width: number; lift: number; color: [number, number, number] }> = {
  road: { width: 5, lift: 0.01, color: [0.085, 0.095, 0.12] },
  footway: { width: 1.8, lift: 0.03, color: [0.2, 0.3, 0.42] },
  sidewalk: { width: 1.6, lift: 0.03, color: [0.2, 0.3, 0.42] },
  path: { width: 1.5, lift: 0.03, color: [0.16, 0.24, 0.34] },
  steps: { width: 1.8, lift: 0.04, color: [0.95, 0.6, 0.25] },
  crossing: { width: 2.2, lift: 0.05, color: [0.9, 0.92, 0.95] },
};
const STRIPE_M = 0.6;
const TREAD_M = 0.32;

/** Walkable ways as flat ribbons with vertex colors: roads darker, crossings striped. */
export function waysGeometry(ways: readonly WayX[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];

  const quad = (a: Vec2, b: Vec2, nx: number, ny: number, half: number, y: number, c: [number, number, number]) => {
    const ax1 = a.x + nx * half, ay1 = a.y + ny * half;
    const ax2 = a.x - nx * half, ay2 = a.y - ny * half;
    const bx1 = b.x + nx * half, by1 = b.y + ny * half;
    const bx2 = b.x - nx * half, by2 = b.y - ny * half;
    pos.push(ax1, y, -ay1, ax2, y, -ay2, bx2, y, -by2);
    pos.push(ax1, y, -ay1, bx2, y, -by2, bx1, y, -by1);
    for (let i = 0; i < 6; i++) col.push(c[0], c[1], c[2]);
  };

  for (const w of ways) {
    const style = WAY_STYLE[w.kind];
    for (let i = 0; i < w.pts.length - 1; i++) {
      const a = w.pts[i];
      const b = w.pts[i + 1];
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
  for (const p of line) {
    const v = new THREE.Vector3(p.x, height, -p.y);
    if (!pts.length || pts[pts.length - 1].distanceToSquared(v) > 0.01) pts.push(v);
  }
  if (pts.length < 2) return null;
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.05);
  return new THREE.TubeGeometry(curve, Math.min(3000, pts.length * 4), radius, 6, false);
}
