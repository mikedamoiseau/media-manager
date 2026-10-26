import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, MIGRATIONS } from '../server/db.ts';
import { MAIN_PROFILE, PROFILE_COLORS, ProfileError, listProfiles, addProfile, editProfile, removeProfile, profileOf } from '../server/profiles.ts';

const rows = (db: DatabaseSync, sql: string) => db.prepare(sql).all().map((r) => ({ ...r }));

test('migration gives everything recorded so far to the main profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-'));
  const file = join(dir, 'media.db');
  const old = new DatabaseSync(file);
  for (const m of MIGRATIONS.slice(0, 8)) old.exec(m);
  old.exec('PRAGMA user_version = 8');
  const item = old.prepare(`INSERT INTO items (path, folder, category, is_dir, kodi_id, kodi_type, playcount, resume, last_played, added_at, updated_at)
    VALUES (?, 'MOVIES', 'movies', ?, ?, ?, ?, ?, ?, 1, 1)`);
  const watched = Number(item.run('MOVIES/A.mkv', 0, 11, 'movie', 1, null, '2026-10-20 20:00:00').lastInsertRowid);
  const started = Number(item.run('MOVIES/B.mkv', 0, 12, 'movie', 0, 0.4, '2026-10-21 20:00:00').lastInsertRowid);
  item.run('MOVIES/C.mkv', 0, 13, 'movie', 0, null, null);
  const show = Number(item.run('SERIES/S', 1, 5, 'tvshow', 0, null, null).lastInsertRowid);
  const ep = old.prepare('INSERT INTO episodes (item_id, path, season, episode, kodi_id, playcount, resume, last_played, streamed, streamed_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)');
  const streamed = Number(ep.run(show, 'SERIES/S/E01.mkv', 1, 101, 0, null, null, 0.5, 1000).lastInsertRowid);
  const seen = Number(ep.run(show, 'SERIES/S/E02.mkv', 2, 102, 1, null, '2026-10-22 20:00:00', null, null).lastInsertRowid);
  ep.run(show, 'SERIES/S/E03.mkv', 3, 103, 0, null, null, null, null);
  old.prepare('INSERT INTO watching (item_id, fraction, played_at, dismissed_at) VALUES (?, 0.3, 5, 6)').run(started);
  old.prepare("INSERT INTO ratings (media_type, tmdb_id, value, at) VALUES ('movie', 10, 1, 7)").run();
  old.prepare("INSERT INTO activity (item_id, kind, at) VALUES (?, 'open', 9)").run(watched);
  old.close();

  const db = openDb(file);
  assert.deepEqual(listProfiles(db), [{ id: 1, name: 'Me', color: PROFILE_COLORS[0], main: true, kids: false, maxAge: 12, bedtime: null }]);
  assert.deepEqual(rows(db, 'SELECT profile_id, item_id, playcount, resume, last_played FROM film_states ORDER BY item_id'), [
    { profile_id: 1, item_id: watched, playcount: 1, resume: null, last_played: '2026-10-20 20:00:00' },
    { profile_id: 1, item_id: started, playcount: 0, resume: 0.4, last_played: '2026-10-21 20:00:00' },
  ]);
  assert.deepEqual(rows(db, 'SELECT profile_id, episode_id, playcount, last_played, streamed, streamed_at FROM episode_states ORDER BY episode_id'), [
    { profile_id: 1, episode_id: streamed, playcount: 0, last_played: null, streamed: 0.5, streamed_at: 1000 },
    { profile_id: 1, episode_id: seen, playcount: 1, last_played: '2026-10-22 20:00:00', streamed: null, streamed_at: null },
  ]);
  assert.deepEqual(rows(db, 'SELECT profile_id, item_id, fraction, played_at, dismissed_at FROM watching'), [
    { profile_id: 1, item_id: started, fraction: 0.3, played_at: 5, dismissed_at: 6 },
  ]);
  assert.deepEqual(rows(db, 'SELECT profile_id, media_type, tmdb_id, value FROM ratings'), [{ profile_id: 1, media_type: 'movie', tmdb_id: 10, value: 1 }]);
  assert.deepEqual(rows(db, 'SELECT profile_id, item_id, kind FROM activity'), [{ profile_id: 1, item_id: watched, kind: 'open' }]);
  db.close();
  rmSync(dir, { recursive: true });
});

