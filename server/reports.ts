import { Hono } from 'hono';
import { ObjectId, type Collection, type Filter } from 'mongodb';
import {
  CONFIRM_EXTEND_HOURS,
  DEFAULT_TTL_HOURS,
  PERMANENT_KINDS,
  REPORT_KINDS,
  RESOLUTIONS_TO_DELETE,
  ROUTE_BUFFER_M,
  type CreateReportBody,
  type ReportDTO,
  type ReportKind,
  type ReportSource,
} from '../shared/reports';
import { reportsCollection, type ReportDoc } from './db';
import { bufferedBBoxPolygon, distToPolylineM, haversineM, parseLineString, validLonLat, type LonLatTuple } from './route';
import { rateLimiter } from './ratelimit';

const HOUR = 3_600_000;
/** A new report of the same kind this close to an active one counts as a confirmation instead. */
const DEDUP_M = 8;

type NewReport = Omit<ReportDoc, '_id'>;

interface ReportStore {
  near(lon: number, lat: number, radiusM: number): Promise<ReportDTO[]>;
  alongRoute(line: LonLatTuple[], bufferM: number): Promise<ReportDTO[]>;
  create(doc: NewReport): Promise<{ report: ReportDTO; merged: boolean }>;
  confirm(id: string): Promise<ReportDTO | null>;
  /** Returns the updated report, or `{ deleted: true }` when enough people said it is gone. */
  resolve(id: string): Promise<ReportDTO | { deleted: true } | null>;
}

function toDTO(doc: NewReport & { _id: ObjectId | string }, distanceM?: number): ReportDTO {
  return {
    id: String(doc._id),
    kind: doc.kind,
    lon: doc.location.coordinates[0],
    lat: doc.location.coordinates[1],
    description: doc.description,
    source: doc.source,
    permanent: doc.permanent,
    confirmations: doc.confirmations,
    resolutions: doc.resolutions,
    createdAt: doc.createdAt.toISOString(),
    lastConfirmedAt: doc.lastConfirmedAt.toISOString(),
    ...(doc.expiresAt ? { expiresAt: doc.expiresAt.toISOString() } : {}),
    ...(doc.building ? { building: doc.building } : {}),
    ...(doc.floor !== undefined ? { floor: doc.floor } : {}),
    ...(distanceM !== undefined ? { distanceM: Math.round(distanceM * 10) / 10 } : {}),
  };
}

// The TTL monitor only sweeps about once a minute, so always filter expired documents explicitly.
function activeFilter(): Filter<ReportDoc> {
  return { $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }] };
}

class MongoStore implements ReportStore {
  constructor(private col: Collection<ReportDoc>) {}

  async near(lon: number, lat: number, radiusM: number): Promise<ReportDTO[]> {
    const rows = await this.col
      .aggregate<ReportDoc & { _id: ObjectId; distanceM: number }>([
        {
          $geoNear: {
            near: { type: 'Point', coordinates: [lon, lat] },
            distanceField: 'distanceM',
            maxDistance: radiusM,
            spherical: true,
            query: activeFilter(),
          },
        },
        { $limit: 50 },
      ])
      .toArray();
    return rows.map((r) => toDTO(r, r.distanceM));
  }

  async alongRoute(line: LonLatTuple[], bufferM: number): Promise<ReportDTO[]> {
    // Index prefilter on the buffered bounding box, then an exact distance-to-polyline check.
    const rows = await this.col
      .find({ $and: [{ location: { $geoWithin: { $geometry: bufferedBBoxPolygon(line, bufferM) } } }, activeFilter()] })
      .limit(500)
      .toArray();
    return rows
      .map((r) => ({ r, d: distToPolylineM(r.location.coordinates, line) }))
      .filter((x) => x.d <= bufferM)
      .map((x) => toDTO(x.r, x.d));
  }

