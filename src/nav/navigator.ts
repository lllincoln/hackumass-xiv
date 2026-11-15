// Navigation: fetch a route, track progress along it, announce maneuvers, reroute, and publish the bearing to face.

import { BLOCKING_KINDS, REPORT_LABELS, type ReportDTO } from '../../shared/reports';
import { toLocal, toLonLat, type BuildingX, type FeatureX, type PackIndex } from '../data/pack';
import {
  angleDiff,
  bearingENU,
  relativeWords,
  cumulativeLengths,
  dist,
  pointAlong,
  projectOnPolyline,
  type LonLat,
  type Vec2,
} from '../geo';
import { reportsApi } from '../reports/api';
import { orientation } from '../sensors/orientation';
import { useStore, type NavState, type NavStep, type RouteX } from '../store';
import { announce } from './announce';
import { instructionFor, metersPhrase } from './instructions';
import { getRoutes, type OsrmRoute } from './osrm';

const CARROT_M = 12;
const ANNOUNCE_FAR_M = 25;
const ANNOUNCE_NEAR_M = 8;
const ARRIVE_M = 10;
const POINT_ARRIVE_M = 4;
const OFF_ROUTE_M = 25;
const OFF_ROUTE_MS = 8000;
const ENTRANCE_REACHED_M = 5;
/** A queued turn instruction older than this is out of date (the user kept walking); drop it. */
const NAV_MAX_AGE_MS = 20_000;

export type Destination = { ll: LonLat; label: string; buildingId?: string };

export type StartResult =
  | {
      ok: true;
      mode: 'route';
      total_distance: string;
      duration_min: number;
      first_steps: string[];
      exit_first?: string;
      notes?: string[];
    }
  | { ok: true; mode: 'bearing_only'; distance: string; direction: string; note: string }
  | { ok: false; error: string };

let saidFar = new Set<number>();
let saidNear = new Set<number>();
let offRouteSince: number | null = null;
let rerouting = false;
let lastRerouteAt = 0;
/** Bumped whenever guidance starts or stops, so late async results for an old request are dropped. */
let generation = 0;

function resetProgress(): void {
  saidFar = new Set();
  saidNear = new Set();
  offRouteSince = null;
}

export function buildRoute(index: PackIndex, r: OsrmRoute): RouteX {
  const coords = r.geometry.coordinates;
  const line = coords.map((c) => toLocal(index, { lon: c[0], lat: c[1] }));
  const cum = cumulativeLengths(line);
  const totalM = cum[cum.length - 1];
  // Step distances add up to the route distance; rescale them onto our projected polyline.
  const scale = r.distance > 0 ? totalM / r.distance : 1;
  const steps: NavStep[] = [];
  let travelled = 0;
  for (const leg of r.legs) {
    for (const step of leg.steps) {
      const s = Math.min(totalM, travelled * scale);
      steps.push({
        text: instructionFor(step),
        s,
        pos: pointAlong(line, cum, s),
        type: step.maneuver.type,
        modifier: step.maneuver.modifier,
        name: step.name ?? '',
      });
      travelled += step.distance;
    }
  }
  return { line, cum, coords, totalM, durationS: r.duration, steps };
}

/** The door to leave through: shortest walk to the door plus straight line from there to the destination. */
function pickExit(b: BuildingX, pos: Vec2, dest: Vec2): FeatureX | null {
  let best: FeatureX | null = null;
  let bestCost = Infinity;
  for (const e of b.entrances) {
    const cost = dist(pos, e.pos) + dist(e.pos, dest);
    if (cost < bestCost) {
      best = e;
      bestCost = cost;
    }
  }
  return best;
}

/** When the destination is a building, aim for its door nearest the start, not its centroid. */
function refineDestination(index: PackIndex, dest: Destination, from: Vec2): LonLat {
  const b = dest.buildingId ? index.buildingById.get(dest.buildingId) : undefined;
  if (!b || b.entrances.length === 0) return dest.ll;
  let best = b.entrances[0];
  for (const e of b.entrances) if (dist(from, e.pos) < dist(from, best.pos)) best = e;
  return { lon: best.lon, lat: best.lat };
}

