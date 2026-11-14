// Creates the indexes and seeds a few realistic demo reports around the ILC.
// Usage: npm run seed     (needs MONGODB_URI in .env; safe to re-run, it replaces earlier seeds)

import { MongoClient } from 'mongodb';
import { ensureIndexes, type ReportDoc } from '../server/db';
import { DEFAULT_TTL_HOURS } from '../shared/reports';

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is not set. Add it to .env first.');
  process.exit(1);
}

const now = new Date();
// Seeds are refreshed for the whole judging window rather than the default 48 h.
const expires = new Date(now.getTime() + Math.max(DEFAULT_TTL_HOURS, 72) * 3_600_000);

function report(
  kind: ReportDoc['kind'],
  lon: number,
  lat: number,
  description: string,
  extra: Partial<ReportDoc> = {},
): ReportDoc {
  const permanent = extra.permanent ?? false;
  return {
    kind,
    location: { type: 'Point', coordinates: [lon, lat] },
    description,
    source: 'manual',
    permanent,
    confirmations: 1,
    resolutions: 0,
    createdAt: now,
    lastConfirmedAt: now,
    ...(permanent ? {} : { expiresAt: expires }),
    seed: true,
    ...extra,
  };
}

// Positions are around the Integrative Learning Center (about 42.3909 N, 72.5258 W).
// Check them on the minimap after seeding and nudge if OSM geometry has moved.
const SEEDS: ReportDoc[] = [
  report('auto_door', -72.52597, 42.39068, 'Automatic door with a push plate on the right, at the ILC north entrance.', {
    permanent: true,
    building: 'Integrative Learning Center',
    floor: 1,
  }),
  report('construction', -72.52655, 42.39128, 'Construction fence across the sidewalk north-west of the ILC. Use the path on the pond side.'),
  report('broken_elevator', -72.52575, 42.39085, 'East elevator in the ILC is out of service. The west elevator works.', {
    building: 'Integrative Learning Center',
    floor: 1,
  }),
  report('ramp', -72.52635, 42.39045, 'Ramp to the ILC lower entrance, to the left of the main stairs.', {
    permanent: true,
    building: 'Integrative Learning Center',
  }),
];

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000, appName: 'wayfinder-seed' });
try {
  await client.connect();
  const col = client.db(process.env.MONGODB_DB || 'wayfinder').collection<ReportDoc>('reports');
  await ensureIndexes(col);
  const removed = await col.deleteMany({ seed: true });
  const inserted = await col.insertMany(SEEDS);
  console.log(`Indexes ready. Removed ${removed.deletedCount} old seed reports, inserted ${inserted.insertedCount}.`);
  console.log(`Collection now holds ${await col.countDocuments()} reports.`);
} finally {
  await client.close();
}
