// The ground in x-ray mode: a faint see-through surface following the real terrain (USGS lidar), a 10 m grid draped
// over it (the old flat grid's job: a scale you can read distances from), and 3 m elevation contours, index contours brighter.

import { Line } from '@react-three/drei';
import { useEffect, useMemo, type ReactNode } from 'react';
import * as THREE from 'three';
import { currentTerrain, groundAt } from '../data/terrain';
import { useStore } from '../store';
import { densify, type P3 } from './geometry';

/** Terrain is built this far around the user (fog hides everything past ~300 m). */
const RADIUS_M = 360;
/** Rebuild when the user has moved this far (snapped to a grid). */
const ANCHOR_M = 80;
/** Grid lines every 10 m, brighter every 50 m, whatever the terrain's cell size (they follow cell edges to drape). */
const GRID_M = 10;
const SECTION_M = 50;
const SURFACE = '#00303a';
/** X-ray sees through the ground too: a faint tint gives the slope a body without hiding what is over a rise. */
const SURFACE_OPACITY = 0.35;
const GRID = '#00363f';
const SECTION = '#005966';
const CONTOUR = '#008ea0';
const INDEX_CONTOUR = '#00e5ff';
/** Lines sit this far above the surface so they never flicker into it. */
const LIFT_M = 0.06;

function useAnchor(): string {
  return useStore((s) => (s.pos ? `${Math.round(s.pos.x / ANCHOR_M)},${Math.round(s.pos.y / ANCHOR_M)}` : 'none'));
}

export function Terrain({ fallback }: { fallback: ReactNode }) {
  const terrain = currentTerrain();
  const large = useStore((s) => s.settings.largeText);
  const anchor = useAnchor();

  const built = useMemo(() => {
    const pos = useStore.getState().pos;
    if (!terrain || !pos) return null;
    const t = terrain;
    const c0 = Math.max(0, Math.floor((pos.x - RADIUS_M - t.x0) / t.cellM));
    const c1 = Math.min(t.cols - 1, Math.ceil((pos.x + RADIUS_M - t.x0) / t.cellM));
    const r0 = Math.max(0, Math.floor((pos.y - RADIUS_M - t.y0) / t.cellM));
    const r1 = Math.min(t.rows - 1, Math.ceil((pos.y + RADIUS_M - t.y0) / t.cellM));
    if (c1 - c0 < 1 || r1 - r0 < 1) return null;
    const w = c1 - c0 + 1;
    const h = r1 - r0 + 1;
    const y = (c: number, r: number) => t.heights[r * t.cols + c] - t.ref;

    // Surface: the grid's own vertices, two triangles per cell split the way groundAt interpolates.
    const verts = new Float32Array(w * h * 3);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const k = (r * w + c) * 3;
        verts[k] = t.x0 + (c0 + c) * t.cellM;
        verts[k + 1] = y(c0 + c, r0 + r);
        verts[k + 2] = -(t.y0 + (r0 + r) * t.cellM);
      }
    }
    const index: number[] = [];
    for (let r = 0; r < h - 1; r++) {
      for (let c = 0; c < w - 1; c++) {
        const i = r * w + c;
        // Counter-clockwise seen from above (scene z is −north).
        index.push(i, i + 1, i + w, i + 1, i + w + 1, i + w);
      }
    }
    const surface = new THREE.BufferGeometry();
    surface.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    surface.setIndex(index);

    // Grid lines along the mesh edges.
    const grid: number[] = [];
    const section: number[] = [];
    const seg = (out: number[], ca: number, ra: number, cb: number, rb: number) =>
      out.push(
        t.x0 + ca * t.cellM, y(ca, ra) + LIFT_M, -(t.y0 + ra * t.cellM),
        t.x0 + cb * t.cellM, y(cb, rb) + LIFT_M, -(t.y0 + rb * t.cellM),
      );
    const gridEvery = Math.max(1, Math.round(GRID_M / t.cellM));
    const sectionEvery = Math.max(gridEvery, Math.round(SECTION_M / t.cellM));
    const pick = (k: number) => (k % sectionEvery === 0 ? section : k % gridEvery === 0 ? grid : null);
    for (let r = r0; r <= r1; r++) {
      const out = pick(r);
      if (out) for (let c = c0; c < c1; c++) seg(out, c, r, c + 1, r);
    }
    for (let c = c0; c <= c1; c++) {
      const out = pick(c);
      if (out) for (let r = r0; r < r1; r++) seg(out, c, r, c, r + 1);
    }
    const lines = (arr: number[]) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      return g;
    };

    // Contours near the user, draped on the surface (densified so they follow it between points).
    const minX = pos.x - RADIUS_M, maxX = pos.x + RADIUS_M, minY = pos.y - RADIUS_M, maxY = pos.y + RADIUS_M;
    const contours: P3[] = [];
    const indexContours: P3[] = [];
    for (const ct of t.contours) {
      if (ct.maxX < minX || ct.minX > maxX || ct.maxY < minY || ct.minY > maxY) continue;
      const pts = densify(ct.pts, 4);
      const out = ct.index ? indexContours : contours;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        out.push([a.x, groundAt(a) + LIFT_M * 2, -a.y], [b.x, groundAt(b) + LIFT_M * 2, -b.y]);
      }
    }

    return { surface, grid: lines(grid), section: lines(section), contours, indexContours };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terrain, anchor]);

  useEffect(
    () => () => {
      built?.surface.dispose();
      built?.grid.dispose();
      built?.section.dispose();
    },
    [built],
  );

  if (!terrain) return <>{fallback}</>;
  if (!built) return null;
  return (
    <>
      {/* Translucent and not written to depth: buildings and paths beyond a rise stay visible (it is x-ray). */}
      <mesh geometry={built.surface} renderOrder={-1}>
        <meshBasicMaterial color={SURFACE} transparent opacity={SURFACE_OPACITY} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <lineSegments geometry={built.grid}>
        <lineBasicMaterial color={GRID} />
      </lineSegments>
      <lineSegments geometry={built.section}>
        <lineBasicMaterial color={SECTION} />
      </lineSegments>
      {built.contours.length > 0 && <Line points={built.contours} segments color={CONTOUR} lineWidth={large ? 2 : 1.2} transparent opacity={0.8} fog />}
      {built.indexContours.length > 0 && (
        <Line points={built.indexContours} segments color={INDEX_CONTOUR} lineWidth={large ? 3 : 2} transparent opacity={0.9} fog />
      )}
    </>
  );
}