/** "straight ahead", "on your left", "behind you"… from where the phone points. Never compass words. */
function relativeDirection(from: Vec2, to: Vec2): string {
  return orientation.has ? relativeWords(angleDiff(orientation.heading, bearingENU(from, to))) : 'in a direction the compass cannot tell yet';
}

function setNav(nav: NavState | null): void {
  useStore.setState({ nav });
}

async function chooseRoute(routes: OsrmRoute[]): Promise<{ route: OsrmRoute; reports: ReportDTO[]; note?: string }> {
  const check = async (r: OsrmRoute) => reportsApi.alongRoute(r.geometry.coordinates).catch(() => [] as ReportDTO[]);
  const blocking = (list: ReportDTO[]) => list.filter((x) => BLOCKING_KINDS.includes(x.kind));

  const first = await check(routes[0]);
  const blockers = blocking(first);
  if (blockers.length === 0) return { route: routes[0], reports: first };

  const why = `${REPORT_LABELS[blockers[0].kind]} reported on the usual route`;
  for (const alt of routes.slice(1)) {
    const reports = await check(alt);
    if (blocking(reports).length === 0) {
      return { route: alt, reports, note: `Taking a different route because of ${why}: ${blockers[0].description}` };
    }
  }
  return {
    route: routes[0],
    reports: first,
    note: `Warning: ${why} and there is no other route: ${blockers[0].description}`,
  };
}

export async function startNavigation(dest: Destination): Promise<StartResult> {
  const { pack, pos, buildingId } = useStore.getState();
  if (!pack) return { ok: false, error: 'Map data is not loaded yet.' };
  if (!pos) return { ok: false, error: 'Position is not known yet. Ask the user to wait for a location fix.' };

  const gen = ++generation;
  resetProgress();

  const destLL = refineDestination(pack, dest, pos);
  const destPos = toLocal(pack, destLL);

  // Indoors: route from the exit door, and guide the user to that door first.
  const building = buildingId ? pack.buildingById.get(buildingId) : undefined;
  const exit = building && building.id !== dest.buildingId ? pickExit(building, pos, destPos) : null;
  const fromLL = exit ? { lon: exit.lon, lat: exit.lat } : toLonLat(pack, pos);

  let routes: OsrmRoute[];
  try {
    routes = await getRoutes(fromLL, destLL);
  } catch (err) {
    console.warn('[nav] routing failed', err);
    if (gen !== generation) return { ok: false, error: 'Navigation was replaced by a newer request.' };
    const res = pointTo({ ...dest, ll: destLL });
    return {
      ok: true,
      mode: 'bearing_only',
      distance: res.ok ? res.distance : '',
      direction: res.ok ? res.direction : '',
      note: 'Directions are unavailable right now. Bearing-only guidance is on: the ticking sound points straight at the destination.',
    };
  }
  if (gen !== generation) return { ok: false, error: 'Navigation was replaced by a newer request.' };

  const chosen = await chooseRoute(routes);
  if (gen !== generation) return { ok: false, error: 'Navigation was replaced by a newer request.' };

  const route = buildRoute(pack, chosen.route);
  const entrance = exit && building ? { pos: exit.pos, buildingId: building.id, reached: dist(pos, exit.pos) < ENTRANCE_REACHED_M } : null;

  setNav({
    kind: 'route',
    label: dest.label,
    dest: destPos,
    destLL,
    route,
    entrance,
    stepIndex: Math.min(1, route.steps.length - 1),
    remainingM: Math.round(route.totalM),
    targetBearing: null,
    reportIds: chosen.reports.map((r) => r.id),
  });
  tick();

  const notes: string[] = [];
  if (chosen.note) notes.push(chosen.note);
  for (const r of chosen.reports.filter((x) => !BLOCKING_KINDS.includes(x.kind))) {
    notes.push(`On the route: ${REPORT_LABELS[r.kind]}. ${r.description}`);
  }

  return {
    ok: true,
    mode: 'route',
    total_distance: metersPhrase(route.totalM),
    duration_min: Math.max(1, Math.round(route.durationS / 60)),
    first_steps: route.steps.slice(0, 5).map((s) => s.text),
    // Which way to start walking, relative to the phone (the first instruction itself names no direction).
    ...(!entrance || entrance.reached ? { start_direction: relativeDirection(pos, pointAlong(route.line, route.cum, Math.min(10, route.totalM))) } : {}),
    ...(entrance && !entrance.reached
      ? { exit_first: `First leave the building: the exit door is ${metersPhrase(dist(pos, entrance.pos))} away, ${relativeDirection(pos, entrance.pos)}.` }
      : {}),
    ...(notes.length ? { notes: notes.slice(0, 4) } : {}),
  };
}