test('profiles: add, rename, recolour, remove; the main one stays', () => {
  const db = openDb(':memory:');
  const anna = addProfile(db, { name: ' Anna ', color: PROFILE_COLORS[2] });
  assert.deepEqual(anna, { id: 2, name: 'Anna', color: PROFILE_COLORS[2], main: false, kids: false, maxAge: 12, bedtime: null });
  assert.throws(() => addProfile(db, { name: '  ', color: PROFILE_COLORS[1] }), (e: Error) => e instanceof ProfileError && e.message === 'Give the profile a name');
  assert.throws(() => addProfile(db, { name: 'anna', color: PROFILE_COLORS[1] }), { message: 'Anna is already a profile' });
  assert.throws(() => addProfile(db, { name: 'Bob', color: '#123456' }), { message: 'Pick a colour' });
  assert.deepEqual(editProfile(db, 2, { name: 'Ann' }), { id: 2, name: 'Ann', color: PROFILE_COLORS[2], main: false, kids: false, maxAge: 12, bedtime: null });
  assert.deepEqual(editProfile(db, 2, { color: PROFILE_COLORS[3] }).color, PROFILE_COLORS[3]);
  assert.throws(() => editProfile(db, 9, { name: 'X' }), { message: 'Profile not found' });
  assert.throws(() => removeProfile(db, MAIN_PROFILE), { message: "The main profile can't be removed" });

  const film = Number(db.prepare("INSERT INTO items (path, folder, category, added_at, updated_at) VALUES ('MOVIES/A.mkv', 'MOVIES', 'movies', 1, 1)").run().lastInsertRowid);
  for (const p of [1, 2]) {
    db.prepare("INSERT INTO ratings (profile_id, media_type, tmdb_id, value, at) VALUES (?, 'movie', 10, 1, 1)").run(p);
    db.prepare('INSERT INTO watching (profile_id, item_id, fraction, played_at) VALUES (?, ?, 0.5, 1)').run(p, film);
    db.prepare('INSERT INTO film_states (profile_id, item_id, playcount) VALUES (?, ?, 1)').run(p, film);
  }
  removeProfile(db, 2);
  assert.deepEqual(listProfiles(db).map((p) => p.id), [1]);
  for (const t of ['ratings', 'watching', 'film_states']) {
    assert.deepEqual(rows(db, `SELECT profile_id FROM ${t}`), [{ profile_id: 1 }], t);
  }
  assert.throws(() => removeProfile(db, 2), { message: 'Profile not found' });
});

test("a removed profile's id is never given again (a phone still set to it must ask who's watching)", () => {
  const db = openDb(':memory:');
  const guest = addProfile(db, { name: 'Guest', color: PROFILE_COLORS[1] });
  removeProfile(db, guest.id);
  assert.notEqual(addProfile(db, { name: 'Ben', color: PROFILE_COLORS[2] }).id, guest.id);
});

test('profileOf: an unknown, removed or missing id is the main profile', () => {
  const db = openDb(':memory:');
  addProfile(db, { name: 'Anna', color: PROFILE_COLORS[1] });
  assert.equal(profileOf(db, '2'), 2);
  for (const raw of ['9', undefined, null, 'x', '', '1.5']) assert.equal(profileOf(db, raw), MAIN_PROFILE, String(raw));
});

test("the app: this device's profile, none when unset or removed (then it asks who's watching)", async () => {
  const { chosenProfile, PROFILE_COLORS: webColors } = await import('../web/src/profiles.ts');
  assert.deepEqual(webColors, PROFILE_COLORS, 'the same colours as the server');
  const list = [{ id: 1, name: 'Me', color: PROFILE_COLORS[0]!, main: true, kids: false, maxAge: 12, bedtime: null }, { id: 2, name: 'Anna', color: PROFILE_COLORS[1]!, main: false, kids: false, maxAge: 12, bedtime: null }];
  assert.equal(chosenProfile(list, null), null);
  assert.equal(chosenProfile(list, 3), null);
  assert.equal(chosenProfile(list, 2)?.name, 'Anna');
  assert.equal(chosenProfile([], 1), null, 'profiles not loaded yet');
});

test('the app: an answer asked for one profile is dropped once the device switched to another', async () => {
  const { forProfile } = await import('../web/src/profiles.ts');
  let current: number | null = 1;
  const got: string[] = [];
  const mine = forProfile(() => current, (x: string) => got.push(x));
  const stale = forProfile(() => current, (x: string) => got.push(x));
  mine('for 1');
  current = 2;
  stale('late, for 1');
  forProfile(() => current, (x: string) => got.push(x))('for 2');
  assert.deepEqual(got, ['for 1', 'for 2']);
});
