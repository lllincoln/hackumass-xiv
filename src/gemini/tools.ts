// Tool execution. Tools run on the client because they need the live position, heading, route and data pack.
// Every tool returns compact JSON; failures come back as `{ error }` so the model can tell the user.

import type { FunctionCall } from '@google/genai';
import { FEATURE_KINDS } from '../../shared/agent';
import { PERMANENT_KINDS, REPORT_KINDS, REPORT_LABELS, type ReportKind } from '../../shared/reports';
import { searchPlaces } from '../data/gazetteer';
import { elevationAt } from '../data/terrain';
import { buildingsAlongRay, buildingsWithin, featuresWithin, nearestFeatures, toLocal, toLonLat, type BuildingX, type PackIndex } from '../data/pack';
import type { FeatureKind } from '../data/types';
import { angleDiff, bearingENU, dist, norm360, projectOnRing, relativeWords, ringGap, type LonLat, type Vec2 } from '../geo';
import { pointTo, startNavigation, stopNavigation, type Destination } from '../nav/navigator';
import { reportsApi } from '../reports/api';
import { markOwnReport, removeReport, upsertReport } from '../reports/watcher';
import { orientation } from '../sensors/orientation';
import { useStore } from '../store';
import { distancePhrase, unitName } from '../units';
import { live } from './session';

type Args = Record<string, unknown>;
type Result = Record<string, unknown>;

const FEATURE_NAMES: Record<string, string> = {
  bench: 'bench',
  trash: 'trash can',
  bike_parking: 'bike parking',
  water: 'drinking water',
  toilets: 'toilets',
  bus_stop: 'bus stop',
  entrance: 'entrance',
  picnic_table: 'picnic table',
};

const XRAY_HALF_FOV_DEG = 35;
const XRAY_RANGE_M = 80;
const LINE_RANGE_M = 400;
const LINE_MAX_M = 800;
const AROUND_RADIUS_M = 150;
const AROUND_MAX_M = 400;
/** Buildings this close count as next to each other (attached, or across a narrow gap). */
const ADJACENT_M = 8;

class ToolError extends Error {}

function need(): { pack: PackIndex; pos: Vec2 } {
  const { pack, pos } = useStore.getState();
  if (!pack) throw new ToolError('Map data is not loaded yet.');
  if (!pos) throw new ToolError('Position is not known yet. Ask the user to wait a moment for a location fix.');
  return { pack, pos };
}

/**
 * Distance plus direction from the user to a point, relative to where the phone points ("straight ahead",
 * "ahead, on your left", "behind you"). Never compass words: the user cannot use "southeast".
 */
function whereIs(pos: Vec2, target: Vec2): { distance: string; direction: string } {
  return {
    distance: distancePhrase(dist(pos, target)),
    direction: orientation.has ? relativeWords(angleDiff(orientation.heading, bearingENU(pos, target))) : 'unknown until the compass settles',
  };
}

/** Ground this far ahead decides "uphill" or "downhill". */
const SLOPE_AHEAD_M = 30;
/** Less rise or fall than this over SLOPE_AHEAD_M counts as level. */
const LEVEL_M = 0.8;

/** Whether the ground rises or falls along a bearing from `pos`, in words, or null without terrain. */
function slopeAhead(pos: Vec2, bearingDeg: number): { ground_ahead: string } | null {
  const here = elevationAt(pos);
  const h = (bearingDeg * Math.PI) / 180;
  const there = elevationAt({ x: pos.x + Math.sin(h) * SLOPE_AHEAD_M, y: pos.y + Math.cos(h) * SLOPE_AHEAD_M });
  if (here === null || there === null) return null;
  const d = there - here;
  const over = `over the next ${distancePhrase(SLOPE_AHEAD_M)}`;
  if (Math.abs(d) < LEVEL_M) return { ground_ahead: `level ${over}` };
  return { ground_ahead: `${d > 0 ? 'rises' : 'falls'} ${distancePhrase(Math.abs(d))} ${over} (${d > 0 ? 'uphill' : 'downhill'})` };
}

/** How the model should refer to a building: its name, or a short description of an unnamed one. */
function buildingName(b: BuildingX): string {
  if (b.name) return b.name;
  const size = b.area > 4000 ? 'large' : b.area < 400 ? 'small' : 'mid-size';
  return `unnamed ${size} building`;
}

