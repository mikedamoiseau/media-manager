import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type DB } from '../server/db.ts';
import * as w from '../server/watching.ts';
import { marks, itemDetail } from '../server/views.ts';
import { MAIN_PROFILE, PROFILE_COLORS, addProfile } from '../server/profiles.ts';
import { notePlay, kodiStates, attributeKodiChanges } from '../server/owners.ts';

// The main profile's, as these tests were before profiles.
const continueWatching = (db: DB, now: number) => w.continueWatching(db, MAIN_PROFILE, now);
const dismissWatching = (db: DB, id: number, now: number) => w.dismissWatching(db, MAIN_PROFILE, id, now);
const noteStreamed = (db: DB, id: number, start: number, sent: number, size: number, now: number) => w.noteStreamed(db, MAIN_PROFILE, id, start, sent, size, now);
const noteEpisodeStreamed = (db: DB, id: number, start: number, sent: number, size: number, now: number) => w.noteEpisodeStreamed(db, MAIN_PROFILE, id, start, sent, size, now);
const nextEpisode = (db: DB, id: number) => w.nextEpisode(db, id, MAIN_PROFILE);

const NOW = Date.parse('2026-10-24T12:00:00');
const DAY = 24 * 3600 * 1000;
const MB = 1024 * 1024;
const kodiDate = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 19).replace('T', ' ');

