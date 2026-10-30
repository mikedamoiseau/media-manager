import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type DB } from '../server/db.ts';
import { PROFILE_COLORS, addProfile } from '../server/profiles.ts';
import { img } from '../server/views.ts';
import { MIN_WATCHED, yearInFilm, yearToShow } from '../server/yearInFilm.ts';

/** Local time, as the year and its hours are. */
const at = (month: number, day: number, hour = 20, minute = 0, year = 2026) => new Date(year, month, day, hour, minute).getTime();
const NOW = at(11, 15);
const TVS = new Map([['tv1', 'Living room'], ['tv2', 'Bedroom'], ['phone', 'On the phone']]);

let paths = 0;
/** A film or series matched on TMDB (a second item of the same `tmdb`: another copy, another season's folder). */
function title(db: DB, o: { name: string; type?: 'movie' | 'tv'; tmdb?: number; year?: number; genres?: string[]; cast?: string[]; runtime?: number | null; present?: number }): number {
  const type = o.type ?? 'movie';
  const tmdb = o.tmdb ?? ++paths + 1000;
  db.prepare(`INSERT OR IGNORE INTO titles (media_type, tmdb_id, title_en, year, genres, cast_json, runtime, poster, backdrop, source, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'tmdb', 1)`).run(
    type, tmdb, o.name, o.year ?? 2000, JSON.stringify(o.genres ?? []), JSON.stringify((o.cast ?? []).map((name) => ({ name, character: '' }))),
    o.runtime === undefined ? 100 : o.runtime, `https://tmdb/${o.name}.jpg`, `https://tmdb/${o.name}-wide.jpg`,
  );
  return Number(db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, tmdb_id, match_state, present, added_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'matched', ?, 1, 1)`).run(
    `X/${o.name}.${++paths}`, 'X', type === 'tv' ? 'series' : 'movies', type === 'tv' ? 1 : 0, type, tmdb, o.present ?? 1,
  ).lastInsertRowid);
}

/** A play in the log: logged on tv1 unless estimated (then no TV). */
function play(db: DB, o: { item: number; at: number; profile?: number; episode?: number | null; minutes?: number | null; reached?: number | null; finished?: boolean; estimated?: boolean; device?: string | null }) {
  const tv = (db.prepare('SELECT media_type FROM items WHERE id = ?').get(o.item) as { media_type: string | null }).media_type === 'tv';
  db.prepare(`INSERT INTO plays (profile_id, item_id, kind, episode_id, device, at, minutes, reached, finished, estimated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    o.profile ?? 1, o.item, tv ? 'episode' : 'film', o.episode ?? null, o.device !== undefined ? o.device : o.estimated ? null : 'tv1', o.at,
    o.minutes !== undefined ? o.minutes : o.estimated ? null : 100, o.reached ?? null, o.finished ? 1 : 0, o.estimated ? 1 : 0,
  );
}

/** Films watched, enough for a year. */
function enough(db: DB, n = MIN_WATCHED, day = 1) {
  for (let i = 0; i < n; i++) play(db, { item: title(db, { name: `Filler ${paths}` }), at: at(5, day + i), finished: true });
}

test('counts: finished films and episodes, rewatches again, plays under 5 minutes nowhere', () => {
  const db = openDb(':memory:');
  const a = title(db, { name: 'Film A' });
  const b = title(db, { name: 'Film B' });
  const c = title(db, { name: 'Film C' });
  const s = title(db, { name: 'Show', type: 'tv' });
  const ep = db.prepare("INSERT INTO episodes (item_id, path, season, episode, runtime) VALUES (?, ?, 1, ?, 42)");
  const eps = [1, 2].map((n) => Number(ep.run(s, `X/Show/${n}.mkv`, n).lastInsertRowid));
  play(db, { item: a, at: at(2, 1), finished: true });
  play(db, { item: b, at: at(2, 2), minutes: 40 });
  play(db, { item: a, at: at(2, 3), finished: true });
  play(db, { item: c, at: at(2, 4), minutes: 3 });
  play(db, { item: s, episode: eps[0], at: at(2, 5, 21), minutes: 42, finished: true });
  play(db, { item: s, episode: eps[1], at: at(2, 5, 22), minutes: 50, finished: true });
  // Someone else's.
  const anna = addProfile(db, { name: 'Anna', color: PROFILE_COLORS[1] }).id;
  play(db, { profile: anna, item: b, at: at(2, 6), finished: true });

  const y = yearInFilm(db, 1, 2026, NOW, TVS)!;
  assert.deepEqual([y.year, y.from, y.to], [2026, at(0, 1, 0), NOW]);
  assert.deepEqual([y.films, y.episodes, y.plays, y.titles], [2, 2, 5, 2]);
  assert.equal(y.hours, Math.round((100 + 100 + 40 + 42 + 42) / 60), 'measured minutes, at most the runtime');
  assert.equal(y.estimated, false);
  assert.equal(y.hours24.reduce((n, h) => n + h, 0), 5, 'the 3-minute play is not a play');
  assert.deepEqual(y.posters, [img('https://tmdb/Show.jpg', 342), img('https://tmdb/Film A.jpg', 342), img('https://tmdb/Film B.jpg', 342)]);
});

