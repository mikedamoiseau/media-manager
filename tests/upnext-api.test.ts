import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { openDb, saveSettings } from '../server/db.ts';
import { Service } from '../server/service.ts';
import { createApi } from '../server/api.ts';
import { setParentsCode } from '../server/kids.ts';
import { PROFILE_COLORS, addProfile } from '../server/profiles.ts';
import { upNext } from '../server/upnext.ts';
import type { UpNextEntry } from '../server/upnext.ts';
import { standInKodi } from './standInKodi.ts';

/** The app over a film, a series of three episodes and a film gone from the NAS, on one TV played by a stand-in Kodi. */
async function setup() {
  const kodi = await standInKodi();
  const db = openDb(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'media-'));
  mkdirSync(join(root, 'MOVIES'));
  saveSettings(db, { mediaRoot: root, kodiTvs: [{ id: 'tv1', name: 'Living room', host: '127.0.0.1', port: kodi.port, user: '', pass: '', pathPrefix: 'smb://nas/MEDIA' }] });
  const item = db.prepare(`INSERT INTO items (path, folder, category, is_dir, match_state, present, kodi_id, kodi_type, added_at, updated_at)
    VALUES (?, ?, ?, ?, 'unmatched', ?, ?, ?, 1, 1)`);
  const film = Number(item.run('MOVIES/Film.mkv', 'MOVIES', 'movies', 0, 1, 11, 'movie').lastInsertRowid);
  const gone = Number(item.run('MOVIES/Gone.mkv', 'MOVIES', 'movies', 0, 0, 12, 'movie').lastInsertRowid);
  const show = Number(item.run('SERIES/Show', 'SERIES', 'series', 1, 1, null, null).lastInsertRowid);
  const ep = db.prepare('INSERT INTO episodes (item_id, path, season, episode, kodi_id) VALUES (?, ?, 1, ?, ?)');
  const eps = [1, 2, 3].map((n) => Number(ep.run(show, `SERIES/Show/S01E0${n}.mkv`, n, 100 + n).lastInsertRowid));
  const anna = addProfile(db, { name: 'Anna', color: PROFILE_COLORS[1] }).id;
  setParentsCode(db, '4821');
  const kid = addProfile(db, { name: 'Kid', color: PROFILE_COLORS[2], kids: true }).id;
  const svc = new Service(db, mkdtempSync(join(tmpdir(), 'data-')));
  const app = new Hono().route('/api', createApi(svc));
  const call = async (method: string, path: string, body?: unknown, profile = anna) => {
    const r = await app.request(`/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-kodi-tv': 'tv1', 'x-profile': String(profile) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  return { kodi, db, svc, film, gone, show, eps, anna, kid, call, [Symbol.dispose]: () => kodi.server.close() };
}

const listOf = (json: Record<string, unknown>) => json.upNext as UpNextEntry[];

test('adds a film once', async () => {
  using s = await setup();
  const r = await s.call('POST', '/upnext', { itemId: s.film });
  assert.equal(r.status, 200);
  assert.deepEqual(listOf(r.json).map((e) => [e.itemId, e.episodeId]), [[s.film, null]]);
  assert.equal(r.json.added, null, 'a film: no episode added');
  assert.equal(s.svc.status.tvs[0]!.upNext.length, 1, 'every device hears it');
  assert.equal(upNext(s.db, 'tv1')[0]!.profileId, s.anna, 'for who added it');
  const again = await s.call('POST', '/upnext', { itemId: s.film });
  assert.equal(again.status, 409);
  assert.equal(again.json.code, 'duplicate');
});

test('refuses what is not on the NAS, or not a title', async () => {
  using s = await setup();
  assert.equal((await s.call('POST', '/upnext', { itemId: s.gone })).status, 404);
  assert.equal((await s.call('POST', '/upnext', { itemId: 9999 })).status, 404);
  assert.equal((await s.call('POST', '/upnext', { itemId: 'x' })).status, 400);
  assert.equal((await s.call('POST', '/upnext', { itemId: s.film, episodeId: s.eps[0] })).status, 404, 'an episode of another title');
  assert.equal((await s.call('POST', '/upnext', { itemId: s.show, episodeId: 9999 })).status, 404);
});

test('a series adds the next episode on each tap, then says none is left', async () => {
  using s = await setup();
  const added = [];
  for (let i = 0; i < 3; i++) {
    const r = await s.call('POST', '/upnext', { itemId: s.show });
    assert.equal(r.status, 200);
    added.push(r.json.added);
  }
  assert.deepEqual(added, [{ season: 1, episode: 1 }, { season: 1, episode: 2 }, { season: 1, episode: 3 }]);
  const none = await s.call('POST', '/upnext', { itemId: s.show });
  assert.equal(none.status, 404);
  assert.equal(none.json.code, 'none_left');
});

test('a series adds the episode after the one playing on that TV', async () => {
  using s = await setup();
  await s.svc.onPlayer('tv1', { kind: 'play', item: { type: 'episode', id: 102 } });
  const r = await s.call('POST', '/upnext', { itemId: s.show });
  assert.deepEqual(r.json.added, { season: 1, episode: 3 });
});

test('an episode picked is added as it is', async () => {
  using s = await setup();
  const r = await s.call('POST', '/upnext', { itemId: s.show, episodeId: s.eps[1] });
  assert.deepEqual(r.json.added, { season: 1, episode: 2 });
  assert.equal((await s.call('POST', '/upnext', { itemId: s.show, episodeId: s.eps[1] })).status, 409);
});

test('removes one entry, or clears the list', async () => {
  using s = await setup();
  await s.call('POST', '/upnext', { itemId: s.film });
  const r = await s.call('POST', '/upnext', { itemId: s.show });
  const [first, second] = listOf(r.json);
  const removed = await s.call('DELETE', `/upnext/${first!.id}`);
  assert.deepEqual(listOf(removed.json).map((e) => e.id), [second!.id]);
  assert.equal((await s.call('DELETE', `/upnext/${first!.id}`)).status, 404);
  assert.deepEqual(listOf((await s.call('DELETE', '/upnext')).json), []);
  assert.deepEqual(s.svc.status.tvs[0]!.upNext, []);
});

test('plays an entry now', async () => {
  using s = await setup();
  await s.call('POST', '/upnext', { itemId: s.show });
  const r = await s.call('POST', '/upnext', { itemId: s.film });
  const film = listOf(r.json)[1]!;
  const played = await s.call('POST', `/upnext/${film.id}/play`);
  assert.equal(played.status, 200);
  assert.deepEqual(s.kodi.opened(), [{ movieid: 11 }]);
  assert.deepEqual(listOf(played.json).map((e) => e.itemId), [s.show]);
  assert.equal((await s.call('POST', `/upnext/${film.id}/play`)).status, 404);
});

test('an entry played now that left the NAS says so, and goes', async () => {
  using s = await setup();
  const r = await s.call('POST', '/upnext', { itemId: s.film });
  s.db.prepare('UPDATE items SET present = 0 WHERE id = ?').run(s.film);
  const played = await s.call('POST', `/upnext/${listOf(r.json)[0]!.id}/play`);
  assert.equal(played.status, 404);
  assert.equal(played.json.error, 'File is not on the NAS');
  assert.deepEqual(upNext(s.db, 'tv1'), []);
  assert.deepEqual(s.svc.status.tvs[0]!.upNext, [], 'every device hears it');
});

test('sets and turns off the sleep timer', async () => {
  using s = await setup();
  const t = Date.now();
  const r = await s.call('PUT', '/kodi/sleep', { minutes: 45 });
  assert.equal(r.status, 200);
  const at = (r.json.sleep as { at: number }).at;
  assert.ok(at >= t + 45 * 60_000 && at <= Date.now() + 45 * 60_000);
  assert.deepEqual(s.svc.status.tvs[0]!.sleep, { at });
  for (const bad of [{ minutes: 0 }, { minutes: 241 }, { minutes: 1.5 }, { minutes: '45' }, {}, { afterThis: false }]) {
    assert.equal((await s.call('PUT', '/kodi/sleep', bad)).status, 400, JSON.stringify(bad));
  }
  const idle = await s.call('PUT', '/kodi/sleep', { afterThis: true });
  assert.equal(idle.status, 409, 'nothing plays');
  s.kodi.players.push({ playerid: 1, type: 'video' });
  assert.deepEqual((await s.call('PUT', '/kodi/sleep', { afterThis: true })).json, { sleep: { afterThis: true } });
  assert.deepEqual((await s.call('DELETE', '/kodi/sleep')).json, { sleep: null });
  assert.equal(s.svc.status.tvs[0]!.sleep, null);
});

test('kids get neither', async () => {
  using s = await setup();
  assert.equal((await s.call('POST', '/upnext', { itemId: s.film }, s.kid)).status, 403);
  assert.equal((await s.call('DELETE', '/upnext', undefined, s.kid)).status, 403);
  assert.equal((await s.call('PUT', '/kodi/sleep', { minutes: 30 }, s.kid)).status, 403);
  assert.equal((await s.call('DELETE', '/kodi/sleep', undefined, s.kid)).status, 403);
});
