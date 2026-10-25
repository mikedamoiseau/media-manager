import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { continueWatching, dismissWatching, noteStreamed, noteEpisodeStreamed, nextEpisode } from '../server/watching.ts';

const NOW = Date.parse('2026-10-24T12:00:00');
const DAY = 24 * 3600 * 1000;
const MB = 1024 * 1024;
const kodiDate = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 19).replace('T', ' ');

function seed() {
  const db = openDb(':memory:');
  const ins = db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, tmdb_id, match_state, present, hidden, resume, last_played, added_at, updated_at)
    VALUES (?, 'MOVIES', 'movies', ?, 'movie', ?, 'matched', ?, ?, ?, ?, 1, 1)`);
  const add = (name: string, o: { tmdb?: number; dir?: number; present?: number; hidden?: number; resume?: number; ago?: number } = {}) =>
    Number(ins.run(`MOVIES/${name}`, o.dir ?? 0, o.tmdb ?? null, o.present ?? 1, o.hidden ?? 0, o.resume ?? null, o.ago === undefined ? null : kodiDate(NOW - o.ago)).lastInsertRowid);
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
function addShow(db: ReturnType<typeof seed>['db'], name: string, eps: Ep[], o: { present?: number; hidden?: number } = {}) {
  const id = Number(db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, match_state, present, hidden, added_at, updated_at)
    VALUES (?, 'SERIES', 'series', 1, 'tv', 'matched', ?, ?, 1, 1)`).run(`SERIES/${name}`, o.present ?? 1, o.hidden ?? 0).lastInsertRowid);
  const ins = db.prepare(`INSERT INTO episodes (item_id, path, season, episode, playcount, resume, last_played, streamed, streamed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const ep = eps.map((x, i) =>
    Number(ins.run(id, `SERIES/${name}/${i}.mkv`, x.s, x.e, x.plays ?? 0, x.resume ?? null, x.ago === undefined ? null : kodiDate(NOW - x.ago),
      x.phone ?? null, x.phoneAgo === undefined ? null : NOW - x.phoneAgo).lastInsertRowid));
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