test('only films and series matched on TMDB count', () => {
  const db = openDb(':memory:');
  enough(db);
  const fitness = Number(db.prepare(`INSERT INTO items (path, folder, category, is_dir, match_state, added_at, updated_at)
    VALUES ('FITNESS/Yoga.mkv', 'FITNESS', 'fitness', 0, 'none', 1, 1)`).run().lastInsertRowid);
  play(db, { item: fitness, at: at(5, 20), minutes: 60, finished: true });
  const y = yearInFilm(db, 1, 2026, NOW, TVS)!;
  assert.deepEqual([y.films, y.plays, y.hours], [3, 3, 5]);
});

test('genres, the actor and the oldest film count each title once', () => {
  const db = openDb(':memory:');
  const f1 = title(db, { name: 'F1', tmdb: 1, year: 1999, genres: ['Drama', 'Comedy'], cast: ['X', 'Y'] });
  const f1copy = title(db, { name: 'F1', tmdb: 1 });
  const f2 = title(db, { name: 'F2', year: 1985, genres: ['Drama'], cast: ['X'] });
  const f3 = title(db, { name: 'F3', year: 2010, genres: ['War', 'Drama', 'Western', 'Crime', 'Action'], cast: ['Y'] });
  const s = title(db, { name: 'S', type: 'tv', year: 1970, genres: ['Animation', 'Drama'], cast: ['Z'] });
  const started = title(db, { name: 'Started', year: 1950, genres: ['Horror'], cast: ['X'] });
  play(db, { item: f1, at: at(1, 1), finished: true });
  play(db, { item: f1, at: at(1, 2), finished: true });
  play(db, { item: f1copy, at: at(1, 3), finished: true });
  play(db, { item: f2, at: at(1, 4), finished: true });
  play(db, { item: f3, at: at(1, 5), finished: true });
  play(db, { item: s, at: at(1, 6), minutes: 40, finished: true });
  play(db, { item: s, at: at(1, 7), minutes: 40, finished: true });
  play(db, { item: started, at: at(1, 8), minutes: 30 });

  const y = yearInFilm(db, 1, 2026, NOW, TVS)!;
  assert.equal(y.titles, 4, 'F1 (two copies), F2, F3, S; not the one only started');
  assert.deepEqual(y.genres, [
    { name: 'Drama', n: 4 }, { name: 'Action', n: 1 }, { name: 'Animation', n: 1 }, { name: 'Comedy', n: 1 }, { name: 'Crime', n: 1 },
  ]);
  assert.deepEqual(
    { ...y.actor!, titles: y.actor!.titles.map((t) => t.name) },
    { name: 'X', n: 2, tie: 'Y', photo: null, titles: ['F2', 'F1'] },
  );
  assert.deepEqual(y.oldest, { itemId: f2, name: 'F2', poster: img('https://tmdb/F2.jpg', 342), year: 1985 }, 'a film, not the series');
});

test('the actor: in at least two titles, among the first eight names of each', () => {
  const db = openDb(':memory:');
  const eight = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'];
  play(db, { item: title(db, { name: 'G1', cast: [...eight, 'W', 'W2'] }), at: at(3, 1), finished: true });
  play(db, { item: title(db, { name: 'G2', cast: ['W', 'B1'] }), at: at(3, 2), finished: true });
  play(db, { item: title(db, { name: 'G3', cast: ['C1', 'W2'] }), at: at(3, 3), finished: true });
  assert.equal(yearInFilm(db, 1, 2026, NOW, TVS)!.actor, null);
});

test('the series: most episodes first', () => {
  const db = openDb(':memory:');
  const shows = [2, 5, 1, 3, 4].map((n) => ({ n, item: title(db, { name: `Show ${n}`, type: 'tv' }) }));
  // A season in a folder of its own is the same series.
  const more = title(db, { name: 'Show 2', type: 'tv', tmdb: (db.prepare('SELECT tmdb_id FROM items WHERE id = ?').get(shows[0]!.item) as { tmdb_id: number }).tmdb_id });
  for (const s of shows) for (let i = 0; i < s.n; i++) play(db, { item: s.item, at: at(4, 1 + i, 20 + s.n % 3), minutes: 40, finished: true });
  play(db, { item: more, at: at(4, 9), minutes: 40, finished: true });
  play(db, { item: more, at: at(4, 10), minutes: 40 });
  const y = yearInFilm(db, 1, 2026, NOW, TVS)!;
  assert.deepEqual(y.series.map((s) => [s.name, s.episodes]), [['Show 5', 5], ['Show 4', 4], ['Show 2', 3], ['Show 3', 3]]);
  assert.equal(y.series[0]!.backdrop, img('https://tmdb/Show 5-wide.jpg', 1280));
  assert.equal(y.series[2]!.itemId, more, 'the latest played');
});

