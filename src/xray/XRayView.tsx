// X-ray mode: a wireframe of the surroundings from OpenStreetMap that follows the phone's orientation,
// so the user can "see through" walls. Low-vision palette on black: yellow for the big structures (buildings) and
// hazards, cyan for the ground layer (walkways, terrain, features), white for the route, target and the user's building.

import { Line } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { HELPFUL_KINDS, REPORT_LABELS, type ReportDTO } from '../../shared/reports';
import { buildingsWithin, featuresWithin, toLocal, type FeatureX } from '../data/pack';
import type { FeatureKind } from '../data/types';
import { angleDiff, bearingENU, dist, type Vec2 } from '../geo';
import { orientation } from '../sensors/orientation';
import { useStore } from '../store';
import { distanceShort } from '../units';
import { groundAt } from '../data/terrain';
import { BACKGROUND, GroundGrid, HAZE, RouteArrows, SkyDome } from './extras';
import { buildingBase, buildingEdgePoints, buildingTop, EYE_HEIGHT_M, floorLinePoints, floorOutline, routeTube, toScene, wallsGeometry, waysGeometry, type P3 } from './geometry';
import { advanceGlide, shown } from './glide';
import { labelTexture } from './labels';
import { Terrain } from './terrain';

const RAD = Math.PI / 180;
/** Buildings, and hazard reports (caution yellow). */
const LINE = '#ffd400';
/** The building the user is in. */
const WHITE = '#ffffff';
/** Where to go: route, target, distance. White, so it stands apart from yellow buildings and cyan ground. */
const ACCENT = '#ffffff';
/** The ground layer's cyan: the route's glow and the next-turn beacon. */
const CYAN = '#00e5ff';
/** Helpful things (exits, ramps, automatic doors): a lighter cyan, distinct from building lines. */
const OK = '#7ff6ff';
/** Storey lines are only drawn this close: further away they would just be noise. */
const FLOOR_LINE_RANGE_M = 130;
const BUILDING_RANGE_M = 250;
const FEATURE_RANGE_M = 80;
const FEATURE_LABEL_RANGE_M = 40;
const BUILDING_LABEL_RANGE_M = 150;

/** Position snapped to a grid, as a string key: geometry that depends on "what is near" rebuilds only when it changes. */
function useAnchor(gridM: number): string {
  return useStore((s) => (s.pos ? `${Math.round(s.pos.x / gridM)},${Math.round(s.pos.y / gridM)}` : 'none'));
}

function useDisposable<T extends { dispose(): void } | null>(value: T): T {
  useEffect(() => () => value?.dispose(), [value]);
  return value;
}

// ---------------------------------------------------------------------------------------------- camera

function CameraRig() {
  const { camera } = useThree();
  const scratch = useMemo(
    () => ({
      euler: new THREE.Euler(),
      q: new THREE.Quaternion(),
      screen: new THREE.Quaternion(),
      // −90° about X: the device's "screen up" frame → the camera's "look through the back" frame
      tilt: new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2),
      zAxis: new THREE.Vector3(0, 0, 1),
      target: new THREE.Vector3(),
    }),
    [],
  );
  const placed = useRef(false);
  const perf = useRef({ frames: 0, time: 0, slowWindows: 0 });

  useFrame((_, dt) => {
    // Follow the glided position (see glide.ts), not the raw estimate, so walking looks continuous.
    advanceGlide(dt);
    // Eye height above the ground under the user (terrain), so hills rise and fall around them. Indoors, above the
    // building's floor, which on a slope can be higher than the ground beneath it.
    if (shown.ready) {
      const { pack, buildingId } = useStore.getState();
      const inside = buildingId ? pack?.buildingById.get(buildingId) : undefined;
      const floor = inside ? Math.max(groundAt(shown), buildingBase(inside)) : groundAt(shown);
      camera.position.set(shown.x, floor + EYE_HEIGHT_M, -shown.y);
    }

    // Standard deviceorientation → camera quaternion. Without a sensor, look level along the known heading.
    const o = orientation;
    const alpha = o.has ? o.alpha : 0;
    const beta = o.has ? o.beta : 90;
    const gamma = o.has ? o.gamma : 0;
    scratch.euler.set(beta * RAD, alpha * RAD, -gamma * RAD, 'YXZ');
    scratch.q.setFromEuler(scratch.euler);
    scratch.q.multiply(scratch.tilt);
    scratch.q.multiply(scratch.screen.setFromAxisAngle(scratch.zAxis, -o.screen * RAD));
    camera.quaternion.slerp(scratch.q, 1 - Math.exp(-dt * 14));

    // Frame-rate watchdog: three slow seconds in a row switch to the lighter scene.
    const p = perf.current;
    p.frames++;
    p.time += dt;
    if (p.time >= 1) {
      const fps = p.frames / p.time;
      p.slowWindows = fps < 40 ? p.slowWindows + 1 : 0;
      p.frames = 0;
      p.time = 0;
      if (p.slowWindows >= 3 && !useStore.getState().lowPerf) useStore.setState({ lowPerf: true });
    }
  });
  return null;
}

