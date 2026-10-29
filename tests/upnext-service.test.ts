import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, saveSettings } from '../server/db.ts';
import { Service, NEXT_PAUSE } from '../server/service.ts';
import { PlayError, playItem } from '../server/playItem.ts';
import { MAIN_PROFILE, PROFILE_COLORS, addProfile } from '../server/profiles.ts';
import { STALE, addToUpNext, upNext, setSleep, sleepOf } from '../server/upnext.ts';

/** A stand-in Kodi: answers what Play and Stop ask, and keeps every call. */
async function standInKodi() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const players: Array<{ playerid: number; type: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const m = JSON.parse(body) as { id: number; method: string; params: Record<string, unknown> };
      calls.push({ method: m.method, params: m.params });
      const result = m.method === 'Player.GetActivePlayers' ? players : 'OK';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: m.id, jsonrpc: '2.0', result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const opened = () => calls.filter((c) => c.method === 'Player.Open').map((c) => c.params.item);
  return { calls, players, server, port, opened };
}

/** A library with two films in Kodi, on one TV played by the stand-in. */
async function setup() {
  const kodi = await standInKodi();
  const db = openDb(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'media-'));
  mkdirSync(join(root, 'MOVIES'));
  saveSettings(db, { mediaRoot: root, kodiTvs: [{ id: 'tv1', name: 'Living room', host: '127.0.0.1', port: kodi.port, user: '', pass: '', pathPrefix: 'smb://nas/MEDIA' }] });
  const item = db.prepare(`INSERT INTO items (path, folder, category, is_dir, match_state, present, kodi_id, kodi_type, added_at, updated_at)
    VALUES (?, 'MOVIES', 'movies', 0, 'unmatched', ?, ?, 'movie', 1, 1)`);
  const a = Number(item.run('MOVIES/A.mkv', 1, 11).lastInsertRowid);
  const b = Number(item.run('MOVIES/B.mkv', 1, 12).lastInsertRowid);
  const gone = Number(item.run('MOVIES/Gone.mkv', 0, 13).lastInsertRowid);
  const show = Number(db.prepare(`INSERT INTO items (path, folder, category, is_dir, match_state, present, added_at, updated_at)
    VALUES ('SERIES/Show', 'SERIES', 'series', 1, 'unmatched', 1, 1, 1)`).run().lastInsertRowid);
  const ep = db.prepare('INSERT INTO episodes (item_id, path, season, episode, kodi_id) VALUES (?, ?, 1, ?, ?)');
  for (const n of [1, 2]) ep.run(show, `SERIES/Show/S01E0${n}.mkv`, n, 100 + n);
  const anna = addProfile(db, { name: 'Anna', color: PROFILE_COLORS[1] }).id;
  const svc = new Service(db, mkdtempSync(join(tmpdir(), 'data-')));
  return { kodi, db, svc, a, b, gone, show, anna, [Symbol.dispose]: () => kodi.server.close() };
}

test('playItem plays a film by its Kodi id', async () => {
  using s = await setup();
  await playItem(s.svc, 'tv1', MAIN_PROFILE, s.a);
  assert.deepEqual(s.kodi.opened(), [{ movieid: 11 }]);
});

test('playItem refuses a film that left the NAS', async () => {
  using s = await setup();
  await assert.rejects(playItem(s.svc, 'tv1', s.anna, s.gone), (e: unknown) => e instanceof PlayError && e.status === 404 && e.message === 'File is not on the NAS');
  assert.deepEqual(s.kodi.opened(), []);
});

const ended = { kind: 'stop', ended: true } as const;
const byHand = { kind: 'stop', ended: false } as const;
const episode = (id: number) => ({ kind: 'play', item: { type: 'episode', id } }) as const;

test('a play that ends starts the first entry, as its profile', async () => {
  using s = await setup();
  addToUpNext(s.db, 'tv1', s.anna, s.b, null, Date.now());
  s.svc.upNextChanged();
  assert.equal(s.svc.status.tvs[0]!.upNext.length, 1, 'the devices see the list');
  const t = Date.now();
  await s.svc.onPlayer('tv1', ended);
  assert.ok(Date.now() - t >= NEXT_PAUSE, 'after a pause');
  assert.deepEqual(s.kodi.opened(), [{ movieid: 12 }]);
  assert.deepEqual(upNext(s.db, 'tv1'), []);
  assert.deepEqual(s.svc.status.tvs[0]!.upNext, []);
  assert.equal(s.svc.owners.start('tv1', Date.now()), s.anna, 'what starts is the one who added it');
});

test('a play stopped by hand leaves the list', async () => {
  using s = await setup();
  addToUpNext(s.db, 'tv1', s.anna, s.b, null, Date.now());
  await s.svc.onPlayer('tv1', byHand);
  assert.deepEqual(s.kodi.opened(), []);
  assert.equal(upNext(s.db, 'tv1').length, 1);
});

