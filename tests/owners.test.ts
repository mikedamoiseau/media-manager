import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type DB } from '../server/db.ts';
import { MAIN_PROFILE, PROFILE_COLORS, addProfile } from '../server/profiles.ts';
import { TvOwners, TOUCH_WINDOW, CHAIN_WINDOW, CLAIM_WINDOW, notePlay, kodiStates, attributeKodiChanges } from '../server/owners.ts';

const NOW = Date.parse('2026-10-26T20:00:00');
const MIN = 60_000;
const kodiDate = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 19).replace('T', ' ');

test('a play soon after a device used the TV is that device\'s profile', () => {
  const o = new TvOwners();
  o.touch('tv2', 2, NOW);
  assert.equal(o.start('tv2', NOW + 20_000), 2);
  assert.equal(o.start('tv1', NOW + 20_000), MAIN_PROFILE, 'another TV');
  o.touch('tv2', 3, NOW + MIN);
  assert.equal(o.start('tv2', NOW + 2 * MIN), 3, 'the latest device to use it');
});

test('a play long after, or with no app use, is the main profile\'s', () => {
  const o = new TvOwners();
  assert.equal(o.start('tv1', NOW), MAIN_PROFILE);
  o.touch('tv1', 2, NOW);
  assert.equal(o.start('tv1', NOW + TOUCH_WINDOW + 1), MAIN_PROFILE);
});

test('Kodi playing the next episode keeps the owner of the one that just ended', () => {
  const o = new TvOwners();
  o.touch('tv1', 2, NOW);
  assert.equal(o.start('tv1', NOW + 10_000), 2);
  o.stop('tv1', true, NOW + 50 * MIN);
  assert.equal(o.start('tv1', NOW + 50 * MIN + 30_000), 2, 'the next episode');
  o.stop('tv1', true, NOW + 100 * MIN);
  assert.equal(o.start('tv1', NOW + 100 * MIN + CHAIN_WINDOW + 1), MAIN_PROFILE, 'too long after');
  o.touch('tv1', 2, NOW + 200 * MIN);
  o.start('tv1', NOW + 200 * MIN);
  o.stop('tv1', false, NOW + 210 * MIN);
  assert.equal(o.start('tv1', NOW + 210 * MIN + 30_000 + TOUCH_WINDOW), MAIN_PROFILE, 'stopped by hand, then something else');
});

test('a removed profile is forgotten on every TV: what plays next is the main profile\'s', () => {
  const o = new TvOwners();
  o.touch('tv1', 2, NOW);
  o.touch('tv2', 2, NOW);
  o.start('tv2', NOW);
  o.stop('tv2', true, NOW + 50 * MIN);
  o.touch('tv3', 3, NOW);
  o.forget(2);
  assert.equal(o.start('tv1', NOW + MIN), MAIN_PROFILE);
  assert.equal(o.start('tv2', NOW + 50 * MIN + 30_000), MAIN_PROFILE, 'nor the next episode');
  assert.equal(o.start('tv3', NOW + MIN), 3, 'others stay');
});

function seed() {
  const db = openDb(':memory:');
  const anna = addProfile(db, { name: 'Anna', color: PROFILE_COLORS[1] }).id;
  const film = Number(db.prepare(`INSERT INTO items (path, folder, category, kodi_id, kodi_type, playcount, resume, last_played, added_at, updated_at)
    VALUES ('MOVIES/A.mkv', 'MOVIES', 'movies', 12, 'movie', 1, NULL, ?, 1, 1)`).run(kodiDate(NOW - 5 * 24 * 60 * MIN)).lastInsertRowid);
  db.prepare('INSERT INTO film_states (profile_id, item_id, playcount, last_played) VALUES (1, ?, 1, ?)').run(film, kodiDate(NOW - 5 * 24 * 60 * MIN));
  const show = Number(db.prepare(`INSERT INTO items (path, folder, category, is_dir, kodi_id, kodi_type, added_at, updated_at)
    VALUES ('SERIES/S', 'SERIES', 'series', 1, 5, 'tvshow', 1, 1)`).run().lastInsertRowid);
  const ep = Number(db.prepare(`INSERT INTO episodes (item_id, path, season, episode, kodi_id, playcount) VALUES (?, 'SERIES/S/E01.mkv', 1, 1, 101, 0)`).run(show).lastInsertRowid);
  return { db, anna, film, ep };
}

const states = (db: DB, table: 'film_states' | 'episode_states', key: 'item_id' | 'episode_id', id: number) =>
  db.prepare(`SELECT profile_id, playcount, resume, last_played FROM ${table} WHERE ${key} = ? ORDER BY profile_id`).all(id).map((r) => ({ ...r }));

