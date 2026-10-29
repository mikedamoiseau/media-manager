import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { openDb } from '../server/db.ts';
import { Service } from '../server/service.ts';
import { createApi } from '../server/api.ts';
import { Tmdb } from '../server/tmdb.ts';
import { addProfile, PROFILE_COLORS } from '../server/profiles.ts';
import { setParentsCode } from '../server/kids.ts';

/** TMDB where show 1 aired 4 episodes of season 1 and comes back for season 2; counts its calls. */
function fakeTmdb(calls: string[]) {
  const fetchFn = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    calls.push(u.pathname);
    if (u.pathname === '/3/tv/1') {
      return Response.json({
        status: 'Returning Series',
        seasons: [{ season_number: 1, episode_count: 4, air_date: '2025-01-01' }],
        last_episode_to_air: { season_number: 1, episode_number: 4, air_date: '2025-01-22' },
        next_episode_to_air: { season_number: 2, episode_number: 1, air_date: '2099-01-01' },
      });
    }
    if (/^\/3\/movie\/(now_playing|upcoming)$/.test(u.pathname)) return Response.json({ results: [] });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return new Tmdb('k', fetchFn, 0);
}

function setup(withTmdb = true) {
  const tmp = mkdtempSync(join(tmpdir(), 'series-api-'));
  const db = openDb(':memory:');
  const item = Number(db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, tmdb_id, match_state, present, file_count, added_at, updated_at)
    VALUES ('SERIES/Show', 'SERIES', 'series', 1, 'tv', 1, 'matched', 1, 2, 1, 1)`).run().lastInsertRowid);
  const ep = db.prepare('INSERT INTO episodes (item_id, path, season, episode) VALUES (?, ?, 1, ?)');
  ep.run(item, 'SERIES/Show/S01E01.mkv', 1);
  ep.run(item, 'SERIES/Show/S01E02.mkv', 2);
  const svc = new Service(db, join(tmp, 'data'));
  const calls: string[] = [];
  const tmdb = fakeTmdb(calls);
  svc.tmdb = () => (withTmdb ? tmdb : undefined);
  const app = new Hono().route('/api', createApi(svc));
  const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  return { db, app, json, item, calls };
}

/** Asks until the background fill is done. */
async function settled<T extends { running: boolean }>(ask: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const r = await ask();
    if (!r.running) return r;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error('still running');
}

test("a series page: whether it's followed and what's missing", async () => {
  const { app } = setup();
  const r = await app.request('/api/series/1');
  assert.equal(r.status, 200);
  const body = (await r.json()) as { follow: boolean; tmdb: boolean; status: { missing: unknown; nextSeason: unknown } };
  assert.equal(body.follow, true);
  assert.equal(body.tmdb, true);
  assert.deepEqual(body.status.missing, [{ season: 1, aired: 4, missing: [3, 4] }]);
  assert.deepEqual(body.status.nextSeason, { season: 2, date: '2099-01-01' });
  assert.equal((await app.request('/api/series/2')).status, 404);
});

test('following a series round trip, and a choice that is not true or false', async () => {
  const { app, json } = setup();
  assert.deepEqual(await (await app.request('/api/series/1/follow', json('PUT', { follow: false }))).json(), { follow: false });
  assert.equal(((await (await app.request('/api/series/1')).json()) as { follow: boolean }).follow, false);
  assert.deepEqual(await (await app.request('/api/series/1/follow', json('PUT', { follow: true }))).json(), { follow: true });
  assert.equal((await app.request('/api/series/1/follow', json('PUT', { follow: 'yes' }))).status, 400);
  assert.equal((await app.request('/api/series/9/follow', json('PUT', { follow: true }))).status, 404);
});

test('episodes to get: fetched in the background, then listed', async () => {
  const { app, item, calls } = setup();
  type Reply = { shows: Array<{ tmdbId: number; itemId: number; status: unknown }>; total: number; checked: number; running: boolean; tmdb: boolean };
  const first = (await (await app.request('/api/reports/episodes')).json()) as Reply;
  assert.equal(first.running, true);
  const done = await settled(async () => (await (await app.request('/api/reports/episodes')).json()) as Reply);
  assert.deepEqual(done, { shows: [{ tmdbId: 1, itemId: item, status: done.shows[0]!.status }], total: 1, checked: 1, running: false, tmdb: true });
  assert.deepEqual(calls.filter((c) => c === '/3/tv/1'), ['/3/tv/1']);
});

test("coming soon: a followed show's next season once its data is in", async () => {
  const { app, item } = setup();
  type Reply = { entries: Array<{ kind: string; itemId?: number; season?: number }>; running: boolean };
  const done = await settled(async () => (await (await app.request('/api/soon')).json()) as Reply);
  assert.deepEqual(done.entries, [{ kind: 'season', tmdbId: 1, itemId: item, season: 2, date: '2099-01-01' }]);
});

test('without a TMDB key nothing fails: nothing kept, nothing to show', async () => {
  const { app } = setup(false);
  assert.deepEqual(await (await app.request('/api/soon')).json(), { entries: [], running: false });
  const r = (await (await app.request('/api/series/1')).json()) as { status: unknown; tmdb: boolean };
  assert.deepEqual(r, { follow: true, status: null, tmdb: false });
});

test('kids mode reaches none of these routes', async () => {
  const { db, app, json } = setup();
  setParentsCode(db, '4821');
  const kid = addProfile(db, { name: 'Kid', color: PROFILE_COLORS[2], kids: true });
  const h = { 'x-profile': String(kid.id) };
  for (const [method, url] of [['GET', '/api/series/1'], ['PUT', '/api/series/1/follow'], ['GET', '/api/reports/episodes'], ['GET', '/api/soon']] as const) {
    const init = method === 'PUT' ? json('PUT', { follow: false }) : { method };
    const r = await app.request(url, { ...init, headers: { ...(init as { headers?: Record<string, string> }).headers, ...h } });
    assert.equal(r.status, 403, `${method} ${url}`);
  }
});
