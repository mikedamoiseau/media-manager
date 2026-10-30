import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, saveSettings, type DB } from '../server/db.ts';
import { Service } from '../server/service.ts';
import { MAIN_PROFILE } from '../server/profiles.ts';
import { openPlay } from '../server/plays.ts';
import { standInKodi } from './standInKodi.ts';

const MIN = 60_000;

/** A TV played by the stand-in; a film (Kodi id 11, runtime 100) and a series with episodes 101, 102 in its library. */
async function setup() {
  const kodi = await standInKodi();
  const db = openDb(':memory:');
  saveSettings(db, { kodiTvs: [{ id: 'tv1', name: 'Living room', host: '127.0.0.1', port: kodi.port, user: '', pass: '', pathPrefix: 'smb://nas/MEDIA' }] });
  db.prepare("INSERT INTO titles (media_type, tmdb_id, title_en, runtime, source, fetched_at) VALUES ('movie', 1, 'Film A', 100, 'tmdb', 1)").run();
  const film = Number(db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, tmdb_id, match_state, present, kodi_id, kodi_type, added_at, updated_at)
    VALUES ('MOVIES/A.mkv', 'MOVIES', 'movies', 0, 'movie', 1, 'matched', 1, 11, 'movie', 1, 1)`).run().lastInsertRowid);
  const show = Number(db.prepare(`INSERT INTO items (path, folder, category, is_dir, match_state, present, added_at, updated_at)
    VALUES ('SERIES/Show', 'SERIES', 'series', 1, 'unmatched', 1, 1, 1)`).run().lastInsertRowid);
  const ep = db.prepare('INSERT INTO episodes (item_id, path, season, episode, kodi_id, runtime) VALUES (?, ?, 1, ?, ?, 45)');
  const eps = [1, 2].map((n) => Number(ep.run(show, `SERIES/Show/S01E0${n}.mkv`, n, 100 + n).lastInsertRowid));
  const dir = mkdtempSync(join(tmpdir(), 'data-'));
  const svc = new Service(db, dir);
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 2, 19) });
  return {
    kodi, db, dir, svc, film, show, eps,
    [Symbol.dispose]: () => {
      mock.timers.reset();
      kodi.server.close();
    },
  };
}

const rows = (db: DB) => db.prepare('SELECT * FROM plays ORDER BY id').all().map((r) => ({ ...r }));
const film = { kind: 'play', item: { type: 'movie', id: 11 } } as const;
const episode = (id: number) => ({ kind: 'play', item: { type: 'episode', id } }) as const;

test('a film played on a TV is logged for whoever watches, with its minutes without the pause', async () => {
  using s = await setup();
  const t = Date.now();
  await s.svc.onPlayer('tv1', film);
  mock.timers.tick(30 * MIN);
  await s.svc.onPlayer('tv1', { kind: 'pause' });
  mock.timers.tick(10 * MIN);
  await s.svc.onPlayer('tv1', { kind: 'resume' });
  mock.timers.tick(50 * MIN);
  await s.svc.onPlayer('tv1', { kind: 'stop', ended: true });
  assert.deepEqual(
    rows(s.db).map((r) => [r.profile_id, r.item_id, r.kind, r.device, r.at, r.minutes, r.finished, r.estimated]),
    [[MAIN_PROFILE, s.film, 'film', 'tv1', t, 80, 1, 0]],
  );
});

test('stopped by hand: not finished', async () => {
  using s = await setup();
  await s.svc.onPlayer('tv1', episode(101));
  mock.timers.tick(30 * MIN);
  await s.svc.onPlayer('tv1', { kind: 'stop', ended: false });
  assert.deepEqual(
    rows(s.db).map((r) => [r.item_id, r.kind, r.episode_id, r.minutes, r.finished]),
    [[s.show, 'episode', s.eps[0], 30, 0]],
  );
});

test('a new play on a TV with one still open closes the open one first', async () => {
  using s = await setup();
  await s.svc.onPlayer('tv1', episode(101));
  mock.timers.tick(10 * MIN);
  await s.svc.onPlayer('tv1', episode(102));
  const r = rows(s.db);
  assert.deepEqual(
    r.map((x) => [x.episode_id, x.minutes, x.finished]),
    [
      [s.eps[0], 10, 0],
      [s.eps[1], null, 0],
    ],
  );
  assert.equal(r.filter((x) => x.minutes === null && x.device === 'tv1').length, 1, 'never two open on one TV');
});

test('a play of something not in the library is not logged', async () => {
  using s = await setup();
  await s.svc.onPlayer('tv1', { kind: 'play', item: undefined });
  await s.svc.onPlayer('tv1', { kind: 'play', item: { type: 'movie', id: 99 } });
  await s.svc.onPlayer('tv1', { kind: 'stop', ended: true });
  assert.deepEqual(rows(s.db), []);
});

test('a play left open when the app stopped becomes an estimate when it starts again', async () => {
  using s = await setup();
  openPlay(s.db, { profileId: MAIN_PROFILE, itemId: s.film, episodeId: null, device: 'tv1', at: Date.now() });
  new Service(s.db, s.dir);
  assert.deepEqual(
    rows(s.db).map((r) => [r.estimated, r.minutes]),
    [[1, null]],
  );
});
