// Scene dressing for x-ray mode: the things that give the wireframe depth and a sense of direction.
// A horizon glow, a ground grid that fades with distance, and arrows that flow along the route in the direction of travel.

import { Grid } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { groundAt } from '../data/terrain';
import { pointAlong } from '../geo';
import { useStore } from '../store';
import { shown } from './glide';

export const BACKGROUND = '#000000';
/** Distant geometry fades into this. Slightly lifted from pure black so far buildings sink back instead of vanishing abruptly. */
export const HAZE = '#000000';
const HORIZON = '#00262c';

/** A dome with a soft glow at the horizon, so there is always a visible line between ground and sky. */
export function SkyDome() {
  const ref = useRef<THREE.Mesh>(null);
  const { camera } = useThree();
  const geometry = useMemo(() => {
    const g = new THREE.SphereGeometry(650, 32, 24);
    const pos = g.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    const top = new THREE.Color(BACKGROUND);
    const horizon = new THREE.Color(HORIZON);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      // 0 at the horizon → 1 a third of the way up; below the horizon stays dark.
      const h = pos.getY(i) / 650;
      const t = h < 0 ? Math.min(1, -h * 6) : Math.min(1, h * 3);
      c.copy(horizon).lerp(top, Math.sqrt(t));
      colors.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  }, []);
  useFrame(() => ref.current?.position.copy(camera.position));
  return (
    <mesh ref={ref} geometry={geometry} renderOrder={-10} frustumCulled={false}>
      <meshBasicMaterial vertexColors side={THREE.BackSide} depthWrite={false} depthTest={false} fog={false} />
    </mesh>
  );
}

/** 5 m cells, 25 m sections: gives the ground a scale you can read distances from. */
export function GroundGrid() {
  return (
    <Grid
      position={[0, -0.02, 0]}
      infiniteGrid
      followCamera
      cellSize={5}
      cellThickness={0.6}
      cellColor="#00363f"
      sectionSize={25}
      sectionThickness={1}
      sectionColor="#005966"
      fadeDistance={150}
      fadeStrength={1.6}
    />
  );
}

const ARROWS = 22;
const ARROW_SPACING_M = 5;
const ARROW_SPEED_MPS = 3;
/** Just above the route tube and its glow, so the chevrons are never buried in it. */
const ARROW_HEIGHT_M = 0.9;
const UP = new THREE.Vector3(0, 1, 0);

/** Chevrons that stream along the route ahead of the user: the direction of travel is visible at a glance. */
export function RouteArrows() {
  const route = useStore((s) => s.nav?.route ?? null);
  const ref = useRef<THREE.InstancedMesh>(null);
  const geometry = useMemo(() => {
    // A flat chevron lying on the ground like a road marking, pointing along local −Z.
    // (A cone turned to face the route direction has no defined roll, so it showed up edge-on or twisted.)
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.75);
    shape.lineTo(0.8, -0.1);
    shape.lineTo(0.8, -0.65);
    shape.lineTo(0, 0.2);
    shape.lineTo(-0.8, -0.65);
    shape.lineTo(-0.8, -0.1);
    shape.closePath();
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);
  const scratch = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), dir: new THREE.Vector3(), p: new THREE.Vector3(), s: new THREE.Vector3() }), []);

  useFrame(({ clock }) => {
    const mesh = ref.current;
    const nav = useStore.getState().nav;
    if (!mesh || !nav?.route) return;
    const r = nav.route;
    const start = Math.max(0, r.totalM - nav.remainingM);
    const span = ARROWS * ARROW_SPACING_M;
    const flow = (clock.elapsedTime * ARROW_SPEED_MPS) % ARROW_SPACING_M;
    for (let i = 0; i < ARROWS; i++) {
      const offset = i * ARROW_SPACING_M + flow;
      const s = start + offset;
      const a = pointAlong(r.line, r.cum, s);
      const b = pointAlong(r.line, r.cum, s + 0.5);
      scratch.dir.set(b.x - a.x, 0, -(b.y - a.y));
      // Fade in just ahead of the user and out at the far end; hide anything past the destination.
      const edge = Math.min(1, offset / 6, (span - offset) / 15);
      const visible = s < r.totalM - 1 && scratch.dir.lengthSq() > 1e-6;
      const k = visible ? Math.max(0, edge) : 0;
      // Turn about the vertical axis only, so the chevron stays flat and its point leads.
      scratch.q.setFromAxisAngle(UP, Math.atan2(-scratch.dir.x, -scratch.dir.z));
      scratch.p.set(a.x, groundAt(a) + ARROW_HEIGHT_M, -a.y);
      scratch.s.setScalar(k);
      mesh.setMatrixAt(i, scratch.m.compose(scratch.p, scratch.q, scratch.s));
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  if (!route) return null;
  return (
    <instancedMesh ref={ref} args={[geometry, undefined, ARROWS]} frustumCulled={false} renderOrder={5}>
      <meshBasicMaterial color="#00e5ff" transparent opacity={0.95} depthWrite={false} depthTest={false} side={THREE.DoubleSide} fog={false} />
    </instancedMesh>
  );
}