/** Rough height in floors from the mapped height (about 3.5 m a floor). */
function floors(b: BuildingX): number {
  return Math.max(1, Math.round(b.heightM / 3.5));
}

/** Buildings straight along a bearing from the user, nearest first, as tool output. */
function lineOfSight(pack: PackIndex, pos: Vec2, bearingDeg: number, rangeM: number) {
  let prevExit = 0;
  return buildingsAlongRay(pack, pos, bearingDeg, rangeM).map((h, i) => {
    const row = {
      order: i + 1,
      name: buildingName(h.building),
      ...(h.enterM === 0 ? { you_are_inside: true } : { distance: distancePhrase(h.enterM) }),
      depth: distancePhrase(h.exitM - h.enterM),
      ...(i > 0 ? { gap_after_previous: distancePhrase(Math.max(0, h.enterM - prevExit)) } : {}),
      floors: floors(h.building),
    };
    prevExit = h.exitM;
    return row;
  });
}

/** A direction argument: clock hour relative to the phone (12 = ahead) or a compass bearing. Defaults to ahead. */
function bearingArg(args: Args): number {
  const deg = num(args.compass_deg);
  if (deg !== undefined) return norm360(deg);
  if (!orientation.has) throw new ToolError('Compass heading is not available yet. Give compass_deg instead.');
  const hour = num(args.clock);
  if (hour !== undefined && (hour < 1 || hour > 12)) throw new ToolError('clock must be 1 to 12.');
  return norm360(orientation.heading + ((hour ?? 12) % 12) * 30);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Turn `place_id` or `lon`/`lat` arguments into a destination. */
function resolvePlace(pack: PackIndex, args: Args): Destination {
  const label = typeof args.label === 'string' && args.label.trim() ? args.label.trim() : undefined;
  const id = typeof args.place_id === 'string' ? args.place_id.trim() : '';

  if (id.startsWith('g:')) {
    const place = pack.places[Number(id.slice(2))];
    if (!place) throw new ToolError(`Unknown place_id ${id}. Call find_place again.`);
    return { ll: { lon: place.lon, lat: place.lat }, label: label ?? place.name, buildingId: place.buildingId };
  }
  if (id.startsWith('f:')) {
    const f = pack.featureById.get(id.slice(2));
    if (!f) throw new ToolError(`Unknown place_id ${id}. Call find_nearby again.`);
    return { ll: { lon: f.lon, lat: f.lat }, label: label ?? f.name ?? FEATURE_NAMES[f.kind] ?? f.kind };
  }
  if (id.startsWith('r:')) {
    const r = useStore.getState().reports.find((x) => x.id === id.slice(2));
    if (!r) throw new ToolError(`Unknown place_id ${id}. Call get_reports_nearby again.`);
    return { ll: { lon: r.lon, lat: r.lat }, label: label ?? REPORT_LABELS[r.kind] };
  }
  if (id.startsWith('geo:')) {
    const [lon, lat] = id.slice(4).split(',').map(Number);
    if (Number.isFinite(lon) && Number.isFinite(lat)) return { ll: { lon, lat }, label: label ?? 'the destination' };
  }
  const lon = num(args.lon);
  const lat = num(args.lat);
  if (lon !== undefined && lat !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    return { ll: { lon, lat }, label: label ?? 'the destination' };
  }
  throw new ToolError('Give a place_id from find_place or find_nearby, or lon and lat.');
}

async function geocode(query: string): Promise<{ name: string; lon: number; lat: number; kind: string }[]> {
  const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return [];
  return ((await res.json()) as { results?: { name: string; lon: number; lat: number; kind: string }[] }).results ?? [];
}

const tools: Record<string, (args: Args) => Promise<Result> | Result> = {
  get_context() {
    const s = useStore.getState();
    if (!s.pack) throw new ToolError('Map data is not loaded yet.');
    const building = s.buildingId ? s.pack.buildingById.get(s.buildingId) : undefined;
    const ll = s.pos ? toLonLat(s.pack, s.pos) : null;
    return {
      position_known: Boolean(s.pos),
      units: unitName(),
      ...(ll ? { lon: Number(ll.lon.toFixed(6)), lat: Number(ll.lat.toFixed(6)), accuracy: `within ${distancePhrase(s.sigma)}` } : {}),
      where: s.indoors ? 'indoors' : 'outdoors',
      ...(s.pos && elevationAt(s.pos) !== null ? { elevation: `${distancePhrase(elevationAt(s.pos)!)} above sea level` } : {}),
      ...(s.pos && orientation.has ? (slopeAhead(s.pos, orientation.heading) ?? {}) : {}),
      ...(building ? { building: building.name ?? 'an unnamed building' } : {}),
      compass_ready: orientation.has,
      view: s.mode,
      navigation: s.nav
        ? {
            to: s.nav.label,
            type: s.nav.kind === 'route' ? 'turn-by-turn' : 'bearing only',
            remaining: distancePhrase(s.nav.remainingM),
            ...(s.nav.route ? { next_instruction: s.nav.route.steps[s.nav.stepIndex]?.text } : {}),
            ...(s.nav.entrance && !s.nav.entrance.reached ? { phase: 'walking to the building exit' } : {}),
          }
        : null,
    };
  },

  async find_place(args) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new ToolError('query is required.');
    const { pack, pos } = useStore.getState();
    if (!pack) throw new ToolError('Map data is not loaded yet.');

    const local = searchPlaces(pack, query, pos, 3);
    if (local.length) {
      return {
        results: local.map((m) => ({
          place_id: m.place.id,
          name: m.place.name,
          kind: m.place.kind,
          ...(pos ? whereIs(pos, m.place.pos) : {}),
        })),
      };
    }

    // Not a campus name we know: ask Nominatim (bounded to Amherst) through our API.
    const remote = await geocode(query).catch(() => []);
    if (!remote.length) return { results: [], note: `Nothing found for "${query}" on campus or in Amherst.` };
    return {
      source: 'OpenStreetMap search',
      results: remote.map((r) => ({
        place_id: `geo:${r.lon},${r.lat}`,
        name: r.name,
        kind: r.kind,
        ...(pos ? whereIs(pos, toLocal(pack, r)) : {}),
      })),
    };
  },

  find_nearby(args) {
    const { pack, pos } = need();
    const kind = String(args.kind ?? '');
    if (!(FEATURE_KINDS as readonly string[]).includes(kind)) throw new ToolError(`kind must be one of: ${FEATURE_KINDS.join(', ')}.`);
    const limit = Math.max(1, Math.min(5, Math.round(num(args.limit) ?? 3)));
    const found = nearestFeatures(pack, pos, kind as FeatureKind, limit).filter((f) => f.dist <= 600);
    if (!found.length) return { results: [], note: `No ${FEATURE_NAMES[kind]} is mapped within ${distancePhrase(600)}.` };
    return {
      results: found.map(({ feature }) => ({
        place_id: `f:${feature.id}`,
        kind: FEATURE_NAMES[kind],
        ...(feature.name ? { name: feature.name } : {}),
        ...(feature.buildingId ? { building: pack.buildingById.get(feature.buildingId)?.name } : {}),
        ...whereIs(pos, feature.pos),
      })),
    };
  },

  async start_navigation(args) {
    const { pack } = need();
    return startNavigation(resolvePlace(pack, args));
  },

  point_to(args) {
    const { pack } = need();
    const res = pointTo(resolvePlace(pack, args));
    return res.ok ? { ...res, note: 'Ticks get faster as the user turns away and stop when they face the target.' } : res;
  },

  stop_navigation() {
    return { ok: true, was_navigating: stopNavigation() };
  },

  set_hands_free(args) {
    if (typeof args.on !== 'boolean') throw new ToolError('on must be true or false.');
    useStore.getState().setSetting('handsFree', args.on);
    return { ok: true, hands_free: args.on, note: args.on ? 'Microphone always open.' : 'User now taps to talk.' };
  },

  async report_hazard(args) {
    const { pack, pos } = need();
    const kind = String(args.kind ?? '') as ReportKind;
    if (!REPORT_KINDS.includes(kind)) throw new ToolError(`kind must be one of: ${REPORT_KINDS.join(', ')}.`);
    const description = typeof args.description === 'string' ? args.description.trim() : '';
    if (!description) throw new ToolError('description is required.');
    const s = useStore.getState();
    const ll = toLonLat(pack, pos);
    const building = s.buildingId ? pack.buildingById.get(s.buildingId)?.name : undefined;
    const { report, merged } = await reportsApi.create({
      kind,
      lon: ll.lon,
      lat: ll.lat,
      description,
      source: args.source === 'camera' ? 'camera' : 'voice',
      permanent: typeof args.permanent === 'boolean' ? args.permanent : PERMANENT_KINDS.includes(kind),
      ...(building ? { building } : {}),
    });
    markOwnReport(report.id);
    upsertReport(report);
    return {
      ok: true,
      report_id: report.id,
      note: merged
        ? 'Someone already reported this here, so it was confirmed instead of duplicated.'
        : report.permanent
          ? 'Saved. Other users nearby will be told about it.'
          : 'Saved. Other users nearby will be warned. It expires in 48 hours unless someone confirms it.',
    };
  },

  async get_reports_nearby(args) {
    const { pack, pos } = need();
    const radius = Math.max(10, Math.min(300, num(args.radius_m) ?? 60));
    const ll = toLonLat(pack, pos);
    const reports = await reportsApi.near(ll.lon, ll.lat, radius);
    if (radius <= 60) useStore.setState({ reports });
    return {
      radius: distancePhrase(radius),
      reports: reports.map((r) => ({
        report_id: r.id,
        place_id: `r:${r.id}`,
        kind: REPORT_LABELS[r.kind],
        description: r.description,
        permanent: r.permanent,
        confirmations: r.confirmations,
        ...whereIs(pos, toLocal(pack, r)),
      })),
    };
  },

  async vote_report(args) {
    const id = typeof args.report_id === 'string' ? args.report_id.replace(/^r:/, '') : '';
    if (!id) throw new ToolError('report_id is required.');
    if (typeof args.still_there !== 'boolean') throw new ToolError('still_there must be true or false.');
    if (args.still_there) {
      const { report } = await reportsApi.confirm(id);
      upsertReport(report);
      return { ok: true, note: 'Confirmed. The report stays active longer.' };
    }
    const res = await reportsApi.resolve(id);
    if (res.deleted) {
      removeReport(id);
      return { ok: true, note: 'Enough people said it is gone, so the report was removed.' };
    }
    if (res.report) upsertReport(res.report);
    return { ok: true, note: 'Recorded. The report is removed once three people say it is gone.' };
  },

  buildings_in_line(args) {
    const { pack, pos } = need();
    const b = bearingArg(args);
    const range = Math.max(50, Math.min(LINE_MAX_M, num(args.range_m) ?? LINE_RANGE_M));
    const buildings = lineOfSight(pack, pos, b, range);
    return {
      ...(orientation.has ? { direction: relativeWords(angleDiff(orientation.heading, b)) } : {}),
      range: distancePhrase(range),
      buildings,
      note: buildings.length
        ? 'Order 1 is the first building the line reaches (the one the user is looking at); each later one is behind the one before it.'
        : 'No mapped building lies on that line. Try a nearby clock direction or buildings_around.',
    };
  },

  buildings_around(args) {
    const { pack, pos } = need();
    const radius = Math.max(30, Math.min(AROUND_MAX_M, num(args.radius_m) ?? AROUND_RADIUS_M));
    const limit = Math.max(1, Math.min(20, Math.round(num(args.limit) ?? 12)));

    // Centered on the user, or on a place (then directions are compass directions from that place).
    const hasPlace = typeof args.place_id === 'string' || (num(args.lon) !== undefined && num(args.lat) !== undefined);
    const dest = hasPlace ? resolvePlace(pack, args) : null;
    const centerPos = dest ? toLocal(pack, dest.ll) : pos;
    const centerBuilding = dest?.buildingId
      ? pack.buildingById.get(dest.buildingId)
      : !dest && useStore.getState().buildingId
        ? pack.buildingById.get(useStore.getState().buildingId!)
        : undefined;

    const rows = buildingsWithin(pack, centerPos, radius)
      .filter((b) => b.id !== centerBuilding?.id)
      .map((b) => {
        const near = projectOnRing(centerPos, b.outer);
        const gap = centerBuilding ? ringGap(centerBuilding.outer, b.outer) : near.dist;
        return { b, gap };
      })
      .filter((r) => r.gap <= radius)
      .sort((a, b) => a.gap - b.gap)
      .slice(0, limit)
      .map(({ b, gap }) => ({
        name: buildingName(b),
        ...(dest || centerBuilding ? { gap: distancePhrase(gap), ...(gap <= ADJACENT_M ? { next_to: true } : {}) } : {}),
        floors: floors(b),
        from_user: whereIs(pos, projectOnRing(pos, b.outer).point),
      }));

    return {
      around: dest ? dest.label : centerBuilding ? `the user, inside ${buildingName(centerBuilding)}` : 'the user',
      radius: distancePhrase(radius),
      buildings: rows,
    };
  },

  describe_xray_view() {
    const { pack, pos } = need();
    if (!orientation.has) throw new ToolError('Compass heading is not available yet.');
    const s = useStore.getState();
    const heading = orientation.heading;
    const inView = (p: Vec2) => dist(p, pos) <= XRAY_RANGE_M && Math.abs(angleDiff(heading, bearingENU(pos, p))) <= XRAY_HALF_FOV_DEG;

    const buildings = buildingsWithin(pack, pos, XRAY_RANGE_M)
      .filter((b) => b.id !== s.buildingId)
      .map((b) => ({ b, near: projectOnRing(pos, b.outer).point }))
      // A wide building counts when either its nearest wall or its center is in view.
      .filter(({ b, near }) => inView(near) || inView(b.centroid))
      .sort((a, b) => dist(pos, a.near) - dist(pos, b.near))
      .slice(0, 6)
      .map(({ b, near }) => ({ name: b.name ?? 'unnamed building', ...whereIs(pos, near) }));

    const features = featuresWithin(pack, pos, XRAY_RANGE_M)
      .filter(({ feature }) => inView(feature.pos))
      .slice(0, 10)
      .map(({ feature }) => ({ kind: FEATURE_NAMES[feature.kind], ...(feature.name ? { name: feature.name } : {}), ...whereIs(pos, feature.pos) }));

    const reports = s.reports
      .map((r) => ({ r, p: toLocal(pack, r) }))
      .filter(({ p }) => inView(p))
      .map(({ r, p }) => ({ kind: REPORT_LABELS[r.kind], description: r.description, ...whereIs(pos, p) }));

    const containing = s.buildingId ? pack.buildingById.get(s.buildingId) : undefined;
    return {
      ...(slopeAhead(pos, heading) ?? {}),
      // Straight ahead, nearest first: "the one behind that" is the next entry.
      in_line_ahead: lineOfSight(pack, pos, heading, LINE_RANGE_M).map((r) => r.name),
      ...(containing ? { inside: containing.name ?? 'an unnamed building' } : {}),
      buildings,
      features,
      reports,
      target: s.nav
        ? { name: s.nav.label, in_view: inView(s.nav.dest), ...whereIs(pos, s.nav.dest) }
        : null,
    };
  },
};

