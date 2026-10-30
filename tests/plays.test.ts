import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type DB } from '../server/db.ts';
import { applyKodiLibrary } from '../server/metadata.ts';
import { PROFILE_COLORS, addProfile } from '../server/profiles.ts';
import { libraryTitle, runtimeOf, openPlay, closePlay, closeLeftOpen, notePhonePlay, playMinutes } from '../server/plays.ts';

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
  closePlay(db, id, 130, true);
  assert.deepEqual(
    rows(db).map((r) => [r.kind, r.device, r.minutes, r.finished, r.estimated]),
    [['film', 'tv1', 100, 1, 0]],
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

test('the phone: one play per sitting, how far it got and how long it ran', () => {
  const { db, film } = library();
  const anna = addProfile(db, { name: 'Anna', color: PROFILE_COLORS[1] }).id;
  const t = Date.UTC(2026, 10, 2, 20);
  notePhonePlay(db, anna, film, null, t, 0.3, t + 20 * MIN);
  notePhonePlay(db, anna, film, null, t + 25 * MIN, 0.6, t + 50 * MIN);
  assert.deepEqual(
    rows(db).map((r) => [r.profile_id, r.kind, r.device, r.at, r.minutes, r.reached, r.finished]),
    [[anna, 'film', 'phone', t, 50, 0.6, 0]],
  );
  notePhonePlay(db, anna, film, null, t + 55 * MIN, 0.95, t + 90 * MIN);
  assert.deepEqual([rows(db)[0]!.reached, rows(db)[0]!.finished], [0.95, 1]);
  notePhonePlay(db, anna, film, null, t + 400 * MIN, 0.1, t + 410 * MIN);
  assert.equal(rows(db).length, 2, 'another sitting, over 4 hours after the last stream');
});

test('a long sitting on the phone, streamed hour after hour, stays one play', () => {
  const { db, film } = library();
  const t = Date.UTC(2026, 10, 2, 14);
  for (let h = 0; h <= 5; h++) notePhonePlay(db, 1, film, null, t + h * 60 * MIN, 0.1 + h * 0.1, t + (h * 60 + 50) * MIN);
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
  assert.deepEqual(cols('plays'), ['id', 'profile_id', 'item_id', 'kind', 'episode_id', 'device', 'at', 'minutes', 'reached', 'finished', 'estimated']);
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
