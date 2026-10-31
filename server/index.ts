import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { openDb } from './db.ts';
import { Service } from './service.ts';
import { createApi } from './api.ts';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, '..');
const dataDir = process.env.MM_DATA_DIR ?? join(rootDir, 'data');
const webDir = join(rootDir, 'web', 'dist');
const port = Number(process.env.PORT ?? 8642);

const db = openDb(join(dataDir, 'media.db'));
const svc = new Service(db, dataDir, port);

const app = new Hono();
app.route('/api', createApi(svc));

if (existsSync(webDir)) {
  app.use('/assets/*', async (c, next) => {
    await next();
    c.header('cache-control', 'public, max-age=31536000, immutable');
  });
  app.use('/*', serveStatic({ root: webDir }));
  // SPA fallback: every other route renders the app shell.
  const index = () => readFileSync(join(webDir, 'index.html'), 'utf8');
  app.get('*', (c) => {
    c.header('cache-control', 'no-cache');
    return c.html(index());
  });
} else {
  app.get('/', (c) => c.text('Web app not built yet: run `npm run build` (or `npm run dev:web` for development).'));
}

const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address);
  console.log(`Media Manager on http://localhost:${port}${ips.map((ip) => `  ·  http://${ip}:${port}`).join('')}`);
  svc.start();
});

function shutdown() {
  svc.stop();
  server.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
