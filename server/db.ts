import { MongoClient, type Collection, type ObjectId } from 'mongodb';
import type { ReportKind, ReportSource } from '../shared/reports';

export type ReportDoc = {
  _id?: ObjectId;
  kind: ReportKind;
  location: { type: 'Point'; coordinates: [number, number] };
  building?: string;
  floor?: number;
  description: string;
  source: ReportSource;
  permanent: boolean;
  confirmations: number;
  resolutions: number;
  createdAt: Date;
  lastConfirmedAt: Date;
  expiresAt?: Date;
  seed?: boolean;
};

// One shared client for the whole process.
let client: MongoClient | null = null;
let ready: Promise<Collection<ReportDoc>> | null = null;

export function dbMode(): 'atlas' | 'memory' {
  return process.env.MONGODB_URI ? 'atlas' : 'memory';
}

export async function ensureIndexes(col: Collection<ReportDoc>): Promise<void> {
  await col.createIndex({ location: '2dsphere' });
  // TTL: documents disappear once expiresAt passes (permanent reports have no expiresAt).
  await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}

/** Returns the reports collection, or null when no MONGODB_URI is configured (in-memory dev mode). */
export function reportsCollection(): Promise<Collection<ReportDoc>> | null {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (!ready) {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, appName: 'wayfinder-api' });
    const c = client;
    ready = (async () => {
      await c.connect();
      const col = c.db(process.env.MONGODB_DB || 'wayfinder').collection<ReportDoc>('reports');
      await ensureIndexes(col);
      console.log('[db] connected to MongoDB Atlas');
      return col;
    })();
    // If the first connection fails, allow a retry on the next request.
    ready.catch((err) => {
      console.error('[db] connection failed', err);
      ready = null;
      client = null;
      void c.close().catch(() => undefined);
    });
  }
  return ready;
}

export async function closeDb(): Promise<void> {
  const c = client;
  client = null;
  ready = null;
  if (c) await c.close();
}