test('prime time: the local hour each play started', () => {
  const db = openDb(':memory:');
  const f = title(db, { name: 'F' });
  for (const [h, m, d] of [[22, 10, 1], [22, 50, 2], [23, 5, 3], [0, 30, 4]] as const) play(db, { item: f, at: at(6, d, h, m), finished: true });
  const y = yearInFilm(db, 1, 2026, NOW, TVS)!;
  assert.deepEqual([y.primeHour, y.primeCount, y.afterMidnight, y.plays], [22, 2, 1, 4]);
  assert.deepEqual([y.hours24.length, y.hours24[22], y.hours24[23], y.hours24[0]], [24, 2, 1, 1]);
});

test('which TV: logged plays only, named, since the first one', () => {
  const db = openDb(':memory:');
  enough(db, MIN_WATCHED, 1);
  const f = title(db, { name: 'F' });
  db.prepare("UPDATE plays SET device = NULL, estimated = 1, minutes = NULL, reached = 1").run();
  play(db, { item: f, at: at(9, 30), finished: true });
  play(db, { item: f, at: at(10, 2), minutes: 30, device: 'phone' });
  play(db, { item: f, at: at(10, 5), finished: true });
  // Left open when the app stopped; Kodi said later it was watched.
  play(db, { item: f, at: at(10, 6), device: 'tv2', minutes: null, reached: 1, finished: true, estimated: true });
  const y = yearInFilm(db, 1, 2026, NOW, TVS)!;
  assert.deepEqual(y.tvs, { since: at(9, 30), rows: [{ name: 'Living room', n: 2 }, { name: 'On the phone', n: 1 }] });
});

test('which TV: nothing logged, no card', () => {
  const db = openDb(':memory:');
  enough(db);
  db.prepare('UPDATE plays SET device = NULL, estimated = 1, minutes = NULL, reached = 1').run();
  assert.equal(yearInFilm(db, 1, 2026, NOW, TVS)!.tvs, null);
});

test('the year a play started is the one it counts in', () => {
  const db = openDb(':memory:');
  const f = title(db, { name: 'F' });
  play(db, { item: f, at: at(11, 31, 23, 30), finished: true });
  play(db, { item: f, at: at(0, 1, 0, 10, 2027), finished: true });
  for (const d of [1, 2]) play(db, { item: f, at: at(5, d), finished: true });
  for (const d of [1, 2]) play(db, { item: f, at: at(0, 10 + d, 20, 0, 2027), finished: true });
  const y26 = yearInFilm(db, 1, 2026, at(0, 15, 12, 0, 2027), TVS)!;
  const y27 = yearInFilm(db, 1, 2027, at(0, 15, 12, 0, 2027), TVS)!;
  assert.deepEqual([y26.films, y26.to], [3, at(11, 31, 23, 59) + 59_000]);
  assert.deepEqual([y27.films, y27.to], [3, at(0, 15, 12, 0, 2027)]);
});

test('a title gone from the NAS still counts', () => {
  const db = openDb(':memory:');
  enough(db, 2);
  play(db, { item: title(db, { name: 'Gone', present: 0 }), at: at(7, 1), finished: true });
  assert.equal(yearInFilm(db, 1, 2026, NOW, TVS)!.films, 3);
});

test('too little: null', () => {
  const db = openDb(':memory:');
  enough(db, MIN_WATCHED - 1);
  play(db, { item: title(db, { name: 'Long' }), at: at(7, 1), minutes: 80 });
  assert.equal(yearInFilm(db, 1, 2026, NOW, TVS), null);
});

test('estimated plays say so', () => {
  const db = openDb(':memory:');
  enough(db);
  play(db, { item: title(db, { name: 'Before' }), at: at(1, 1), reached: 0.5, estimated: true });
  const y = yearInFilm(db, 1, 2026, NOW, TVS)!;
  assert.deepEqual([y.estimated, y.hours, y.plays], [true, Math.round(350 / 60), 4]);
});

test('a watched film with no runtime counts, without hours', () => {
  const db = openDb(':memory:');
  enough(db, 2);
  const f = title(db, { name: 'No runtime', runtime: null });
  play(db, { item: f, at: at(1, 1), reached: 1, finished: true, estimated: true });
  play(db, { item: f, at: at(1, 2), reached: 0.5, estimated: true });
  const y = yearInFilm(db, 1, 2026, NOW, TVS)!;
  assert.deepEqual([y.films, y.plays, y.hours], [3, 3, Math.round(200 / 60)]);
});

test('the window: December this year, January last year, else nothing', () => {
  assert.equal(yearToShow(at(10, 15)), null);
  assert.equal(yearToShow(at(11, 1, 0, 0)), 2026);
  assert.equal(yearToShow(at(0, 31, 23, 59, 2027)), 2026);
  assert.equal(yearToShow(at(1, 1, 0, 0, 2027)), null);
});