  async create(doc: NewReport): Promise<{ report: ReportDTO; merged: boolean }> {
    const [lon, lat] = doc.location.coordinates;
    const dup = (await this.near(lon, lat, DEDUP_M)).find((r) => r.kind === doc.kind);
    if (dup) {
      const confirmed = await this.confirm(dup.id);
      if (confirmed) return { report: confirmed, merged: true };
    }
    const res = await this.col.insertOne(doc);
    return { report: toDTO({ ...doc, _id: res.insertedId }), merged: false };
  }

  async confirm(id: string): Promise<ReportDTO | null> {
    if (!ObjectId.isValid(id)) return null;
    const now = new Date();
    const doc = await this.col.findOneAndUpdate(
      { _id: new ObjectId(id) },
      [
        {
          $set: {
            confirmations: { $add: ['$confirmations', 1] },
            lastConfirmedAt: now,
            // Temporary reports live 24 h longer per confirmation; permanent ones keep no expiry.
            expiresAt: {
              $cond: [
                { $eq: [{ $type: '$expiresAt' }, 'date'] },
                { $add: [{ $max: ['$expiresAt', now] }, CONFIRM_EXTEND_HOURS * HOUR] },
                '$$REMOVE',
              ],
            },
          },
        },
      ],
      { returnDocument: 'after' },
    );
    return doc ? toDTO(doc) : null;
  }

  async resolve(id: string): Promise<ReportDTO | { deleted: true } | null> {
    if (!ObjectId.isValid(id)) return null;
    const _id = new ObjectId(id);
    const doc = await this.col.findOneAndUpdate({ _id }, { $inc: { resolutions: 1 } }, { returnDocument: 'after' });
    if (!doc) return null;
    if (!doc.permanent && doc.resolutions >= RESOLUTIONS_TO_DELETE) {
      await this.col.deleteOne({ _id });
      return { deleted: true };
    }
    return toDTO(doc);
  }
}

/** Dev fallback when MONGODB_URI is not set. Same behavior, lost on restart. */
class MemoryStore implements ReportStore {
  private docs = new Map<string, NewReport & { _id: string }>();
  private seq = 0;

  private active(): (NewReport & { _id: string })[] {
    const now = Date.now();
    for (const [id, d] of this.docs) if (d.expiresAt && d.expiresAt.getTime() <= now) this.docs.delete(id);
    return [...this.docs.values()];
  }

  async near(lon: number, lat: number, radiusM: number): Promise<ReportDTO[]> {
    return this.active()
      .map((d) => ({ d, dist: haversineM([lon, lat], d.location.coordinates) }))
      .filter((x) => x.dist <= radiusM)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 50)
      .map((x) => toDTO(x.d, x.dist));
  }

  async alongRoute(line: LonLatTuple[], bufferM: number): Promise<ReportDTO[]> {
    return this.active()
      .map((d) => ({ d, dist: distToPolylineM(d.location.coordinates, line) }))
      .filter((x) => x.dist <= bufferM)
      .map((x) => toDTO(x.d, x.dist));
  }

  async create(doc: NewReport): Promise<{ report: ReportDTO; merged: boolean }> {
    const [lon, lat] = doc.location.coordinates;
    const dup = (await this.near(lon, lat, DEDUP_M)).find((r) => r.kind === doc.kind);
    if (dup) {
      const confirmed = await this.confirm(dup.id);
      if (confirmed) return { report: confirmed, merged: true };
    }
    const _id = `mem-${Date.now().toString(36)}-${++this.seq}`;
    const stored = { ...doc, _id };
    this.docs.set(_id, stored);
    return { report: toDTO(stored), merged: false };
  }

  async confirm(id: string): Promise<ReportDTO | null> {
    const d = this.docs.get(id);
    if (!d) return null;
    const now = new Date();
    d.confirmations += 1;
    d.lastConfirmedAt = now;
    if (d.expiresAt) d.expiresAt = new Date(Math.max(d.expiresAt.getTime(), now.getTime()) + CONFIRM_EXTEND_HOURS * HOUR);
    return toDTO(d);
  }

  async resolve(id: string): Promise<ReportDTO | { deleted: true } | null> {
    const d = this.docs.get(id);
    if (!d) return null;
    d.resolutions += 1;
    if (!d.permanent && d.resolutions >= RESOLUTIONS_TO_DELETE) {
      this.docs.delete(id);
      return { deleted: true };
    }
    return toDTO(d);
  }
}

