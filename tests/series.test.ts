import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { Tmdb, type ShowData } from '../server/tmdb.ts';
import { fileEpisodes, showData, staleShows, followed, setFollow, seriesStatus, episodesToGet } from '../server/series.ts';

test('a file named for several episodes counts for each one', () => {
  assert.deepEqual(fileEpisodes('SERIES/Show/Season 1/Show S01E09E10 Title (1080p).mkv', 1, null), [[1, 9], [1, 10]]);
  assert.deepEqual(fileEpisodes('Show.S01E09-E10.mkv', 1, 9), [[1, 9], [1, 10]]);
  assert.deepEqual(fileEpisodes('Show.S01E09-10.mkv', 1, 9), [[1, 9], [1, 10]]);
  assert.deepEqual(fileEpisodes('show.s02e03e04e05.mkv', null, null), [[2, 3], [2, 4], [2, 5]]);
});

test('a year after an episode is not a range', () => {
  assert.deepEqual(fileEpisodes('Show S01E01-2010.mkv', 1, 1), [[1, 1]]);
});

test('a range that goes down or is too long is not a range', () => {
  assert.deepEqual(fileEpisodes('Show S01E09-E03.mkv', 1, 9), [[1, 9]]);
  assert.deepEqual(fileEpisodes('Show S01E01-E30.mkv', 1, 1), [[1, 1]]);
});

test('otherwise the season and episode read by the scanner', () => {
  assert.deepEqual(fileEpisodes('x.mkv', 2, 7), [[2, 7]]);
});

test('specials and files without numbers hold no episode', () => {
  assert.deepEqual(fileEpisodes('x.mkv', 0, 3), []);
  assert.deepEqual(fileEpisodes('Show S00E01E02.mkv', 0, null), []);
  assert.deepEqual(fileEpisodes('x.mkv', null, 3), []);
  assert.deepEqual(fileEpisodes('x.mkv', 1, null), []);
});

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-10-29T12:00:00');

/** TMDB answering /tv/<id> with one season per call count (so a fetch shows), or failing. */
function fakeShows(o: { fail?: boolean; calls: string[] }) {
  const fetchFn = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    o.calls.push(u.pathname);
    if (o.fail) return new Response('{}', { status: 503 });
    return Response.json({
      status: 'Returning Series',
      seasons: [{ season_number: 1, episode_count: o.calls.length, air_date: '2025-01-01' }],
      last_episode_to_air: { season_number: 1, episode_number: o.calls.length, air_date: '2025-02-01' },
      next_episode_to_air: null,
    });
  }) as typeof fetch;
  return new Tmdb('k', fetchFn, 0);
}

test('show data is fetched once, kept a day, then fetched again', async () => {
  const db = openDb(':memory:');
  const calls: string[] = [];
  const tmdb = fakeShows({ calls });
  assert.equal((await showData(db, tmdb, 7, NOW))?.seasons[0]?.count, 1);
  assert.equal((await showData(db, tmdb, 7, NOW + DAY - 1))?.seasons[0]?.count, 1);
  assert.equal(calls.length, 1);
  assert.equal((await showData(db, tmdb, 7, NOW + DAY + 1))?.seasons[0]?.count, 2);
  assert.deepEqual(calls, ['/3/tv/7', '/3/tv/7']);
});

test('show data kept is used when TMDB fails or there is no key', async () => {
  const db = openDb(':memory:');
  const calls: string[] = [];
  await showData(db, fakeShows({ calls }), 7, NOW);
  assert.equal((await showData(db, fakeShows({ calls: [], fail: true }), 7, NOW + 2 * DAY))?.seasons[0]?.count, 1);
  assert.equal((await showData(db, null, 7, NOW + 2 * DAY))?.seasons[0]?.count, 1);
  assert.equal(await showData(db, null, 8, NOW), null);
  await assert.rejects(showData(db, fakeShows({ calls: [], fail: true }), 8, NOW));
});

test('stale shows: never fetched, or fetched more than a day ago', async () => {
  const db = openDb(':memory:');
  const tmdb = fakeShows({ calls: [] });
  await showData(db, tmdb, 1, NOW - 2 * DAY);
  await showData(db, tmdb, 2, NOW - DAY / 2);
  assert.deepEqual(staleShows(db, [1, 2, 3], NOW), [1, 3]);
});

