// FOSSGIS OSRM client (foot profile), called straight from the browser.
// Usage policy: at most 1 request per second, no availability guarantee, base URL configurable.

import type { LonLat } from '../geo';
import type { LL } from '../data/types';

const OSRM_BASE: string = import.meta.env.VITE_OSRM_BASE ?? 'https://routing.openstreetmap.de/routed-foot';
const TIMEOUT_MS = 8000;
const MIN_GAP_MS = 1050;
const CACHE_TTL_MS = 5 * 60_000;
/** ~5 m in degrees, for cache keys. */
const KEY_GRID = 0.00005;

export type OsrmStep = {
  distance: number;
  duration: number;
  name: string;
  mode?: string;
  maneuver: {
    type: string;
    modifier?: string;
    location: LL;
    bearing_before?: number;
    bearing_after?: number;
    exit?: number;
  };
  [key: string]: unknown;
};

export type OsrmRoute = {
  distance: number;
  duration: number;
  geometry: { type: 'LineString'; coordinates: LL[] };
  legs: { steps: OsrmStep[] }[];
};

export class RoutingError extends Error {}

const cache = new Map<string, { at: number; routes: OsrmRoute[] }>();
let chain: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

function key(from: LonLat, to: LonLat): string {
  const r = (v: number) => Math.round(v / KEY_GRID);
  return `${r(from.lon)},${r(from.lat)};${r(to.lon)},${r(to.lat)}`;
}

/** Runs `fn` after every earlier request, keeping at least a second between requests. */
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fn();
  });
  chain = run.catch(() => undefined);
  return run;
}

/** Walking routes from → to, best first (alternatives after it when the server offers any). */
export async function getRoutes(from: LonLat, to: LonLat, opts: { fresh?: boolean } = {}): Promise<OsrmRoute[]> {
  const k = key(from, to);
  const hit = cache.get(k);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.routes;

  return queued(async () => {
    // The /routed-foot/ path selects the foot profile; the "driving" segment is ignored by this server
    // (openstreetmap.org sends the same). Keep it as-is.
    const url =
      `${OSRM_BASE}/route/v1/driving/${from.lon.toFixed(6)},${from.lat.toFixed(6)};${to.lon.toFixed(6)},${to.lat.toFixed(6)}` +
      `?overview=full&geometries=geojson&steps=true&alternatives=true`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }); // plain fetch: no copied headers, referrer or hints
    } catch (err) {
      throw new RoutingError(`routing request failed: ${String(err)}`);
    }
    if (!res.ok) throw new RoutingError(`routing HTTP ${res.status}`);
    const body = (await res.json()) as { code?: string; routes?: OsrmRoute[]; message?: string };
    if (body.code !== 'Ok' || !body.routes?.length) throw new RoutingError(`routing: ${body.code ?? 'no route'} ${body.message ?? ''}`);
    const routes = body.routes.filter((r) => r.geometry?.coordinates?.length >= 2);
    if (!routes.length) throw new RoutingError('routing: empty geometry');
    cache.set(k, { at: Date.now(), routes });
    if (cache.size > 50) cache.delete(cache.keys().next().value as string);
    return routes;
  });
}