export function pointTo(dest: Destination): { ok: true; distance: string; direction: string } | { ok: false; error: string } {
  const { pack, pos } = useStore.getState();
  if (!pack) return { ok: false, error: 'Map data is not loaded yet.' };
  if (!pos) return { ok: false, error: 'Position is not known yet.' };
  generation++;
  resetProgress();
  const target = toLocal(pack, dest.ll);
  setNav({
    kind: 'point',
    label: dest.label,
    dest: target,
    destLL: dest.ll,
    route: null,
    entrance: null,
    stepIndex: 0,
    remainingM: Math.round(dist(pos, target)),
    targetBearing: bearingENU(pos, target),
    reportIds: [],
  });
  return { ok: true, distance: metersPhrase(dist(pos, target)), direction: relativeDirection(pos, target) };
}

export function stopNavigation(): boolean {
  generation++;
  resetProgress();
  const had = useStore.getState().nav !== null;
  setNav(null);
  return had;
}

async function reroute(): Promise<void> {
  const { pack, pos, nav } = useStore.getState();
  if (!pack || !pos || !nav || nav.kind !== 'route' || rerouting) return;
  rerouting = true;
  lastRerouteAt = Date.now();
  const gen = generation;
  announce('Rerouting.', 'Navigation update', { key: 'nav', maxAgeMs: NAV_MAX_AGE_MS });
  try {
    const routes = await getRoutes(toLonLat(pack, pos), nav.destLL, { fresh: true });
    if (gen !== generation) return;
    const chosen = await chooseRoute(routes);
    if (gen !== generation) return;
    const route = buildRoute(pack, chosen.route);
    resetProgress();
    const current = useStore.getState().nav;
    if (!current) return;
    setNav({ ...current, route, entrance: null, stepIndex: Math.min(1, route.steps.length - 1), reportIds: chosen.reports.map((r) => r.id) });
    tick();
    const next = route.steps[0];
    if (next) announce(`${next.text}. ${metersPhrase(route.totalM)} to go.`, 'Navigation update', { key: 'nav', maxAgeMs: NAV_MAX_AGE_MS });
  } catch (err) {
    console.warn('[nav] reroute failed', err);
    // Keep the old route and ticks; try again after the debounce.
  } finally {
    rerouting = false;
    offRouteSince = null;
  }
}

function sameNav(a: NavState, b: NavState): boolean {
  return (
    a.stepIndex === b.stepIndex &&
    a.remainingM === b.remainingM &&
    a.targetBearing === b.targetBearing &&
    a.entrance?.reached === b.entrance?.reached
  );
}