// ---------------------------------------------------------------------------------------------- labels

function Label({
  text,
  position,
  color = WHITE,
  size = 0.045,
  emphasis = false,
}: {
  text: string;
  position: P3;
  color?: string;
  size?: number;
  emphasis?: boolean;
}) {
  const large = useStore((s) => s.settings.largeText);
  const { texture, aspect } = useMemo(() => labelTexture(text, color, emphasis), [text, color, emphasis]);
  const h = size * (large ? 1.6 : 1);
  return (
    <sprite position={position} scale={[h * aspect, h, 1]} renderOrder={10}>
      <spriteMaterial map={texture} sizeAttenuation={false} depthTest={false} depthWrite={false} transparent fog={false} />
    </sprite>
  );
}

// ---------------------------------------------------------------------------------------------- buildings

function Buildings() {
  const pack = useStore((s) => s.pack);
  const buildingId = useStore((s) => s.buildingId);
  const large = useStore((s) => s.settings.largeText);
  const anchor = useAnchor(40);

  const near = useMemo(() => {
    const pos = useStore.getState().pos;
    if (!pack || !pos) return [];
    return buildingsWithin(pack, pos, BUILDING_RANGE_M);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pack, anchor]);

  const others = useMemo(() => near.filter((b) => b.id !== buildingId), [near, buildingId]);
  const edges = useMemo(() => {
    const pts: P3[] = [];
    for (const b of others) buildingEdgePoints(b, pts);
    return pts;
  }, [others]);
  const walls = useDisposable(useMemo(() => wallsGeometry(others), [others]));
  const storeys = useMemo(() => {
    const pos = useStore.getState().pos;
    const pts: P3[] = [];
    if (!pos) return pts;
    for (const b of others) if (dist(pos, b.centroid) - Math.sqrt(b.area) / 2 < FLOOR_LINE_RANGE_M) floorLinePoints(b, pts);
    return pts;
  }, [others]);

  const containing = buildingId ? pack?.buildingById.get(buildingId) : undefined;
  const containingEdges = useMemo(() => (containing ? buildingEdgePoints(containing) : []), [containing]);
  const floor = useMemo(
    () => (containing ? [containing.outer, ...containing.holes].map((r) => floorOutline(r, buildingBase(containing))) : []),
    [containing],
  );

  return (
    <>
      {edges.length > 0 && <Line points={edges} segments color={LINE} lineWidth={large ? 3 : 2} transparent opacity={0.9} fog />}
      {storeys.length > 0 && <Line points={storeys} segments color={LINE} lineWidth={1} transparent opacity={0.3} fog />}
      <mesh geometry={walls}>
        <meshBasicMaterial color={LINE} transparent opacity={0.07} depthWrite={false} side={THREE.FrontSide} />
      </mesh>
      {/* The building the user is in: brighter edges plus its floor outline. */}
      {containingEdges.length > 0 && <Line points={containingEdges} segments color={WHITE} lineWidth={large ? 5 : 3.5} />}
      {floor.map((ring, i) => (
        <Line key={i} points={ring} color={WHITE} lineWidth={large ? 7 : 5} transparent opacity={0.55} />
      ))}
    </>
  );
}