/** A library with TV shows: folders (with episode files) or loose files. */
function library() {
  const db = openDb(':memory:');
  const item = db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, tmdb_id, match_state, present, file_count, added_at, updated_at)
    VALUES (?, ?, ?, ?, 'tv', ?, 'matched', ?, ?, 1, 1)`);
  const ep = db.prepare('INSERT INTO episodes (item_id, path, season, episode, present) VALUES (?, ?, ?, ?, ?)');
  const show = (tmdbId: number, path: string, eps: Array<[number | null, number | null, string?]>, o: { present?: number; category?: string } = {}) => {
    const folder = path.slice(0, path.indexOf('/'));
    const id = Number(item.run(path, folder, o.category ?? 'series', 1, tmdbId, o.present ?? 1, eps.length).lastInsertRowid);
    eps.forEach(([s, e, name], i) => ep.run(id, `${path}/${name ?? `ep${i}.mkv`}`, s, e, 1));
    return id;
  };
  const loose = (tmdbId: number, path: string, category = 'shows') =>
    Number(item.run(path, path.slice(0, path.indexOf('/')), category, 0, tmdbId, 1, 1).lastInsertRowid);
  return { db, show, loose };
}

const eps = (s: number, from: number, to: number): Array<[number, number]> => Array.from({ length: to - from + 1 }, (_, i) => [s, from + i]);

const DATA: ShowData = {
  status: 'Returning Series',
  seasons: [
    { n: 0, count: 5, date: '2020-01-01' },
    { n: 1, count: 10, date: '2024-01-10' },
    { n: 2, count: 8, date: '2025-03-01' },
    { n: 3, count: 8, date: null },
  ],
  last: { s: 2, e: 6, date: '2025-04-05' },
  next: null,
};

test('a show is followed by default when a copy is in a SERIES folder', () => {
  const { db, show } = library();
  show(1, 'SERIES/One', [[1, 1]]);
  show(2, 'KIDS/Two', [[1, 1]], { category: 'kids' });
  show(3, 'SERIES/Three', [[1, 1]]);
  show(3, 'MOVIES/Three extra', [[1, 2]], { category: 'movies' });
  show(4, 'SERIES/Four', [[1, 1]], { present: 0 });
  assert.deepEqual([...followed(db)].sort(), [[1, true], [2, false], [3, true]]);
});

test('following is stored only where it differs from the default', () => {
  const { db, show } = library();
  show(1, 'SERIES/One', [[1, 1]]);
  show(2, 'KIDS/Two', [[1, 1]], { category: 'kids' });
  setFollow(db, 1, false, NOW);
  setFollow(db, 2, true, NOW);
  assert.deepEqual([...followed(db)].sort(), [[1, false], [2, true]]);
  setFollow(db, 1, true, NOW);
  assert.equal(followed(db).get(1), true);
  assert.deepEqual(db.prepare('SELECT tmdb_id FROM follows').all().map((r) => (r as { tmdb_id: number }).tmdb_id), [2]);
});

test('missing: aired episodes not on the NAS, specials and future seasons aside', () => {
  const { db, show } = library();
  show(1, 'SERIES/One', [...eps(1, 1, 10), [1, 2], [0, 1], [2, 1]]);
  const st = seriesStatus(db, 1, DATA, '2026-10-29');
  assert.deepEqual(st.missing, [{ season: 2, aired: 6, missing: [2, 3, 4, 5, 6] }]);
  assert.equal(st.latest, '2025-04-05');
  assert.equal(st.unnumbered, 0);
});

test('missing: every folder of the show counts, absent ones and absent files do not', () => {
  const { db, show } = library();
  show(1, 'SERIES/One S1', eps(1, 1, 10));
  show(1, 'SERIES/One S2', eps(2, 1, 3));
  show(1, 'SERIES/One S2 again', eps(2, 4, 6), { present: 0 });
  const id = show(1, 'SERIES/One extra', [[2, 4]]);
  db.prepare('UPDATE episodes SET present = 0 WHERE item_id = ?').run(id);
  assert.deepEqual(seriesStatus(db, 1, DATA, '2026-10-29').missing, [{ season: 2, aired: 6, missing: [4, 5, 6] }]);
});

test('missing: a two-episode file counts for both, a loose file for its own episode', () => {
  const { db, show, loose } = library();
  show(1, 'SERIES/One', [...eps(1, 1, 8), [1, null, 'One S01E09E10 Title.mkv'], ...eps(2, 1, 4)]);
  loose(1, 'SERIES/One.S02E05.1080p.mkv');
  loose(1, 'SERIES/One.S02E06.1080p.mkv');
  assert.deepEqual(seriesStatus(db, 1, DATA, '2026-10-29').missing, []);
});

test('files without an episode number are counted apart, extras are not', () => {
  const { db, show, loose } = library();
  show(1, 'SERIES/One', [...eps(1, 1, 10), [1, null, 'bonus.mkv'], [null, null, 'trailer.mkv'], [0, null, 'making of.mkv']]);
  loose(1, 'SERIES/One special.mkv');
  const st = seriesStatus(db, 1, DATA, '2026-10-29');
  assert.equal(st.unnumbered, 3);
  assert.deepEqual(st.missing, [{ season: 2, aired: 6, missing: [1, 2, 3, 4, 5, 6] }]);
});

test("latest: the season's date when the last aired episode is on the NAS", () => {
  const { db, show } = library();
  show(1, 'SERIES/One', [...eps(1, 1, 2), ...eps(1, 4, 10), ...eps(2, 1, 6)]);
  const st = seriesStatus(db, 1, DATA, '2026-10-29');
  assert.deepEqual(st.missing, [{ season: 1, aired: 10, missing: [3] }]);
  assert.equal(st.latest, '2024-01-10');
});

test("next: a new season's first episode, a next episode, or an announced season", () => {
  const { db } = library();
  const next = (d: Partial<ShowData>) => seriesStatus(db, 1, { ...DATA, ...d }, '2026-10-29').next;
  assert.deepEqual(next({ next: { s: 4, e: 1, date: '2027-07-08' } }), { kind: 'season', season: 4, date: '2027-07-08' });
  assert.deepEqual(next({ next: { s: 2, e: 7, date: '2026-11-02' } }), { kind: 'episode', s: 2, e: 7, date: '2026-11-02' });
  assert.deepEqual(next({}), { kind: 'season', season: 3, date: null });
  assert.equal(next({ seasons: DATA.seasons.slice(0, 3) }), null);
  assert.equal(seriesStatus(db, 1, { ...DATA, status: 'Canceled' }, '2026-10-29').ended, 'cancelled');
  assert.equal(seriesStatus(db, 1, { ...DATA, status: 'Ended' }, '2026-10-29').ended, 'ended');
  assert.equal(seriesStatus(db, 1, DATA, '2026-10-29').ended, null);
});

test('nothing aired yet: nothing missing', () => {
  const { db } = library();
  assert.deepEqual(seriesStatus(db, 1, { ...DATA, last: null }, '2026-10-29').missing, []);
});

test('episodes to get: followed shows with something missing, latest first', async () => {
  const { db, show } = library();
  const keep = (id: number, d: ShowData) => db.prepare('INSERT INTO shows (tmdb_id, data, fetched_at) VALUES (?, ?, ?)').run(id, JSON.stringify(d), NOW);
  show(1, 'SERIES/One', eps(1, 1, 10));
  const big = show(1, 'SERIES/One more', eps(2, 1, 3));
  db.prepare('UPDATE items SET file_count = 99 WHERE id = ?').run(big);
  keep(1, DATA);
  const two = show(2, 'SERIES/Two', eps(1, 1, 9));
  keep(2, { ...DATA, seasons: DATA.seasons.slice(0, 2), last: { s: 1, e: 10, date: '2026-01-01' } });
  show(3, 'KIDS/Three', [], { category: 'kids' });
  keep(3, DATA);
  show(4, 'SERIES/Four', [...eps(1, 1, 10), ...eps(2, 1, 6)]);
  keep(4, DATA);
  show(5, 'SERIES/Five', []);
  const list = episodesToGet(db, NOW);
  assert.deepEqual(list.map((s) => [s.tmdbId, s.itemId, s.status.latest]), [[2, two, '2026-01-01'], [1, big, '2025-04-05']]);
});

test('repeated episode markers name each episode, a hyphen names a range', () => {
  assert.deepEqual(fileEpisodes('Show S01E09E11.mkv', 1, null), [[1, 9], [1, 11]]);
  assert.deepEqual(fileEpisodes('Show S01E09-E11.mkv', 1, null), [[1, 9], [1, 10], [1, 11]]);
});

test('a special aired after the season does not hide the missing episodes', () => {
  const { db, show } = library();
  show(1, 'SERIES/One', [...eps(1, 1, 10), ...eps(2, 1, 5)]);
  const data: ShowData = { ...DATA, seasons: DATA.seasons.slice(0, 3), last: { s: 0, e: 5, date: '2025-12-24' } };
  const st = seriesStatus(db, 1, data, '2026-10-29');
  assert.deepEqual(st.missing, [{ season: 2, aired: 8, missing: [6, 7, 8] }]);
  assert.equal(st.latest, '2025-03-01');
  assert.equal(st.next, null);
});

test('after a special, a season still airing counts only up to the next episode', () => {
  const { db, show } = library();
  show(1, 'SERIES/One', [...eps(1, 1, 10), ...eps(2, 1, 3)]);
  const last = { s: 0, e: 5, date: '2025-03-20' };
  const at = (next: ShowData['next']) => seriesStatus(db, 1, { ...DATA, seasons: DATA.seasons.slice(0, 3), last, next }, '2026-10-29');
  assert.deepEqual(at({ s: 2, e: 4, date: '2026-11-02' }).missing, []);
  assert.deepEqual(at({ s: 2, e: 6, date: '2026-11-02' }).missing, [{ season: 2, aired: 5, missing: [4, 5] }]);
  assert.deepEqual(at({ s: 3, e: 1, date: '2027-01-01' }).missing, [{ season: 2, aired: 8, missing: [4, 5, 6, 7, 8] }]);
});

test('two databases asking for the same show at once each keep it', async () => {
  const one = openDb(':memory:');
  const two = openDb(':memory:');
  const tmdb = fakeShows({ calls: [] });
  await Promise.all([showData(one, tmdb, 7, NOW), showData(two, tmdb, 7, NOW)]);
  assert.deepEqual(staleShows(one, [7], NOW), []);
  assert.deepEqual(staleShows(two, [7], NOW), []);
});