/** Recompute progress for the current position. Called on every position change. */
export function tick(now = Date.now()): void {
  const { pos, nav, buildingId } = useStore.getState();
  if (!pos || !nav) return;

  if (nav.kind === 'point' || !nav.route) {
    const d = dist(pos, nav.dest);
    if (d <= POINT_ARRIVE_M) {
      announce(`${nav.label} is right here.`, 'Navigation update', { key: 'nav' });
      stopNavigation();
      return;
    }
    const next = { ...nav, remainingM: Math.round(d), targetBearing: Math.round(bearingENU(pos, nav.dest)) };
    if (!sameNav(nav, next)) setNav(next);
    return;
  }

  const route = nav.route;

  // Phase 1 (indoors): walk to the exit door before following the route.
  if (nav.entrance && !nav.entrance.reached) {
    const d = dist(pos, nav.entrance.pos);
    const left = buildingId !== nav.entrance.buildingId;
    if (d <= ENTRANCE_REACHED_M || left) {
      setNav({ ...nav, entrance: { ...nav.entrance, reached: true } });
      const first = route.steps[0];
      if (first) announce(`You are at the exit. ${first.text}.`, 'Navigation update', { key: 'nav', maxAgeMs: NAV_MAX_AGE_MS });
      tick(now);
      return;
    }
    const next = { ...nav, remainingM: Math.round(route.totalM + d), targetBearing: Math.round(bearingENU(pos, nav.entrance.pos)) };
    if (!sameNav(nav, next)) setNav(next);
    return;
  }

  const proj = projectOnPolyline(pos, route.line, route.cum);
  const remaining = route.totalM - proj.along;

  if (dist(pos, nav.dest) <= ARRIVE_M || (remaining <= ARRIVE_M && proj.dist <= 15)) {
    announce(`You have arrived at ${nav.label}.`, 'Navigation update', { key: 'nav' });
    stopNavigation();
    return;
  }

  // Next maneuver = first step still ahead of us.
  let stepIndex = route.steps.length - 1;
  for (let i = 1; i < route.steps.length; i++) {
    if (route.steps[i].s > proj.along - 2) {
      stepIndex = i;
      break;
    }
  }
  const step = route.steps[stepIndex];
  const isArrival = stepIndex === route.steps.length - 1;
  if (step && proj.dist <= OFF_ROUTE_M) {
    const d = step.s - proj.along;
    if (d <= ANNOUNCE_NEAR_M && !saidNear.has(stepIndex)) {
      saidNear.add(stepIndex);
      saidFar.add(stepIndex);
      if (!isArrival) announce(`${step.text} now.`, 'Navigation update', { key: 'nav', maxAgeMs: NAV_MAX_AGE_MS });
    } else if (d <= ANNOUNCE_FAR_M && d > ANNOUNCE_NEAR_M + 4 && !saidFar.has(stepIndex)) {
      saidFar.add(stepIndex);
      announce(
        isArrival ? `In ${metersPhrase(d)}, you will arrive at ${nav.label}.` : `In ${metersPhrase(d)}, ${lowerFirst(step.text)}.`,
        'Navigation update',
        { key: 'nav', maxAgeMs: NAV_MAX_AGE_MS },
      );
    }
  }

  // Off-route for long enough → reroute.
  if (proj.dist > OFF_ROUTE_M) {
    offRouteSince ??= now;
    if (now - offRouteSince > OFF_ROUTE_MS && !rerouting && now - lastRerouteAt > OFF_ROUTE_MS) void reroute();
  } else {
    offRouteSince = null;
  }

  // Face a "carrot" a little way ahead along the route, not the final destination.
  const carrot = pointAlong(route.line, route.cum, proj.along + CARROT_M);
  const next = { ...nav, stepIndex, remainingM: Math.round(remaining), targetBearing: Math.round(bearingENU(pos, carrot)) };
  if (!sameNav(nav, next)) setNav(next);
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

let unsubscribe: (() => void) | null = null;

export function startNavigator(): () => void {
  if (unsubscribe) return unsubscribe;
  const off = useStore.subscribe((s, prev) => {
    if (s.nav && (s.pos !== prev.pos || s.buildingId !== prev.buildingId)) tick();
  });
  // Off-route timing must advance even when the estimate is not moving.
  const timer = setInterval(() => {
    if (useStore.getState().nav) tick();
  }, 2000);
  unsubscribe = () => {
    off();
    clearInterval(timer);
    unsubscribe = null;
  };
  return unsubscribe;
}
