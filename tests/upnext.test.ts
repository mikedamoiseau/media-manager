import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { MAIN_PROFILE, PROFILE_COLORS, addProfile, removeProfile } from '../server/profiles.ts';
import {
  STALE, AFTER_THIS_LAPSE, SLEEP_GRACE, UpNextError, upNext, upNextEntries, addToUpNext, removeFromUpNext, clearUpNext, takeFromUpNext,
  dropStale, episodeToQueue, sleepOf, setSleep, clearSleep, dueSleeps, forgetTv,
} from '../server/upnext.ts';

const T0 = Date.UTC(2026, 9, 29, 20);

/** A film, and a series with S1E1–E3 and an extra, each episode known to Kodi as 100 + its number. */
function library() {
  const db = openDb(':memory:');
  const item = db.prepare(`INSERT INTO items (path, folder, category, is_dir, match_state, present, added_at, updated_at)
    VALUES (?, ?, ?, ?, 'unmatched', 1, 1, 1)`);
  const film = Number(item.run('MOVIES/Film.mkv', 'MOVIES', 'movies', 0).lastInsertRowid);
  const other = Number(item.run('MOVIES/Other.mkv', 'MOVIES', 'movies', 0).lastInsertRowid);
  const show = Number(item.run('SERIES/Show', 'SERIES', 'series', 1).lastInsertRowid);
  const ep = db.prepare('INSERT INTO episodes (item_id, path, season, episode, title, kodi_id) VALUES (?, ?, ?, ?, ?, ?)');
  const e = (s: number, n: number, kodi: number) => Number(ep.run(show, `SERIES/Show/S${s}E${n}.mkv`, s, n, `Part ${n}`, kodi).lastInsertRowid);
  const eps = { extra: e(0, 1, 200), e1: e(1, 1, 101), e2: e(1, 2, 102), e3: e(1, 3, 103) };
  const otherShow = Number(item.run('SERIES/Other', 'SERIES', 'series', 1).lastInsertRowid);
  ep.run(otherShow, 'SERIES/Other/S1E1.mkv', 1, 1, null, 301);
  return { db, film, other, show, eps };
}

test('adds in order and refuses a duplicate', () => {
  const { db, film, other } = library();
  const a = addToUpNext(db, 'tv1', MAIN_PROFILE, film, null, T0);
  const b = addToUpNext(db, 'tv1', MAIN_PROFILE, other, null, T0);
  assert.deepEqual(upNext(db, 'tv1').map((r) => r.id), [a.id, b.id]);
  assert.deepEqual(upNext(db, 'tv1')[0], { id: a.id, tvId: 'tv1', itemId: film, episodeId: null, profileId: MAIN_PROFILE });
  assert.throws(() => addToUpNext(db, 'tv1', MAIN_PROFILE, film, null, T0), (e: unknown) => e instanceof UpNextError && e.code === 'duplicate');
  addToUpNext(db, 'tv2', MAIN_PROFILE, film, null, T0);
  assert.equal(upNext(db, 'tv2').length, 1, 'another TV has a list of its own');
});

test('an episode is a duplicate only of itself', () => {
  const { db, show, eps } = library();
  addToUpNext(db, 'tv1', MAIN_PROFILE, show, eps.e1, T0);
  addToUpNext(db, 'tv1', MAIN_PROFILE, show, eps.e2, T0);
  assert.throws(() => addToUpNext(db, 'tv1', MAIN_PROFILE, show, eps.e2, T0), UpNextError);
  assert.deepEqual(upNextEntries(db, 'tv1').map((e) => [e.itemId, e.episodeId, e.season, e.episode, e.episodeTitle]), [
    [show, eps.e1, 1, 1, 'Part 1'],
    [show, eps.e2, 1, 2, 'Part 2'],
  ]);
});