const memory = new MemoryStore();
let mongo: MongoStore | null = null;
async function store(): Promise<ReportStore> {
  const pending = reportsCollection();
  if (!pending) return memory;
  const col = await pending;
  mongo ??= new MongoStore(col);
  return mongo;
}

function parseCreate(body: unknown): NewReport | string {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  const b = body as Partial<CreateReportBody>;
  if (typeof b.kind !== 'string' || !(REPORT_KINDS as readonly string[]).includes(b.kind)) return 'invalid kind';
  if (!validLonLat(b.lon, b.lat)) return 'invalid lon/lat';
  if (typeof b.description !== 'string' || !b.description.trim()) return 'description required';
  const kind = b.kind as ReportKind;
  const source: ReportSource = b.source === 'camera' || b.source === 'manual' ? b.source : 'voice';
  const permanent = typeof b.permanent === 'boolean' ? b.permanent : PERMANENT_KINDS.includes(kind);
  const now = new Date();
  return {
    kind,
    location: { type: 'Point', coordinates: [b.lon as number, b.lat as number] },
    description: b.description.trim().slice(0, 280),
    source,
    permanent,
    confirmations: 0,
    resolutions: 0,
    createdAt: now,
    lastConfirmedAt: now,
    ...(permanent ? {} : { expiresAt: new Date(now.getTime() + DEFAULT_TTL_HOURS * HOUR) }),
    ...(typeof b.building === 'string' && b.building.trim() ? { building: b.building.trim().slice(0, 120) } : {}),
    ...(typeof b.floor === 'number' && Number.isInteger(b.floor) && Math.abs(b.floor) < 100 ? { floor: b.floor } : {}),
  };
}

export const reportRoutes = new Hono();
const allowWrite = rateLimiter(30, 60_000);

reportRoutes.get('/reports', async (c) => {
  const lon = Number(c.req.query('lon'));
  const lat = Number(c.req.query('lat'));
  if (!validLonLat(lon, lat)) return c.json({ error: 'invalid lon/lat' }, 400);
  const r = Number(c.req.query('radius') ?? 60);
  const radius = Number.isFinite(r) ? Math.max(1, Math.min(2000, r)) : 60;
  const reports = await (await store()).near(lon, lat, radius);
  c.header('Cache-Control', 'no-store');
  return c.json({ reports });
});

reportRoutes.post('/reports/along-route', async (c) => {
  const line = parseLineString(await c.req.json().catch(() => null));
  if (!line) return c.json({ error: 'expected a GeoJSON LineString' }, 400);
  const reports = await (await store()).alongRoute(line, ROUTE_BUFFER_M);
  return c.json({ reports });
});

reportRoutes.post('/reports', async (c) => {
  if (!allowWrite(c)) return c.json({ error: 'rate_limited' }, 429);
  const parsed = parseCreate(await c.req.json().catch(() => null));
  if (typeof parsed === 'string') return c.json({ error: parsed }, 400);
  const { report, merged } = await (await store()).create(parsed);
  return c.json({ report, merged }, merged ? 200 : 201);
});

reportRoutes.post('/reports/:id/confirm', async (c) => {
  if (!allowWrite(c)) return c.json({ error: 'rate_limited' }, 429);
  const report = await (await store()).confirm(c.req.param('id'));
  if (!report) return c.json({ error: 'not_found' }, 404);
  return c.json({ report });
});

reportRoutes.post('/reports/:id/resolve', async (c) => {
  if (!allowWrite(c)) return c.json({ error: 'rate_limited' }, 429);
  const result = await (await store()).resolve(c.req.param('id'));
  if (!result) return c.json({ error: 'not_found' }, 404);
  if ('deleted' in result) return c.json({ deleted: true });
  return c.json({ report: result });
});
