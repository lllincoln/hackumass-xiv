import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { tokenRoutes } from './token';
import { geocodeRoutes } from './geocode';
import { reportRoutes } from './reports';
import { hazardRoutes } from './hazard';
import { closeDb, dbMode } from './db';

const app = new Hono();

app.onError((err, c) => {
  console.error('[api] error', c.req.method, c.req.path, err);
  return c.json({ error: 'internal_error' }, 500);
});

app.get('/api/health', (c) =>
  c.json({ ok: true, db: dbMode(), gemini: Boolean(process.env.GEMINI_API_KEY), time: new Date().toISOString() }),
);
app.route('/api', tokenRoutes);
app.route('/api', geocodeRoutes);
app.route('/api', reportRoutes);
app.route('/api', hazardRoutes);
app.notFound((c) => c.json({ error: 'not_found' }, 404));

const port = Number(process.env.PORT ?? 8787);
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[api] listening on :${info.port} (db: ${dbMode()})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    void closeDb().finally(() => process.exit(0));
  });
}