test('something started meanwhile stays: the list waits', async () => {
  using s = await setup();
  addToUpNext(s.db, 'tv1', s.anna, s.b, null, Date.now());
  s.kodi.players.push({ playerid: 1, type: 'video' });
  await s.svc.onPlayer('tv1', ended);
  assert.deepEqual(s.kodi.opened(), []);
  assert.equal(upNext(s.db, 'tv1').length, 1);
});

test('a timer about to stop the TV: nothing starts', async () => {
  using s = await setup();
  addToUpNext(s.db, 'tv1', s.anna, s.b, null, Date.now());
  setSleep(s.db, 'tv1', { minutes: 1 }, Date.now());
  s.db.prepare('UPDATE tv_sleep SET at = ?').run(Date.now() + NEXT_PAUSE / 2);
  await s.svc.onPlayer('tv1', ended);
  assert.deepEqual(s.kodi.opened(), []);
  assert.equal(upNext(s.db, 'tv1').length, 1);
});

test('an entry that left the NAS is dropped and the next plays', async () => {
  using s = await setup();
  addToUpNext(s.db, 'tv1', s.anna, s.gone, null, Date.now());
  addToUpNext(s.db, 'tv1', s.anna, s.b, null, Date.now());
  await s.svc.onPlayer('tv1', ended);
  assert.deepEqual(s.kodi.opened(), [{ movieid: 12 }]);
  assert.deepEqual(upNext(s.db, 'tv1'), []);
});

test('an entry Kodi refuses stays for later', async () => {
  using s = await setup();
  addToUpNext(s.db, 'tv1', s.anna, s.b, null, Date.now());
  s.kodi.server.close();
  await s.svc.onPlayer('tv1', ended);
  assert.equal(upNext(s.db, 'tv1').length, 1);
});

test('stop after this: nothing follows, and Kodi going on by itself is stopped', async () => {
  using s = await setup();
  s.kodi.players.push({ playerid: 1, type: 'video' });
  addToUpNext(s.db, 'tv1', s.anna, s.b, null, Date.now());
  await s.svc.onPlayer('tv1', episode(101));
  setSleep(s.db, 'tv1', { afterThis: true }, Date.now());
  await s.svc.onPlayer('tv1', ended);
  assert.deepEqual(s.kodi.opened(), []);
  assert.equal(sleepOf(s.db, 'tv1', Date.now()), null, 'the timer is done');
  assert.equal(s.svc.status.tvs[0]!.sleep, null);
  assert.equal(upNext(s.db, 'tv1').length, 1, 'the list waits');
  await s.svc.onPlayer('tv1', episode(102));
  assert.equal(s.kodi.calls.filter((c) => c.method === 'Player.Stop').length, 1);
});

test('stop after this, stopped by hand: the timer is done, nothing is stopped later', async () => {
  using s = await setup();
  s.kodi.players.push({ playerid: 1, type: 'video' });
  await s.svc.onPlayer('tv1', episode(101));
  setSleep(s.db, 'tv1', { afterThis: true }, Date.now());
  await s.svc.onPlayer('tv1', byHand);
  assert.equal(sleepOf(s.db, 'tv1', Date.now()), null);
  await s.svc.onPlayer('tv1', episode(102));
  assert.equal(s.kodi.calls.filter((c) => c.method === 'Player.Stop').length, 0);
});

test('without a timer, Kodi going on by itself is not stopped', async () => {
  using s = await setup();
  s.kodi.players.push({ playerid: 1, type: 'video' });
  await s.svc.onPlayer('tv1', episode(101));
  await s.svc.onPlayer('tv1', ended);
  await s.svc.onPlayer('tv1', episode(102));
  assert.equal(s.kodi.calls.filter((c) => c.method === 'Player.Stop').length, 0);
});

test('a stale list does not start', async () => {
  using s = await setup();
  addToUpNext(s.db, 'tv1', s.anna, s.b, null, Date.now() - STALE - 1);
  await s.svc.onPlayer('tv1', ended);
  assert.deepEqual(s.kodi.opened(), []);
  assert.deepEqual(upNext(s.db, 'tv1'), []);
});

test('the timer stops the TV when due', async () => {
  using s = await setup();
  s.kodi.players.push({ playerid: 1, type: 'video' });
  const t0 = Date.now();
  setSleep(s.db, 'tv1', { minutes: 1 }, t0);
  s.svc.upNextChanged();
  assert.deepEqual(s.svc.status.tvs[0]!.sleep, { at: t0 + 60_000 });
  await s.svc.checkSleep(t0 + 59_000);
  assert.equal(s.kodi.calls.filter((c) => c.method === 'Player.Stop').length, 0);
  await s.svc.checkSleep(t0 + 60_000);
  assert.equal(s.kodi.calls.filter((c) => c.method === 'Player.Stop').length, 1);
  assert.equal(sleepOf(s.db, 'tv1', t0), null);
  assert.equal(s.svc.status.tvs[0]!.sleep, null);
});

test('a removed TV takes its list', async () => {
  using s = await setup();
  addToUpNext(s.db, 'tv1', s.anna, s.b, null, Date.now());
  s.svc.saveTvs([]);
  assert.deepEqual(upNext(s.db, 'tv1'), []);
});
