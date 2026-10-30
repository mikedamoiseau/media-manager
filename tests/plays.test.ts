import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { openDb, saveSettings, type DB } from '../server/db.ts';
import { Service } from '../server/service.ts';
import { createApi } from '../server/api.ts';
import { applyKodiLibrary } from '../server/metadata.ts';
import { PROFILE_COLORS, addProfile } from '../server/profiles.ts';
import { libraryTitle, runtimeOf, openPlay, closePlay, closeLeftOpen, notePhonePlay, playMinutes, fillPlays, logKodiChanges } from '../server/plays.ts';

const MIN = 60_000;

/** A film (runtime 100, Kodi id 11, an old copy gone from the NAS too) and a series with two episodes (Kodi ids 101, 102). */
function library() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO titles (media_type, tmdb_id, title_en, runtime, source, fetched_at) VALUES ('movie', 1, 'Film A', 100, 'tmdb', 1)").run();
  const item = db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, tmdb_id, match_state, present, kodi_id, kodi_type, added_at, updated_at)
    VALUES (?, 'MOVIES', 'movies', 0, 'movie', 1, 'matched', ?, 11, 'movie', 1, 1)`);
  const gone = Number(item.run('MOVIES/A.old.mkv', 0).lastInsertRowid);
  const film = Number(item.run('MOVIES/A.mkv', 1).lastInsertRowid);
  const show = Number(db.prepare(`INSERT INTO items (path, folder, category, is_dir, match_state, present, added_at, updated_at)
    VALUES ('SERIES/Show', 'SERIES', 'series', 1, 'unmatched', 1, 1, 1)`).run().lastInsertRowid);
  const ep = db.prepare('INSERT INTO episodes (item_id, path, season, episode, kodi_id, runtime) VALUES (?, ?, 1, ?, ?, ?)');
  const eps = [1, 2].map((n) => Number(ep.run(show, `SERIES/Show/S01E0${n}.mkv`, n, 100 + n, n === 1 ? 42 : null).lastInsertRowid));
  return { db, film, gone, show, eps };
}

const rows = (db: DB) => db.prepare('SELECT * FROM plays ORDER BY id').all().map((r) => ({ ...r }));

test('a film started on a TV is found by its Kodi id, the copy on the NAS first', () => {
  const { db, film, show, eps } = library();
  assert.deepEqual(libraryTitle(db, 'movie', 11), { itemId: film, episodeId: null });
  assert.deepEqual(libraryTitle(db, 'episode', 101), { itemId: show, episodeId: eps[0] });
  assert.equal(libraryTitle(db, 'movie', 99), undefined);
});

test("a title's runtime: the film's from TMDB, the episode's from Kodi", () => {
  const { db, film, show, eps } = library();
  assert.equal(runtimeOf(db, film, null), 100);
  assert.equal(runtimeOf(db, show, eps[0]!), 42);
  assert.equal(runtimeOf(db, show, eps[1]!), null);
});

test('a play closed: its minutes, at most the runtime', () => {
  const { db, film } = library();
  const id = openPlay(db, { profileId: 1, itemId: film, episodeId: null, device: 'tv1', at: 1000 });
  assert.equal(rows(db)[0]!.minutes, null, 'none while it plays');
  closePlay(db, id, 110, true, 1000 + 140 * MIN);
  assert.deepEqual(
    rows(db).map((r) => [r.kind, r.device, r.ended_at, r.minutes, r.finished, r.estimated]),
    [['film', 'tv1', 1000 + 140 * MIN, 100, 1, 0]],
  );
});

test("a play far longer than its runtime: its stop was missed (a TV switched off, Kodi gone)", () => {
  const { db, film, show, eps } = library();
  for (const [item, episode, minutes, finished] of [
    [film, null, 300, false],
    [show, eps[1]!, 1210, false],
    [film, null, 110, true],
    [film, null, 200, true],
  ] as const) {
    const id = openPlay(db, { profileId: 1, itemId: item, episodeId: episode, device: 'tv1', at: 0 });
    closePlay(db, id, minutes, finished, minutes * MIN);
  }
  assert.deepEqual(
    rows(db).map((r) => [r.estimated, r.minutes, r.finished, r.reached, r.ended_at]),
    [
      [1, null, 0, null, null],
      [1, null, 0, null, null],
      [0, 100, 1, null, 110 * MIN],
      [1, null, 1, 1, null],
    ],
  );
});

test('a play whose end was missed is an estimate with nothing known', () => {
  const { db, show, eps } = library();
  openPlay(db, { profileId: 1, itemId: show, episodeId: eps[0]!, device: 'tv1', at: 1000 });
  assert.equal(closeLeftOpen(db), 1);
  const r = rows(db)[0]!;
  assert.deepEqual([r.kind, r.estimated, r.minutes], ['episode', 1, null]);
  assert.equal(playMinutes(r as { minutes: number | null; reached: number | null }, 42, true), 0);
  assert.equal(closeLeftOpen(db), 0, 'once');
});

test('the phone: one play per sitting, how far it got and how long it streamed, breaks left out', () => {
  const { db, film } = library();
  const anna = addProfile(db, { name: 'Anna', color: PROFILE_COLORS[1] }).id;
  const t = Date.UTC(2026, 10, 2, 20);
  notePhonePlay(db, anna, film, null, t, 0.3, t + 20 * MIN);
  // A second stream at once (a seek), then another after a 5-minute break.
  notePhonePlay(db, anna, film, null, t + 15 * MIN, 0.35, t + 22 * MIN);
  notePhonePlay(db, anna, film, null, t + 27 * MIN, 0.6, t + 50 * MIN);
  assert.deepEqual(
    rows(db).map((r) => [r.profile_id, r.kind, r.device, r.at, r.ended_at, r.minutes, r.reached, r.finished]),
    [[anna, 'film', 'phone', t, t + 50 * MIN, 45, 0.6, 0]],
  );
  // Three hours later, a few more minutes to the end.
  notePhonePlay(db, anna, film, null, t + 230 * MIN, 0.95, t + 240 * MIN);
  assert.deepEqual([rows(db)[0]!.minutes, rows(db)[0]!.reached, rows(db)[0]!.finished], [55, 0.95, 1]);
  notePhonePlay(db, anna, film, null, t + 490 * MIN, 0.1, t + 500 * MIN);
  assert.equal(rows(db).length, 2, 'another sitting, over 4 hours after the last stream');
});

test('the phone: two streams at once count once, whichever ends first', () => {
  const { db, film } = library();
  const t = Date.UTC(2026, 10, 2, 20);
  notePhonePlay(db, 1, film, null, t + 15 * MIN, 0.3, t + 22 * MIN);
  notePhonePlay(db, 1, film, null, t, 0.2, t + 20 * MIN);
  assert.deepEqual(rows(db).map((r) => [r.at, r.ended_at, r.minutes]), [[t, t + 22 * MIN, 22]]);
});

test('a long sitting on the phone, streamed hour after hour, stays one play', () => {
  const { db, film } = library();
  const t = Date.UTC(2026, 10, 2, 14);
  for (let h = 0; h <= 5; h++) notePhonePlay(db, 1, film, null, t + h * 60 * MIN, 0.1 + h * 0.1, t + (h * 60 + 50) * MIN);
  assert.equal(rows(db).length, 1);
});

test('a film or an episode streamed to the phone is a phone play of that profile', async () => {
  const db = openDb(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'media-'));
  mkdirSync(join(root, 'MOVIES'));
  mkdirSync(join(root, 'SERIES/Show'), { recursive: true });
  const big = Buffer.alloc(9 * 1024 * 1024);
  writeFileSync(join(root, 'MOVIES/Film.mkv'), big);
  writeFileSync(join(root, 'SERIES/Show/S01E01.mkv'), big);
  saveSettings(db, { mediaRoot: root });
  const item = db.prepare(`INSERT INTO items (path, folder, category, is_dir, match_state, present, added_at, updated_at)
    VALUES (?, ?, ?, ?, 'unmatched', 1, 1, 1)`);
  const film = Number(item.run('MOVIES/Film.mkv', 'MOVIES', 'movies', 0).lastInsertRowid);
  const show = Number(item.run('SERIES/Show', 'SERIES', 'series', 1).lastInsertRowid);
  const ep = Number(db.prepare("INSERT INTO episodes (item_id, path, season, episode) VALUES (?, 'SERIES/Show/S01E01.mkv', 1, 1)").run(show).lastInsertRowid);
  const anna = addProfile(db, { name: 'Anna', color: PROFILE_COLORS[1] }).id;
  const app = new Hono().route('/api', createApi(new Service(db, mkdtempSync(join(tmpdir(), 'data-')))));
  for (const path of [`/api/media/item/${film}/Film.mkv`, `/api/media/episode/${ep}/S01E01.mkv`]) {
    const r = await app.request(path, { headers: { 'x-profile': String(anna) } });
    await r.arrayBuffer();
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(
    rows(db).map((r) => [r.profile_id, r.item_id, r.kind, r.episode_id, r.device, r.reached, r.finished]),
    [
      [anna, film, 'film', null, 'phone', 1, 1],
      [anna, show, 'episode', ep, 'phone', 1, 1],
    ],
  );
});

test("Kodi's last plays and the phone's last streams become estimated plays, once", () => {
  const { db, film, show, eps } = library();
  const t = (s: string) => new Date(s).getTime();
  const other = Number(db.prepare(`INSERT INTO items (path, folder, category, is_dir, match_state, present, added_at, updated_at)
    VALUES (?, 'MOVIES', 'movies', 0, 'unmatched', 1, 1, 1)`).run('MOVIES/B.mkv').lastInsertRowid);
  const opened = Number(db.prepare(`INSERT INTO items (path, folder, category, is_dir, match_state, present, added_at, updated_at)
    VALUES (?, 'MOVIES', 'movies', 0, 'unmatched', 1, 1, 1)`).run('MOVIES/C.mkv').lastInsertRowid);
  const phoneOnly = Number(db.prepare(`INSERT INTO items (path, folder, category, is_dir, match_state, present, added_at, updated_at)
    VALUES (?, 'MOVIES', 'movies', 0, 'unmatched', 1, 1, 1)`).run('MOVIES/D.mkv').lastInsertRowid);
  const fs = db.prepare('INSERT INTO film_states (profile_id, item_id, playcount, resume, last_played) VALUES (1, ?, ?, ?, ?)');
  fs.run(film, 1, null, '2026-03-14 21:05:00');
  fs.run(other, 0, 0.4, '2026-04-02 20:00:00');
  fs.run(opened, 0, null, '2026-10-29 21:00:00');
  db.prepare("INSERT INTO episode_states (profile_id, episode_id, playcount, last_played) VALUES (1, ?, 1, '2026-05-01 22:00:00')").run(eps[0]);
  db.prepare('INSERT INTO watching (profile_id, item_id, fraction, played_at) VALUES (1, ?, 0.95, ?)').run(phoneOnly, t('2026-06-01T20:00:00'));
  assert.equal(fillPlays(db), 4);
  assert.deepEqual(
    rows(db).map((r) => [r.item_id, r.kind, r.episode_id, r.device, r.at, r.reached, r.finished, r.estimated]).sort((a, b) => Number(a[4]) - Number(b[4])),
    [
      [film, 'film', null, null, t('2026-03-14T21:05:00'), 1, 1, 1],
      [other, 'film', null, null, t('2026-04-02T20:00:00'), 0.4, 0, 1],
      [show, 'episode', eps[0], null, t('2026-05-01T22:00:00'), 1, 1, 1],
      [phoneOnly, 'film', null, null, t('2026-06-01T20:00:00'), 0.95, 1, 1],
    ],
  );
  assert.equal(fillPlays(db), 0, 'once');
});

test('a title known on both the TV and the phone keeps the one that got further', () => {
  const { db, film, show, eps } = library();
  db.prepare("INSERT INTO film_states (profile_id, item_id, playcount, resume, last_played) VALUES (1, ?, 0, 0.5, '2026-03-14 21:05:00')").run(film);
  db.prepare('INSERT INTO watching (profile_id, item_id, fraction, played_at) VALUES (1, ?, 0.8, ?)').run(film, Date.UTC(2026, 2, 20));
  db.prepare("INSERT INTO episode_states (profile_id, episode_id, playcount, resume, last_played, streamed, streamed_at) VALUES (1, ?, 0, 0.3, '2026-05-01 22:00:00', 0.7, ?)")
    .run(eps[1], Date.UTC(2026, 4, 2));
  fillPlays(db);
  assert.deepEqual(
    rows(db).map((r) => [r.item_id, r.episode_id, r.reached]),
    [
      [film, null, 0.8],
      [show, eps[1], 0.7],
    ],
  );
});

test('watched before, then stopped partway: the last play is the partial one', () => {
  const { db, film } = library();
  db.prepare("INSERT INTO film_states (profile_id, item_id, playcount, resume, last_played) VALUES (1, ?, 1, 0.3, '2026-03-14 21:05:00')").run(film);
  fillPlays(db);
  assert.deepEqual(rows(db).map((r) => [r.reached, r.finished]), [[0.3, 0]]);
});

test('a title the log already has is not put in again', () => {
  const { db, film } = library();
  openPlay(db, { profileId: 1, itemId: film, episodeId: null, device: 'tv1', at: Date.UTC(2026, 9, 31, 20) });
  db.prepare("INSERT INTO film_states (profile_id, item_id, playcount, last_played) VALUES (1, ?, 1, '2026-10-31 22:00:00')").run(film);
  assert.equal(fillPlays(db), 0);
  assert.equal(rows(db).length, 1);
});

const change = (itemId: number, lastPlayed: string, o: { watched?: boolean; resume?: number | null; episodeId?: number | null } = {}) => ({
  profileId: 1, itemId, episodeId: o.episodeId ?? null, lastPlayed, watched: o.watched ?? false, resume: o.resume ?? null,
});

test('a TV play logged in the afternoon is not the one Kodi reports in the evening', () => {
  const { db, film } = library();
  const id = openPlay(db, { profileId: 1, itemId: film, episodeId: null, device: 'tv1', at: new Date('2026-11-02T16:00:00').getTime() });
  closePlay(db, id, 100, true, new Date('2026-11-02T17:40:00').getTime());
  assert.equal(logKodiChanges(db, [change(film, '2026-11-02 21:40:00', { watched: true })]), 1);
  assert.equal(rows(db).length, 2);
});

test('two watches the app missed, hours apart, are two plays', () => {
  const { db, film } = library();
  logKodiChanges(db, [change(film, '2026-11-02 16:00:00', { watched: true })]);
  logKodiChanges(db, [change(film, '2026-11-02 21:40:00', { watched: true })]);
  assert.equal(rows(db).length, 2);
});

test("a phone play is never what Kodi's change is about", () => {
  const { db, film } = library();
  const t = new Date('2026-11-02T20:30:00').getTime();
  notePhonePlay(db, 1, film, null, t, 0.3, t + 20 * MIN);
  assert.equal(logKodiChanges(db, [change(film, '2026-11-02 21:40:00', { watched: true })]), 1);
  assert.deepEqual(rows(db).map((r) => [r.device, r.finished, r.estimated]), [['phone', 0, 0], [null, 1, 1]]);
});

test('a play the app logged is marked finished when Kodi counts it watched', () => {
  const { db, film } = library();
  const id = openPlay(db, { profileId: 1, itemId: film, episodeId: null, device: 'tv1', at: new Date('2026-11-02T20:00:00').getTime() });
  closePlay(db, id, 95, false, new Date('2026-11-02T21:39:00').getTime());
  assert.equal(logKodiChanges(db, [change(film, '2026-11-02 21:40:00', { watched: true })]), 0);
  assert.deepEqual(rows(db).map((r) => [r.minutes, r.finished]), [[95, 1]]);
});

test('a play the app missed comes in as an estimate', () => {
  const { db, film } = library();
  assert.equal(logKodiChanges(db, [change(film, '2026-11-02 21:40:00', { watched: true })]), 1);
  assert.deepEqual(
    rows(db).map((r) => [r.kind, r.device, r.at, r.reached, r.finished, r.estimated]),
    [['film', null, new Date('2026-11-02T21:40:00').getTime(), 1, 1, 1]],
  );
});

test("a change that is only a few seconds' start adds nothing", () => {
  const { db, film } = library();
  assert.equal(logKodiChanges(db, [change(film, '2026-11-02 21:40:00')]), 0);
  assert.deepEqual(rows(db), []);
});

test('a play left open, then reported by Kodi, gets how far Kodi says', () => {
  const { db, film } = library();
  openPlay(db, { profileId: 1, itemId: film, episodeId: null, device: 'tv1', at: new Date('2026-11-02T20:00:00').getTime() });
  closeLeftOpen(db);
  logKodiChanges(db, [change(film, '2026-11-02 21:00:00', { resume: 0.6 })]);
  const r = rows(db);
  assert.deepEqual(r.map((x) => [x.estimated, x.reached, x.finished]), [[1, 0.6, 0]]);
  assert.equal(playMinutes(r[0] as { minutes: number | null; reached: number | null }, 100, false), 60);
});

test('the fill runs when the service starts', () => {
  const { db, film } = library();
  db.prepare("INSERT INTO film_states (profile_id, item_id, playcount, last_played) VALUES (1, ?, 1, '2026-03-14 21:05:00')").run(film);
  new Service(db, mkdtempSync(join(tmpdir(), 'data-')));
  assert.equal(rows(db).length, 1);
});

test('an estimate counts its share of the runtime; an episode without one, 40 minutes', () => {
  assert.equal(playMinutes({ minutes: 130, reached: 1 }, 100, false), 100, 'never more than the runtime');
  assert.equal(playMinutes({ minutes: null, reached: 0.5 }, 100, false), 50);
  assert.equal(playMinutes({ minutes: null, reached: 1 }, null, true), 40);
  assert.equal(playMinutes({ minutes: 30, reached: 0.9 }, 100, false), 30, 'minutes measured win');
});

test('the log and its tables exist', () => {
  const db = openDb(':memory:');
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
  assert.deepEqual(cols('plays'), ['id', 'profile_id', 'item_id', 'kind', 'episode_id', 'device', 'at', 'ended_at', 'minutes', 'reached', 'finished', 'estimated']);
  assert.deepEqual(cols('year_asked'), ['profile_id', 'year', 'at']);
  assert.deepEqual(cols('person_photos'), ['name', 'url', 'fetched_at']);
  assert.ok(cols('episodes').includes('runtime'));
});

test("an episode's file replaced (a better copy): its plays stay, still an episode's", () => {
  const db = openDb(':memory:');
  const show = Number(db.prepare(`INSERT INTO items (path, folder, category, is_dir, match_state, present, added_at, updated_at)
    VALUES ('SERIES/Show', 'SERIES', 'series', 1, 'unmatched', 1, 1, 1)`).run().lastInsertRowid);
  const ep = Number(db.prepare("INSERT INTO episodes (item_id, path, season, episode) VALUES (?, 'SERIES/Show/S01E01.mkv', 1, 1)").run(show).lastInsertRowid);
  db.prepare("INSERT INTO plays (profile_id, item_id, kind, episode_id, device, at, minutes, finished) VALUES (1, ?, 'episode', ?, 'tv1', 1, 40, 1)").run(show, ep);
  db.prepare('DELETE FROM episodes WHERE id = ?').run(ep);
  assert.deepEqual({ ...db.prepare('SELECT item_id, kind, episode_id FROM plays').get() }, { item_id: show, kind: 'episode', episode_id: null });
});

test("an episode's runtime comes from Kodi, in minutes", () => {
  const db = openDb(':memory:');
  const show = Number(db.prepare(`INSERT INTO items (path, folder, category, is_dir, match_state, present, added_at, updated_at)
    VALUES ('SERIES/Show', 'SERIES', 'series', 1, 'unmatched', 1, 1, 1)`).run().lastInsertRowid);
  db.prepare("INSERT INTO episodes (item_id, path, season, episode) VALUES (?, 'SERIES/Show/S01E01.mkv', 1, 1)").run(show);
  applyKodiLibrary(db, 'smb://nas/MEDIA', {
    movies: [],
    shows: [],
    episodes: [{ episodeid: 7, file: 'smb://nas/MEDIA/SERIES/Show/S01E01.mkv', runtime: 2700, playcount: 0, lastplayed: '' }],
  });
  assert.deepEqual({ ...db.prepare('SELECT kodi_id, runtime FROM episodes').get() }, { kodi_id: 7, runtime: 45 });
});