function BuildingLabels() {
  const pack = useStore((s) => s.pack);
  const anchor = useAnchor(20);
  const labels = useMemo(() => {
    const pos = useStore.getState().pos;
    if (!pack || !pos) return [];
    return buildingsWithin(pack, pos, BUILDING_LABEL_RANGE_M)
      .filter((b) => b.name)
      .map((b) => ({ b, d: dist(pos, b.centroid) }))
      .filter((x) => x.d <= BUILDING_LABEL_RANGE_M)
      .sort((a, b) => a.d - b.d)
      .slice(0, 20);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pack, anchor]);
  return (
    <>
      {labels.map(({ b }) => (
        <Label key={b.id} text={b.name as string} position={[b.centroid.x, buildingTop(b) + 3, -b.centroid.y]} color={LINE} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- ground

function Ground() {
  const pack = useStore((s) => s.pack);
  const anchor = useAnchor(60);
  const geometry = useDisposable(
    useMemo(() => {
      const pos = useStore.getState().pos;
      if (!pack || !pos) return null;
      const r = BUILDING_RANGE_M;
      const near = pack.ways.filter((w) => pos.x > w.minX - r && pos.x < w.maxX + r && pos.y > w.minY - r && pos.y < w.maxY + r);
      return waysGeometry(near);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pack, anchor]),
  );
  if (!geometry) return null;
  return (
    <mesh geometry={geometry}>
      <meshBasicMaterial vertexColors side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------------------------- small features

const FEATURE_LABELS: Record<FeatureKind, string> = {
  bench: 'Bench',
  trash: 'Trash can',
  bike_parking: 'Bike rack',
  water: 'Water',
  toilets: 'Toilets',
  bus_stop: 'Bus stop',
  entrance: 'Entrance',
  picnic_table: 'Picnic table',
};

const FEATURE_COLORS: Record<FeatureKind, string> = {
  // One family (light cyan) so the scene keeps to three colors; shapes and labels tell the kinds apart.
  bench: '#7ff6ff',
  trash: '#7ff6ff',
  bike_parking: '#7ff6ff',
  water: '#7ff6ff',
  toilets: '#ffffff',
  bus_stop: '#ffd400',
  entrance: '#ffffff',
  picnic_table: '#7ff6ff',
};

// Shared primitives, created once.
const GEO = {
  bench: new THREE.BoxGeometry(1.6, 0.08, 0.5),
  benchBack: new THREE.BoxGeometry(1.6, 0.5, 0.07),
  benchLeg: new THREE.BoxGeometry(0.08, 0.36, 0.45),
  doorPanel: new THREE.PlaneGeometry(1.08, 2.1),
  trash: new THREE.CylinderGeometry(0.3, 0.26, 0.9, 10),
  bike: new THREE.TorusGeometry(0.45, 0.05, 6, 14, Math.PI),
  post: new THREE.CylinderGeometry(0.06, 0.06, 2.6, 6),
  sign: new THREE.BoxGeometry(0.5, 0.5, 0.06),
  doorPost: new THREE.BoxGeometry(0.12, 2.2, 0.12),
  doorTop: new THREE.BoxGeometry(1.32, 0.12, 0.12),
  water: new THREE.CylinderGeometry(0.18, 0.18, 1.0, 8),
  box: new THREE.BoxGeometry(0.9, 0.9, 0.9),
  table: new THREE.BoxGeometry(1.8, 0.75, 1.5),
  pyramid: new THREE.ConeGeometry(0.6, 1.3, 4),
  beam: new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1, true),
};
const materials = new Map<string, THREE.MeshBasicMaterial>();
function mat(color: string): THREE.MeshBasicMaterial {
  let m = materials.get(color);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color });
    materials.set(color, m);
  }
  return m;
}

function FeatureMesh({ f }: { f: FeatureX }) {
  const m = mat(FEATURE_COLORS[f.kind]);
  const p = toScene(f.pos);
  // Turn the object so its front (+z) faces the path it stands beside; benches then sit parallel to the path.
  const turn = f.facing === undefined ? 0 : Math.atan2(Math.cos(f.facing), -Math.sin(f.facing));
  switch (f.kind) {
    case 'bench':
      return (
        <group position={p} rotation={[0, turn, 0]}>
          <mesh geometry={GEO.bench} material={m} position={[0, 0.4, 0]} />
          <mesh geometry={GEO.benchBack} material={m} position={[0, 0.72, -0.22]} />
          <mesh geometry={GEO.benchLeg} material={m} position={[-0.65, 0.18, 0]} />
          <mesh geometry={GEO.benchLeg} material={m} position={[0.65, 0.18, 0]} />
        </group>
      );
    case 'trash':
      return <mesh geometry={GEO.trash} material={m} position={[p[0], p[1] + 0.45, p[2]]} />;
    case 'bike_parking':
      return <mesh geometry={GEO.bike} material={m} position={[p[0], p[1] + 0.02, p[2]]} rotation={[0, turn, 0]} />;
    case 'bus_stop':
      return (
        <group position={p}>
          <mesh geometry={GEO.post} material={m} position={[0, 1.3, 0]} />
          <mesh geometry={GEO.sign} material={m} position={[0, 2.5, 0]} />
        </group>
      );
    case 'entrance':
      // A door frame standing in the wall it belongs to.
      return (
        <group position={p} rotation={[0, f.wallAngle ?? 0, 0]}>
          <mesh geometry={GEO.doorPost} material={m} position={[-0.6, 1.1, 0]} />
          <mesh geometry={GEO.doorPost} material={m} position={[0.6, 1.1, 0]} />
          <mesh geometry={GEO.doorTop} material={m} position={[0, 2.2, 0]} />
          <mesh geometry={GEO.doorPanel} position={[0, 1.05, 0]}>
            <meshBasicMaterial color="#ffffff" transparent opacity={0.22} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
        </group>
      );
    case 'water':
      return <mesh geometry={GEO.water} material={m} position={[p[0], p[1] + 0.5, p[2]]} />;
    case 'toilets':
      return <mesh geometry={GEO.box} material={m} position={[p[0], p[1] + 0.45, p[2]]} />;
    case 'picnic_table':
      return <mesh geometry={GEO.table} material={m} position={[p[0], p[1] + 0.375, p[2]]} rotation={[0, turn, 0]} />;
  }
}

function Features() {
  const pack = useStore((s) => s.pack);
  const lowPerf = useStore((s) => s.lowPerf);
  const anchor = useAnchor(8);
  // When the frame rate is poor, only keep what is in front of the phone (re-evaluated as the heading changes).
  const headingKey = useStore((s) => (lowPerf && s.heading !== null ? Math.round(s.heading / 30) : 0));

  const near = useMemo(() => {
    const pos = useStore.getState().pos;
    if (!pack || !pos) return [];
    let list = featuresWithin(pack, pos, lowPerf ? FEATURE_LABEL_RANGE_M : FEATURE_RANGE_M);
    if (lowPerf) {
      list = list.filter(({ feature }) => Math.abs(angleDiff(orientation.heading, bearingENU(pos, feature.pos))) < 60);
    }
    return list.slice(0, lowPerf ? 60 : 220);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pack, anchor, lowPerf, headingKey]);

  return (
    <>
      {near.map(({ feature, dist: d }) => (
        <group key={feature.id}>
          <FeatureMesh f={feature} />
          {d <= FEATURE_LABEL_RANGE_M && (
            <Label
              text={feature.name ?? FEATURE_LABELS[feature.kind]}
              position={toScene(feature.pos, feature.kind === 'entrance' ? 2.8 : 1.7)}
              color={FEATURE_COLORS[feature.kind]}
              size={0.032}
            />
          )}
        </group>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- community reports

function ReportMarker({ report, at, onRoute }: { report: ReportDTO; at: Vec2; onRoute: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  const helpful = HELPFUL_KINDS.includes(report.kind);
  // Hazards in caution yellow; helpful reports in light cyan.
  const color = helpful ? OK : LINE;
  useFrame(({ clock }) => {
    if (!ref.current) return;
    // Reports on the active route pulse.
    const s = onRoute ? 1 + 0.35 * Math.sin(clock.elapsedTime * 6) : 1;
    ref.current.scale.setScalar(s);
  });
  return (
    <group position={toScene(at)}>
      <mesh ref={ref} geometry={GEO.pyramid} material={mat(color)} position={[0, 0.65, 0]} />
      <Label text={`${helpful ? '' : 'Warning: '}${REPORT_LABELS[report.kind]}`} position={[0, 2.1, 0]} color={color} size={0.04} emphasis />
    </group>
  );
}

function Reports() {
  const pack = useStore((s) => s.pack);
  const reports = useStore((s) => s.reports);
  const onRoute = useStore((s) => s.nav?.reportIds);
  if (!pack) return null;
  return (
    <>
      {reports.map((r) => (
        <ReportMarker key={r.id} report={r} at={toLocal(pack, r)} onRoute={onRoute?.includes(r.id) ?? false} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- route + target

function Beam({ at, color, radius, height, opacity }: { at: Vec2; color: string; radius: number; height: number; opacity: number }) {
  return (
    <mesh geometry={GEO.beam} position={[at.x, groundAt(at) + height / 2, -at.y]} scale={[radius / 0.5, height, radius / 0.5]}>
      <meshBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} side={THREE.DoubleSide} fog={false} />
    </mesh>
  );
}

function RouteLayer() {
  const nav = useStore((s) => s.nav);
  const metric = useStore((s) => s.settings.metric);
  const route = nav?.route ?? null;
  const core = useDisposable(useMemo(() => (route ? routeTube(route.line, 0.18) : null), [route]));
  const glow = useDisposable(useMemo(() => (route ? routeTube(route.line, 0.5) : null), [route]));
  if (!nav) return null;

  const nextStep = route && nav.stepIndex < route.steps.length - 1 ? route.steps[nav.stepIndex] : null;
  const exit = nav.entrance && !nav.entrance.reached ? nav.entrance.pos : null;

  return (
    <>
      {core && (
        <mesh geometry={core}>
          <meshBasicMaterial color={ACCENT} />
        </mesh>
      )}
      {glow && (
        <mesh geometry={glow}>
          <meshBasicMaterial color={CYAN} transparent opacity={0.3} depthWrite={false} />
        </mesh>
      )}
      <RouteArrows />
      {/* Beacon at the target, with its distance. */}
      <Beam at={nav.dest} color={ACCENT} radius={0.6} height={90} opacity={0.4} />
      <Label text={`${nav.label} · ${distanceShort(nav.remainingM, metric)}`} position={toScene(nav.dest, 6)} color={ACCENT} size={0.055} emphasis />
      {nextStep && <Beam at={nextStep.pos} color={CYAN} radius={0.25} height={30} opacity={0.4} />}
      {exit && (
        <>
          <Beam at={exit} color={OK} radius={0.35} height={30} opacity={0.45} />
          <Label text="Exit" position={toScene(exit, 3.2)} color={OK} emphasis />
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- accuracy ring

function SigmaRing() {
  const sigma = useStore((s) => s.sigma);
  const ref = useRef<THREE.Mesh>(null);
  const geometry = useDisposable(
    useMemo(() => {
      const r = Math.max(1, Math.min(60, sigma));
      return new THREE.RingGeometry(Math.max(0.1, r - 0.2), r, 64);
    }, [sigma]),
  );
  useFrame(() => {
    if (shown.ready && ref.current) ref.current.position.set(shown.x, groundAt(shown) + 0.08, -shown.y);
  });
  return (
    <mesh ref={ref} geometry={geometry} rotation={[-Math.PI / 2, 0, 0]}>
      <meshBasicMaterial color={WHITE} transparent opacity={0.4} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------------------------- view

/** @param active false while the camera view is showing: the scene stays built but stops redrawing every frame. */
export default function XRayView({ active }: { active: boolean }) {
  const simplify = useStore((s) => s.settings.simplify);
  const hasPos = useStore((s) => s.pos !== null);
  return (
    <div className="xray" role="img" aria-label="X-ray view: wireframe of nearby buildings, paths and your route">
      <Canvas
        frameloop={active ? 'always' : 'demand'}
        camera={{ fov: 70, near: 0.3, far: 700, position: [0, EYE_HEIGHT_M, 0] }}
        dpr={[1, 2]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        onCreated={({ gl }) => gl.setClearColor(BACKGROUND)}
      >
        <fog attach="fog" args={[HAZE, 60, 300]} />
        <SkyDome />
        <CameraRig />
        <Buildings />
        <RouteLayer />
        <SigmaRing />
        <Reports />
        {!simplify && (
          <>
            {/* Real ground when terrain data is loaded; otherwise the flat grid. */}
            <Terrain fallback={<GroundGrid />} />
            <Ground />
            <Features />
            <BuildingLabels />
          </>
        )}
      </Canvas>
      {active && !hasPos && <p className="xray-wait">Waiting for a location fix…</p>}
    </div>
  );
}