test('takes the first entry or the one asked, refreshing the rest', () => {
  const { db, film, other } = library();
  const a = addToUpNext(db, 'tv1', MAIN_PROFILE, film, null, T0);
  const b = addToUpNext(db, 'tv1', MAIN_PROFILE, other, null, T0);
  assert.equal(takeFromUpNext(db, 'tv1', T0 + 1000)?.id, a.id);
  assert.equal((db.prepare('SELECT at FROM up_next WHERE id = ?').get(b.id) as { at: number }).at, T0 + 1000);
  assert.equal(takeFromUpNext(db, 'tv2', T0), undefined, "another TV's list is empty");
  assert.equal(takeFromUpNext(db, 'tv1', T0, a.id), undefined, 'already taken');
  assert.equal(takeFromUpNext(db, 'tv1', T0, b.id)?.id, b.id);
  assert.equal(takeFromUpNext(db, 'tv1', T0), undefined);
});

test('removes one entry, or all of a TV', () => {
  const { db, film, other } = library();
  const a = addToUpNext(db, 'tv1', MAIN_PROFILE, film, null, T0);
  addToUpNext(db, 'tv1', MAIN_PROFILE, other, null, T0);
  addToUpNext(db, 'tv2', MAIN_PROFILE, film, null, T0);
  assert.equal(removeFromUpNext(db, 'tv2', a.id), false, "not that TV's");
  assert.equal(removeFromUpNext(db, 'tv1', a.id), true);
  assert.equal(upNext(db, 'tv1').length, 1);
  clearUpNext(db, 'tv1');
  assert.equal(upNext(db, 'tv1').length, 0);
  assert.equal(upNext(db, 'tv2').length, 1);
});

test('clears a list untouched for 6 hours', () => {
  const { db, film, other } = library();
  addToUpNext(db, 'tv1', MAIN_PROFILE, film, null, T0);
  addToUpNext(db, 'tv1', MAIN_PROFILE, other, null, T0 + 1000);
  assert.equal(STALE, 6 * 3600_000);
  assert.deepEqual(dropStale(db, T0 + 1000 + STALE), []);
  assert.equal(upNext(db, 'tv1').length, 2, 'an add refreshes the whole list');
  assert.deepEqual(dropStale(db, T0 + 1000 + STALE + 1), ['tv1']);
  assert.equal(upNext(db, 'tv1').length, 0);
});

test('queues the episode after the last queued one', () => {
  const { db, show, eps } = library();
  assert.equal(episodeToQueue(db, 'tv1', show, MAIN_PROFILE), eps.e1, 'nothing queued or playing: where the series stands');
  addToUpNext(db, 'tv1', MAIN_PROFILE, show, eps.e1, T0);
  assert.equal(episodeToQueue(db, 'tv1', show, MAIN_PROFILE), eps.e2);
  addToUpNext(db, 'tv1', MAIN_PROFILE, show, eps.e3, T0);
  assert.equal(episodeToQueue(db, 'tv1', show, MAIN_PROFILE), undefined, 'nothing after the last episode');
  assert.equal(episodeToQueue(db, 'tv2', show, MAIN_PROFILE), eps.e1, "another TV's list doesn't count");
});

test('queues the episode after the one playing', () => {
  const { db, show, eps } = library();
  assert.equal(episodeToQueue(db, 'tv1', show, MAIN_PROFILE, 102), eps.e3);
  assert.equal(episodeToQueue(db, 'tv1', show, MAIN_PROFILE, 103), undefined, 'the last one plays');
  assert.equal(episodeToQueue(db, 'tv1', show, MAIN_PROFILE, 301), eps.e1, 'an episode of another series: where this one stands');
  addToUpNext(db, 'tv1', MAIN_PROFILE, show, eps.e1, T0);
  assert.equal(episodeToQueue(db, 'tv1', show, MAIN_PROFILE, 102), eps.e2, 'the list comes first');
});

