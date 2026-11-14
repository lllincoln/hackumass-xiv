import { Hono } from 'hono';
import { rateLimiter } from './ratelimit';

// Nominatim fallback search, bounded to the Amherst area.
// Usage policy: identify the app in the User-Agent, at most 1 request per second, cache results.
export const geocodeRoutes = new Hono();

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
// left, top, right, bottom
const VIEWBOX = '-72.56,42.42,-72.48,42.35';

type Place = { name: string; lon: number; lat: number; kind: string };

const CACHE_MAX = 500;
const cache = new Map<string, Place[]>();
function cacheGet(key: string): Place[] | undefined {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit); // most recently used last
  }
  return hit;
}
function cacheSet(key: string, value: Place[]) {
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

// Serial queue with ≥1.1 s between upstream requests.
let chain: Promise<unknown> = Promise.resolve();
let lastCall = 0;
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastCall + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  chain = run.catch(() => undefined);
  return run;
}

function userAgent(): string {
  const contact = process.env.NOMINATIM_CONTACT;
  return `Wayfinder-HackUMass/0.1${contact ? ` (${contact})` : ''}`;
}

const allow = rateLimiter(30, 60_000);

geocodeRoutes.get('/geocode', async (c) => {
  if (!allow(c)) return c.json({ error: 'rate_limited' }, 429);
  const q = (c.req.query('q') ?? '').trim().slice(0, 120);
  if (q.length < 2) return c.json({ error: 'missing_q' }, 400);
  const key = q.toLowerCase();

  const cached = cacheGet(key);
  if (cached) return c.json({ results: cached, cached: true });

  const url = `${NOMINATIM}?${new URLSearchParams({
    q,
    format: 'jsonv2',
    limit: '3',
    viewbox: VIEWBOX,
    bounded: '1',
    addressdetails: '0',
  })}`;

  try {
    const results = await throttled(async () => {
      const again = cacheGet(key); // an identical request may have finished while we queued
      if (again) return again;
      const res = await fetch(url, {
        headers: { 'User-Agent': userAgent(), 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`nominatim ${res.status}`);
      const rows = (await res.json()) as { display_name?: string; name?: string; lon: string; lat: string; type?: string }[];
      const places: Place[] = rows
        .map((r) => ({
          name: r.name || (r.display_name ?? '').split(',')[0] || q,
          lon: Number(r.lon),
          lat: Number(r.lat),
          kind: r.type ?? 'place',
        }))
        .filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat));
      cacheSet(key, places);
      return places;
    });
    return c.json({ results });
  } catch (err) {
    console.error('[geocode] failed', err);
    return c.json({ error: 'geocode_unavailable', results: [] }, 502);
  }
});