test('Kodi changes after a sync go to the owner of the play, or to the main profile', () => {
  const { db, anna, film, ep } = seed();
  notePlay(db, 'movie', 12, anna, NOW);
  notePlay(db, 'episode', 101, anna, NOW);
  const before = kodiStates(db);
  // What the sync writes: Anna stopped the film halfway and watched the episode to the end.
  db.prepare('UPDATE items SET resume = 0.5, last_played = ? WHERE id = ?').run(kodiDate(NOW + 60 * MIN), film);
  db.prepare('UPDATE episodes SET playcount = 1, last_played = ? WHERE id = ?').run(kodiDate(NOW + 30 * MIN), ep);
  assert.equal(attributeKodiChanges(db, before), 2);
  assert.deepEqual(states(db, 'film_states', 'item_id', film), [
    { profile_id: 1, playcount: 1, resume: null, last_played: kodiDate(NOW - 5 * 24 * 60 * MIN) },
    { profile_id: anna, playcount: 0, resume: 0.5, last_played: kodiDate(NOW + 60 * MIN) },
  ]);
  assert.deepEqual(states(db, 'episode_states', 'episode_id', ep), [{ profile_id: anna, playcount: 1, resume: null, last_played: kodiDate(NOW + 30 * MIN) }]);
  assert.equal(attributeKodiChanges(db, kodiStates(db)), 0, 'nothing changed since');
});

test('a change with no play noted, or noted before the previous one, is the main profile\'s', () => {
  const { db, anna, film, ep } = seed();
  // Anna's play was before the film's last play: this new change is someone else's, on the TV remote.
  notePlay(db, 'movie', 12, anna, NOW - 6 * 24 * 60 * MIN);
  const before = kodiStates(db);
  db.prepare('UPDATE items SET playcount = 2, last_played = ? WHERE id = ?').run(kodiDate(NOW), film);
  db.prepare('UPDATE episodes SET resume = 0.3, last_played = ? WHERE id = ?').run(kodiDate(NOW), ep);
  attributeKodiChanges(db, before);
  assert.deepEqual(states(db, 'film_states', 'item_id', film), [{ profile_id: 1, playcount: 2, resume: null, last_played: kodiDate(NOW) }]);
  assert.deepEqual(states(db, 'episode_states', 'episode_id', ep), [{ profile_id: 1, playcount: 0, resume: 0.3, last_played: kodiDate(NOW) }]);
  // Marked unwatched in Kodi: the owner's count goes back to 0 too.
  const again = kodiStates(db);
  db.prepare('UPDATE items SET playcount = 0 WHERE id = ?').run(film);
  attributeKodiChanges(db, again);
  assert.equal(states(db, 'film_states', 'item_id', film)[0]!.playcount, 0);
});

test('a play noted by the Play button alone is enough (no events from the TV)', () => {
  const { db, anna, film } = seed();
  const before = kodiStates(db);
  notePlay(db, 'movie', 12, anna, NOW); // what /items/:id/play does
  db.prepare('UPDATE items SET resume = 0.2, last_played = ? WHERE id = ?').run(kodiDate(NOW + 20 * MIN), film);
  attributeKodiChanges(db, before);
  assert.equal(states(db, 'film_states', 'item_id', film).find((r) => r.profile_id === anna)?.resume, 0.2);
});

test('a play noted long before the change Kodi reports is not its owner (a Play that never started)', () => {
  const { db, anna, film } = seed();
  notePlay(db, 'movie', 12, anna, NOW);
  const before = kodiStates(db);
  db.prepare('UPDATE items SET resume = 0.3, last_played = ? WHERE id = ?').run(kodiDate(NOW + CLAIM_WINDOW + 60 * MIN), film);
  attributeKodiChanges(db, before);
  assert.deepEqual(states(db, 'film_states', 'item_id', film).map((r) => r.profile_id), [MAIN_PROFILE]);
});

test('a noted play gives one play: a later change, started with the TV remote, is the main profile\'s', () => {
  const { db, anna, film } = seed();
  notePlay(db, 'movie', 12, anna, NOW);
  let before = kodiStates(db);
  // Kodi may stamp the last play when it starts.
  db.prepare('UPDATE items SET resume = 0.5, last_played = ? WHERE id = ?').run(kodiDate(NOW + MIN), film);
  attributeKodiChanges(db, before, NOW + 70 * MIN);
  before = kodiStates(db);
  db.prepare('UPDATE items SET resume = 0.2, last_played = ? WHERE id = ?').run(kodiDate(NOW + 120 * MIN), film);
  attributeKodiChanges(db, before, NOW + 180 * MIN);
  assert.deepEqual(states(db, 'film_states', 'item_id', film).map((r) => [r.profile_id, r.resume]), [[MAIN_PROFILE, 0.2], [anna, 0.5]]);
  // Anna plays it again from the app: hers again.
  notePlay(db, 'movie', 12, anna, NOW + 200 * MIN);
  before = kodiStates(db);
  db.prepare('UPDATE items SET resume = 0.6, last_played = ? WHERE id = ?').run(kodiDate(NOW + 201 * MIN), film);
  attributeKodiChanges(db, before, NOW + 260 * MIN);
  assert.equal(states(db, 'film_states', 'item_id', film).find((r) => r.profile_id === anna)?.resume, 0.6);
});

test('a play Kodi chained by itself is told apart from one started from the app', () => {
  const o = new TvOwners();
  o.touch('tv1', 2, NOW);
  o.start('tv1', NOW + 10_000);
  assert.equal(o.chained('tv1'), false, 'Play from the app');
  o.stop('tv1', true, NOW + 50 * MIN);
  o.start('tv1', NOW + 50 * MIN + 20_000);
  assert.equal(o.chained('tv1'), true, 'the next episode');
  o.stop('tv1', false, NOW + 60 * MIN);
  o.start('tv1', NOW + 100 * MIN);
  assert.equal(o.chained('tv1'), false, 'the TV remote');
  assert.equal(o.chained('tv2'), false, 'never played');
});