test('an extra queued is no base, and nothing queued is queued again', () => {
  const { db, show, eps } = library();
  addToUpNext(db, 'tv1', MAIN_PROFILE, show, eps.e1, T0);
  addToUpNext(db, 'tv1', MAIN_PROFILE, show, eps.extra, T0);
  assert.equal(episodeToQueue(db, 'tv1', show, MAIN_PROFILE), eps.e2, 'after the last episode queued, extras aside');
  clearUpNext(db, 'tv1');
  // All seen: where the series stands is the extra not seen, already queued.
  const seen = db.prepare("INSERT INTO episode_states (profile_id, episode_id, playcount, last_played) VALUES (?, ?, 1, '2026-10-28 21:00:00')");
  for (const id of [eps.e1, eps.e2, eps.e3]) seen.run(MAIN_PROFILE, id);
  assert.equal(episodeToQueue(db, 'tv1', show, MAIN_PROFILE), eps.extra);
  addToUpNext(db, 'tv1', MAIN_PROFILE, show, eps.extra, T0);
  assert.equal(episodeToQueue(db, 'tv1', show, MAIN_PROFILE), undefined);
});

test('removes entries with their profile', () => {
  const { db, film } = library();
  const anna = addProfile(db, { name: 'Anna', color: PROFILE_COLORS[1] }).id;
  addToUpNext(db, 'tv1', anna, film, null, T0);
  removeProfile(db, anna);
  assert.equal(upNext(db, 'tv1').length, 0);
});

test('a TV forgotten takes its list and its timer', () => {
  const { db, film } = library();
  addToUpNext(db, 'tv1', MAIN_PROFILE, film, null, T0);
  setSleep(db, 'tv1', { minutes: 30 }, T0);
  forgetTv(db, 'tv1');
  assert.equal(upNext(db, 'tv1').length, 0);
  assert.equal(sleepOf(db, 'tv1', T0), null);
});

test('sets, reads and fires timers', () => {
  const { db } = library();
  assert.equal(sleepOf(db, 'tv1', T0), null);
  setSleep(db, 'tv1', { minutes: 45 }, T0);
  assert.deepEqual(sleepOf(db, 'tv1', T0), { at: T0 + 45 * 60_000 });
  assert.deepEqual(dueSleeps(db, T0 + 45 * 60_000 - 1), { stop: [], lapsed: [] });
  assert.deepEqual(dueSleeps(db, T0 + 45 * 60_000), { stop: ['tv1'], lapsed: [] });
  assert.equal(sleepOf(db, 'tv1', T0), null);

  setSleep(db, 'tv1', { afterThis: true }, T0);
  assert.deepEqual(sleepOf(db, 'tv1', T0 + 1), { afterThis: true });
  assert.equal(AFTER_THIS_LAPSE, 6 * 3600_000);
  assert.equal(sleepOf(db, 'tv1', T0 + AFTER_THIS_LAPSE + 1), null, 'one left behind has lapsed');
  assert.deepEqual(dueSleeps(db, T0 + AFTER_THIS_LAPSE), { stop: [], lapsed: [] });
  assert.deepEqual(dueSleeps(db, T0 + AFTER_THIS_LAPSE + 1), { stop: [], lapsed: ['tv1'] });

  setSleep(db, 'tv1', { minutes: 15 }, T0);
  setSleep(db, 'tv1', { afterThis: true }, T0);
  assert.deepEqual(sleepOf(db, 'tv1', T0), { afterThis: true }, 'a new timer replaces the old');
  clearSleep(db, 'tv1');
  assert.equal(sleepOf(db, 'tv1', T0), null);
});

test('a timer missed by more than 10 minutes (the Mac slept) stops nothing', () => {
  const { db } = library();
  assert.equal(SLEEP_GRACE, 10 * 60_000);
  setSleep(db, 'tv1', { minutes: 30 }, T0);
  setSleep(db, 'tv2', { minutes: 30 }, T0);
  assert.deepEqual(dueSleeps(db, T0 + 30 * 60_000 + SLEEP_GRACE).stop, ['tv1', 'tv2'], 'late, within the grace');
  setSleep(db, 'tv1', { minutes: 30 }, T0);
  assert.deepEqual(dueSleeps(db, T0 + 30 * 60_000 + SLEEP_GRACE + 1), { stop: [], lapsed: ['tv1'] });
  assert.equal(sleepOf(db, 'tv1', T0), null);
});
