import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { continueWatching, dismissWatching, noteStreamed } from '../server/watching.ts';

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