function seed() {
  const db = openDb(':memory:');
  const ins = db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, tmdb_id, match_state, present, hidden, resume, last_played, added_at, updated_at)
    VALUES (?, 'MOVIES', 'movies', ?, 'movie', ?, 'matched', ?, ?, ?, ?, 1, 1)`);
  const add = (name: string, o: { tmdb?: number; dir?: number; present?: number; hidden?: number; resume?: number; ago?: number } = {}) => {
    const last = o.ago === undefined ? null : kodiDate(NOW - o.ago);
    const id = Number(ins.run(`MOVIES/${name}`, o.dir ?? 0, o.tmdb ?? null, o.present ?? 1, o.hidden ?? 0, o.resume ?? null, last).lastInsertRowid);
    // Played on a TV: the main profile's progress.
    if (o.resume !== undefined || last) db.prepare('INSERT INTO film_states (profile_id, item_id, resume, last_played) VALUES (1, ?, ?, ?)').run(id, o.resume ?? null, last);
    return id;
  };
  const ids = {
    hp: add('HP 1', { tmdb: 671, resume: 0.64, ago: 3 * DAY }),
    mufasa: add('Mufasa', { tmdb: 762509, resume: 0.81, ago: 24 * DAY }),
    credits: add('Predator', { tmdb: 1, resume: 0.92, ago: DAY }), // end credits: watched
    barely: add('Masters', { tmdb: 2, resume: 0.015, ago: DAY }),
    stale: add('Dunkirk', { tmdb: 3, resume: 0.3, ago: 120 * DAY }),
    hidden: add('Hidden', { tmdb: 4, resume: 0.5, ago: DAY, hidden: 1 }),
    gone: add('Gone', { tmdb: 5, resume: 0.5, ago: DAY, present: 0 }),
    hpCopy: add('HP 1 4K', { tmdb: 671, resume: 0.2, ago: 30 * DAY }), // older progress on another copy
    fresh: add('Narnia', { tmdb: 411 }),
  };
  return { db, ids };
}

const list = (db: ReturnType<typeof seed>['db'], now = NOW) =>
  continueWatching(db, now).map((w) => `${(db.prepare('SELECT path FROM items WHERE id = ?').get(w.id) as { path: string }).path.slice(7)} ${Math.round(w.fraction * 100)}% ${w.where}`);

test('films started on the TV, latest first; finished, barely started, stale, hidden and gone ones left out', () => {
  const { db } = seed();
  assert.deepEqual(list(db), ['HP 1 64% tv', 'Mufasa 81% tv']);
});

test('progress in VLC comes from how far into the file the server got', () => {
  const { db, ids } = seed();
  const size = 4000 * MB;
  noteStreamed(db, ids.fresh, 0, 1200 * MB, size, NOW - 2 * 3600_000); // watched 30%
  noteStreamed(db, ids.fresh, size - 2 * MB, 2 * MB, size, NOW - 3600_000); // VLC reading the index at the end: not watching
  assert.deepEqual(list(db), ['Narnia 30% phone', 'HP 1 64% tv', 'Mufasa 81% tv']);
  // HP 1 resumed in VLC after the TV: the phone's position is the latest.
  noteStreamed(db, ids.hp, 2000 * MB, 1000 * MB, size, NOW - 60_000);
  assert.deepEqual(list(db), ['HP 1 75% phone', 'Narnia 30% phone', 'Mufasa 81% tv']);
  // Watched into the credits in VLC: done.
  noteStreamed(db, ids.fresh, 1200 * MB, 2500 * MB, size, NOW);
  assert.deepEqual(list(db), ['HP 1 75% phone', 'Mufasa 81% tv']);
});

test('removed by hand until played again', () => {
  const { db, ids } = seed();
  dismissWatching(db, ids.mufasa, NOW);
  assert.deepEqual(list(db), ['HP 1 64% tv']);
  noteStreamed(db, ids.mufasa, 0, 900 * MB, 1000 * MB, NOW + 60_000);
  assert.deepEqual(list(db, NOW + 120_000), ['HP 1 64% tv'], '90% in VLC: finished');
  noteStreamed(db, ids.mufasa, 0, 500 * MB, 1000 * MB, NOW + 180_000);
  assert.deepEqual(list(db, NOW + 240_000), ['Mufasa 50% phone', 'HP 1 64% tv'], 'played again: back');
});

test('pruned after 90 days without resuming', () => {
  const { db } = seed();
  assert.deepEqual(list(db, NOW + 70 * DAY), ['HP 1 64% tv']);
  assert.deepEqual(list(db, NOW + 90 * DAY), []);
});

type Ep = { s: number | null; e: number | null; plays?: number; resume?: number; ago?: number; phone?: number; phoneAgo?: number };

/** A series folder and its episodes: Kodi's plays, resume point and last play, and VLC's progress. */
function addShow(db: ReturnType<typeof seed>['db'], name: string, eps: Ep[], o: { present?: number; hidden?: number; profile?: number } = {}) {
  const id = Number(db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, match_state, present, hidden, added_at, updated_at)
    VALUES (?, 'SERIES', 'series', 1, 'tv', 'matched', ?, ?, 1, 1)`).run(`SERIES/${name}`, o.present ?? 1, o.hidden ?? 0).lastInsertRowid);
  const ins = db.prepare(`INSERT INTO episodes (item_id, path, season, episode, playcount, resume, last_played, streamed, streamed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const state = db.prepare(`INSERT INTO episode_states (profile_id, episode_id, playcount, resume, last_played, streamed, streamed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const ep = eps.map((x, i) => {
    const last = x.ago === undefined ? null : kodiDate(NOW - x.ago);
    const phoneAt = x.phoneAgo === undefined ? null : NOW - x.phoneAgo;
    const epId = Number(ins.run(id, `SERIES/${name}/${i}.mkv`, x.s, x.e, x.plays ?? 0, x.resume ?? null, last, null, null).lastInsertRowid);
    // Played on a TV or in VLC: the profile's progress (the main one's unless said).
    if (x.plays || x.resume !== undefined || last || phoneAt) state.run(o.profile ?? MAIN_PROFILE, epId, x.plays ?? 0, x.resume ?? null, last, x.phone ?? null, phoneAt);
    return epId;
  });
  return { id, ep };
}

const shows = (db: ReturnType<typeof seed>['db'], now = NOW) =>
  continueWatching(db, now)
    .filter((w) => w.episode)
    .map((w) => {
      const name = (db.prepare('SELECT path FROM items WHERE id = ?').get(w.id) as { path: string }).path.slice(7);
      return `${name} S${w.episode!.season}E${w.episode!.episode} ${Math.round(w.fraction * 100)}% ${w.where} ${w.seen!.watched}/${w.seen!.total}`;
    });

test('series: the episode in progress, else the one after the last you watched', () => {
  const { db } = seed();
  addShow(db, 'Dark', [{ s: 1, e: 1, plays: 1, ago: 5 * DAY }, { s: 1, e: 2, plays: 1, ago: 4 * DAY }, { s: 1, e: 3, resume: 0.4, ago: 2 * DAY }, { s: 1, e: 4 }]);
  // E2 skipped: what comes after E3, the latest, is E4.
  addShow(db, 'Lupin', [{ s: 1, e: 1, plays: 1, ago: 10 * DAY }, { s: 1, e: 2 }, { s: 1, e: 3, plays: 1, ago: 9 * DAY }, { s: 1, e: 4 }, { s: 0, e: 1 }]);
  // Watched to the end in VLC, on the phone.
  addShow(db, 'Phone', [{ s: 1, e: 1, phone: 0.95, phoneAgo: DAY }, { s: 1, e: 2 }]);
  // Only the extras left, last watched long ago, never started, hidden: not in the row.
  addShow(db, 'Done', [{ s: 1, e: 1, plays: 1, ago: DAY }, { s: 0, e: 1 }]);
  addShow(db, 'Old', [{ s: 1, e: 1, plays: 1, ago: 120 * DAY }, { s: 1, e: 2 }]);
  addShow(db, 'Fresh', [{ s: 1, e: 1 }, { s: 1, e: 2 }]);
  addShow(db, 'Hidden', [{ s: 1, e: 1, plays: 1, ago: DAY }, { s: 1, e: 2 }], { hidden: 1 });
  assert.deepEqual(shows(db), ['Phone S1E2 0% phone 1/2', 'Dark S1E3 40% tv 2/4', 'Lupin S1E4 0% tv 2/4']);
  // Films and series share the row, latest first.
  assert.deepEqual(continueWatching(db, NOW).map((w) => w.at), continueWatching(db, NOW).map((w) => w.at).sort((a, b) => b - a));
});

test('series: VLC progress on an episode comes from the bytes it took', () => {
  const { db } = seed();
  const { id, ep } = addShow(db, 'Shogun', [{ s: 1, e: 1, plays: 1, ago: 3 * DAY }, { s: 1, e: 2 }, { s: 1, e: 3 }]);
  noteEpisodeStreamed(db, ep[1]!, 0, 4 * MB, 2000 * MB, NOW - 3600_000); // a peek at the headers
  assert.deepEqual(shows(db), ['Shogun S1E2 0% tv 1/3']);
  noteEpisodeStreamed(db, ep[1]!, 0, 700 * MB, 2000 * MB, NOW - 60_000);
  assert.deepEqual(shows(db), ['Shogun S1E2 35% phone 1/3']);
  noteEpisodeStreamed(db, ep[1]!, 700 * MB, 1200 * MB, 2000 * MB, NOW);
  assert.deepEqual(shows(db), ['Shogun S1E3 0% phone 2/3']);
  assert.equal(nextEpisode(db, id)?.id, ep[2]);
});

test('series: removed by hand until an episode is played again', () => {
  const { db } = seed();
  const { id, ep } = addShow(db, 'Dark', [{ s: 1, e: 1, plays: 1, ago: DAY }, { s: 1, e: 2 }]);
  dismissWatching(db, id, NOW);
  assert.deepEqual(shows(db), []);
  noteEpisodeStreamed(db, ep[1]!, 0, 300 * MB, 1000 * MB, NOW + 60_000);
  assert.deepEqual(shows(db, NOW + 120_000), ['Dark S1E2 30% phone 1/2']);
});

test('the next episode to play: in progress, after the latest watched, then extras, then the first', () => {
  const { db } = seed();
  const a = addShow(db, 'A', [{ s: 1, e: 1, plays: 1, ago: 3 * DAY }, { s: 1, e: 2, resume: 0.5, ago: DAY }, { s: 1, e: 3 }]);
  const b = addShow(db, 'B', [{ s: 2, e: 1 }, { s: 1, e: 2, plays: 1, ago: DAY }, { s: 1, e: 1 }]);
  const c = addShow(db, 'C', [{ s: 1, e: 1, plays: 1, ago: DAY }, { s: 0, e: 1 }]);
  const d = addShow(db, 'D', [{ s: 1, e: 2, plays: 1, ago: DAY }, { s: 1, e: 1, plays: 1, ago: DAY }]);
  const e = addShow(db, 'E', [{ s: 1, e: 2 }, { s: 1, e: 1 }]);
  assert.equal(nextEpisode(db, a.id)?.id, a.ep[1]);
  assert.equal(nextEpisode(db, b.id)?.id, b.ep[0], 'S2E1 comes after S1E2');
  assert.equal(nextEpisode(db, c.id)?.id, c.ep[1], 'the extras once the rest is watched');
  assert.equal(nextEpisode(db, d.id)?.id, d.ep[1], 'all watched: from the start');
  assert.equal(nextEpisode(db, e.id)?.id, e.ep[1], 'nothing watched: the first');
});

test('series: a peek is where to go on, not watched; caught up to the last episode leaves the row', () => {
  const { db } = seed();
  // Kodi noted a play of E1 with no resume point and no play count: barely opened.
  const peek = addShow(db, 'Peek', [{ s: 1, e: 1, ago: DAY }, { s: 1, e: 2 }]);
  const rewatch = addShow(db, 'Rewatch', [{ s: 1, e: 1, ago: DAY }, { s: 1, e: 2 }, { s: 1, e: 3, plays: 1, ago: 30 * DAY }]);
  // Seasons 1-2 never played here; the finale of season 2 watched last.
  const caught = addShow(db, 'Caught', [{ s: 1, e: 1 }, { s: 2, e: 1, plays: 1, ago: 2 * DAY }, { s: 2, e: 2, plays: 1, ago: DAY }]);
  assert.deepEqual(shows(db), ['Rewatch S1E1 0% tv 1/3']);
  assert.equal(nextEpisode(db, peek.id)?.id, peek.ep[0]);
  assert.equal(nextEpisode(db, rewatch.id)?.id, rewatch.ep[0]);
  assert.equal(nextEpisode(db, caught.id)?.id, caught.ep[0], 'Play still starts what is left');
});

test('series: extras played last change nothing about where you are', () => {
  const { db } = seed();
  const a = addShow(db, 'A', [{ s: 1, e: 1, plays: 1, ago: 3 * DAY }, { s: 1, e: 2 }, { s: 0, e: 1, resume: 0.5, ago: DAY }]);
  const b = addShow(db, 'B', [{ s: 1, e: 1, plays: 1, ago: 3 * DAY }, { s: 1, e: 2 }, { s: 0, e: 1, plays: 1, ago: DAY }]);
  assert.deepEqual(shows(db), ['A S1E2 0% tv 1/2', 'B S1E2 0% tv 1/2']);
  assert.equal(nextEpisode(db, a.id)?.id, a.ep[1]);
  assert.equal(nextEpisode(db, b.id)?.id, b.ep[1]);
});

test('series: an episode finished in VLC stays watched when the TV resumes it later', () => {
  const { db } = seed();
  addShow(db, 'Dark', [{ s: 1, e: 1, phone: 0.95, phoneAgo: 2 * DAY, resume: 0.3, ago: DAY }, { s: 1, e: 2 }]);
  assert.deepEqual(shows(db), ['Dark S1E1 30% tv 1/2']);
});

const anna = (db: DB) => addProfile(db, { name: 'Anna', color: PROFILE_COLORS[1] }).id;
const names = (db: DB, list: Array<{ id: number }>) => list.map((x) => (db.prepare('SELECT path FROM items WHERE id = ?').get(x.id) as { path: string }).path.split('/')[1]);

test('continue watching is per profile', () => {
  const { db, ids } = seed();
  const a = anna(db);
  w.noteStreamed(db, a, ids.fresh, 0, 400 * MB, 1000 * MB, NOW - 60_000);
  const show = addShow(db, 'Dark', [{ s: 1, e: 1, plays: 1, ago: DAY }, { s: 1, e: 2 }], { profile: a });
  assert.deepEqual(names(db, w.continueWatching(db, a, NOW)), ['Narnia', 'Dark']);
  assert.deepEqual(names(db, w.continueWatching(db, MAIN_PROFILE, NOW)), ['HP 1', 'Mufasa']);
  w.dismissWatching(db, a, ids.hp, NOW);
  w.dismissWatching(db, a, show.id, NOW);
  assert.deepEqual(names(db, w.continueWatching(db, a, NOW + 1)), ['Narnia']);
  assert.deepEqual(names(db, w.continueWatching(db, MAIN_PROFILE, NOW + 1)), ['HP 1', 'Mufasa'], 'removed for Anna only');
});

test('next episode is per profile', () => {
  const { db } = seed();
  const a = anna(db);
  const show = addShow(db, 'Dark', [1, 2, 3, 4, 5, 6].map((e) => ({ s: 1, e })));
  const state = db.prepare('INSERT INTO episode_states (profile_id, episode_id, playcount, resume, last_played) VALUES (?, ?, ?, ?, ?)');
  state.run(MAIN_PROFILE, show.ep[0], 1, null, kodiDate(NOW - 3 * DAY));
  state.run(MAIN_PROFILE, show.ep[1], 1, null, kodiDate(NOW - 2 * DAY));
  state.run(MAIN_PROFILE, show.ep[2], 0, 0.4, kodiDate(NOW - DAY));
  for (const i of [0, 1, 2, 3, 4]) state.run(a, show.ep[i], 1, null, kodiDate(NOW - (10 - i) * 3600_000));
  assert.equal(w.nextEpisode(db, show.id, MAIN_PROFILE)?.id, show.ep[2]);
  assert.equal(w.nextEpisode(db, show.id, a)?.id, show.ep[5]);
});

test('marks are per profile: watched and in progress', () => {
  const { db, ids } = seed();
  const a = anna(db);
  db.prepare('UPDATE film_states SET playcount = 1 WHERE item_id = ?').run(ids.mufasa);
  const done = addShow(db, 'Done', [{ s: 1, e: 1, plays: 1, ago: DAY }, { s: 0, e: 1 }]);
  const half = addShow(db, 'Half', [{ s: 1, e: 1, plays: 1, ago: DAY }, { s: 1, e: 2 }]);
  const main = marks(db, MAIN_PROFILE);
  assert.ok(main.w.includes(ids.mufasa) && main.w.includes(done.id) && !main.w.includes(half.id) && !main.w.includes(ids.hp));
  assert.ok(main.rs.includes(ids.hp) && main.rs.includes(half.id) && !main.rs.includes(done.id));
  assert.deepEqual(marks(db, a), { w: [], rs: [] });
  w.noteStreamed(db, a, ids.fresh, 0, 950 * MB, 1000 * MB, NOW);
  w.noteStreamed(db, a, ids.hp, 0, 300 * MB, 1000 * MB, NOW);
  assert.deepEqual(marks(db, a), { w: [ids.fresh], rs: [ids.hp] });
});

test('only a film this profile watched can be rated', () => {
  const { db, ids } = seed();
  const a = anna(db);
  db.prepare('UPDATE film_states SET playcount = 1 WHERE item_id = ?').run(ids.mufasa);
  assert.equal(itemDetail(db, ids.mufasa, MAIN_PROFILE)?.canRate, true);
  assert.equal(itemDetail(db, ids.mufasa, a)?.canRate, false);
  w.noteStreamed(db, a, ids.mufasa, 0, 950 * MB, 1000 * MB, NOW);
  assert.equal(itemDetail(db, ids.mufasa, a)?.canRate, true);
  assert.equal(itemDetail(db, ids.hp, a)?.versions.find((v) => v.id === ids.hp)?.resume, null, "the main profile's resume point is not Anna's");
});

test("Play on TV starts at this profile's point, not someone else's", () => {
  const { db, ids } = seed();
  const a = anna(db);
  // Last played on a TV by Anna (Kodi's point is hers now): the main profile starts at its own.
  db.prepare("UPDATE items SET kodi_id = id + 100, kodi_type = 'movie' WHERE id IN (?, ?)").run(ids.hp, ids.credits);
  notePlay(db, 'movie', ids.hp + 100, a, NOW - 2 * DAY);
  notePlay(db, 'movie', ids.credits + 100, a, NOW - 2 * DAY);
  w.noteStreamed(db, a, ids.hp, 0, 700 * MB, 1000 * MB, NOW - 60_000);
  assert.equal(w.startPoint(db, MAIN_PROFILE, { itemId: ids.hp }), 64, 'its TV resume point');
  assert.equal(w.startPoint(db, a, { itemId: ids.hp }), 70, 'her VLC progress, newer than her TV play');
  assert.equal(w.startPoint(db, a, { itemId: ids.mufasa }), false, 'nothing played: from the start');
  assert.equal(w.startPoint(db, MAIN_PROFILE, { itemId: ids.credits }), false, 'finished: from the start');
  w.noteStreamed(db, MAIN_PROFILE, ids.hp, 0, 300 * MB, 1000 * MB, NOW);
  assert.equal(w.startPoint(db, MAIN_PROFILE, { itemId: ids.hp }), 30, 'the latest of TV and VLC');

  const show = addShow(db, 'Dark', [{ s: 1, e: 1, plays: 1, ago: 2 * DAY }, { s: 1, e: 2, resume: 0.4, ago: DAY }]);
  db.prepare('UPDATE episodes SET kodi_id = id + 500 WHERE item_id = ?').run(show.id);
  notePlay(db, 'episode', show.ep[1]! + 500, a, NOW - 3 * DAY);
  w.noteEpisodeStreamed(db, a, show.ep[1]!, 0, 700 * MB, 1000 * MB, NOW);
  assert.equal(w.startPoint(db, MAIN_PROFILE, { episodeId: show.ep[1]! }), 40);
  assert.equal(w.startPoint(db, a, { episodeId: show.ep[1]! }), 70);
  assert.equal(w.startPoint(db, a, { episodeId: show.ep[0]! }), false);
});

test("Play on TV: Kodi's own, live point when this profile played it there last (the app may not have synced it yet)", () => {
  const { db, ids } = seed();
  const a = anna(db);
  db.prepare("UPDATE items SET kodi_id = 12, kodi_type = 'movie' WHERE id = ?").run(ids.fresh);
  assert.equal(w.startPoint(db, MAIN_PROFILE, { itemId: ids.fresh }), true, 'no play noted: the TV remote\'s, the main profile\'s');
  assert.equal(w.startPoint(db, a, { itemId: ids.fresh }), false);
  notePlay(db, 'movie', 12, a, NOW);
  assert.equal(w.startPoint(db, a, { itemId: ids.fresh }), true, 'stopped a minute ago: not synced yet');
  assert.equal(w.startPoint(db, MAIN_PROFILE, { itemId: ids.fresh }), false, 'Kodi\'s point is Anna\'s');
  w.noteStreamed(db, a, ids.fresh, 0, 500 * MB, 1000 * MB, NOW + 60_000);
  assert.equal(w.startPoint(db, a, { itemId: ids.fresh }), 50, 'then further in VLC');
  // Synced: her TV play is in her own progress now, and Kodi's point may since be someone else's.
  notePlay(db, 'movie', 12, a, NOW + 2 * 60_000);
  const before = kodiStates(db);
  db.prepare('UPDATE items SET resume = 0.55, last_played = ? WHERE id = ?').run(kodiDate(NOW + 30 * 60_000), ids.fresh);
  attributeKodiChanges(db, before, NOW + 40 * 60_000);
  assert.equal(w.startPoint(db, a, { itemId: ids.fresh }), 55);
});