/** Tool calls the server cancelled (the user interrupted): their results must not be sent. */
const cancelled = new Set<string>();

async function run(call: FunctionCall): Promise<Result> {
  const fn = call.name ? tools[call.name] : undefined;
  if (!fn) return { error: `Unknown tool ${call.name ?? ''}.` };
  try {
    return await fn((call.args ?? {}) as Args);
  } catch (err) {
    if (err instanceof ToolError) return { error: err.message };
    console.error(`[tools] ${call.name} failed`, err);
    return { error: 'That did not work because of a technical problem. Tell the user and offer to try again.' };
  }
}

export async function executeToolCalls(calls: FunctionCall[]): Promise<void> {
  const responses = await Promise.all(
    calls.map(async (call) => {
      const response = await run(call);
      return { id: call.id, name: call.name, response };
    }),
  );
  const toSend = responses.filter((r) => {
    if (r.id && cancelled.has(r.id)) {
      cancelled.delete(r.id);
      return false;
    }
    return true;
  });
  if (toSend.length) live.sendToolResponse(toSend);
}

export function cancelToolCalls(ids: string[]): void {
  for (const id of ids) cancelled.add(id);
  // Do not let the set grow without bound if results never arrive.
  if (cancelled.size > 200) cancelled.clear();
}

/** Exposed for the dev simulator and tests: run one tool by name. */
export function runTool(name: string, args: Args = {}): Promise<Result> {
  return run({ name, args });
}

export function installTools(): void {
  live.onToolCall = (calls) => void executeToolCalls(calls);
  live.onToolCancel = cancelToolCalls;
}

export type { LonLat };
