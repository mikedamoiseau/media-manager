import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { Tmdb, type ShowData } from '../server/tmdb.ts';
import { setPick, type CinemaCache } from '../server/films.ts';
import { setFollow } from '../server/series.ts';
import { comingSoon, type SoonEntry } from '../server/soon.ts';

const NOW = Date.parse('2026-10-29T12:00:00');

type F = { id: number; en: string; date: string };

/** TMDB with cinema lists and film details (a film's date may be empty: not announced). */
function fakeTmdb(o: { upcoming?: F[]; nowPlaying?: F[]; films?: F[] } = {}) {
  const fetchFn = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    const list = /^\/3\/movie\/(now_playing|upcoming)$/.exec(u.pathname)?.[1];
    if (list) {
      const films = (list === 'upcoming' ? o.upcoming : o.nowPlaying) ?? [];
      return Response.json({ results: films.map((f) => ({ id: f.id, title: f.en, original_title: f.en, release_date: f.date, poster_path: null })) });
    }
    const f = o.films?.find((x) => `/3/movie/${x.id}` === u.pathname);
    if (!f) return new Response('{}', { status: 404 });
    return Response.json({ id: f.id, title: f.en, original_title: f.en, release_date: f.date });
  }) as typeof fetch;
  return new Tmdb('k', fetchFn, 0);
}

function library() {
  const db = openDb(':memory:');
  const tvItem = db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, tmdb_id, match_state, present, file_count, added_at, updated_at)
    VALUES (?, ?, ?, 1, 'tv', ?, 'matched', 1, 1, 1, 1)`);
  const show = (tmdbId: number, data: ShowData, category = 'series') => {
    const id = Number(tvItem.run(`${category.toUpperCase()}/Show ${tmdbId}`, category.toUpperCase(), category, tmdbId).lastInsertRowid);
    db.prepare('INSERT INTO shows (tmdb_id, data, fetched_at) VALUES (?, ?, ?)').run(tmdbId, JSON.stringify(data), NOW);
    return id;
  };
  /** A film on the NAS in a set whose film list was fetched. */
  const set = (key: string, owned: number, parts: Array<{ id: number; en: string; date: string | null }>) => {
    db.prepare(`INSERT INTO titles (media_type, tmdb_id, title_en, collection, source, fetched_at) VALUES ('movie', ?, 'Owned', ?, 'tmdb', 1)`).run(owned, key);
    db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, tmdb_id, match_state, present, added_at, updated_at)
      VALUES (?, 'MOVIES', 'movies', 0, 'movie', ?, 'matched', 1, 1, 1)`).run(`MOVIES/${owned}.mkv`, owned);
    const full = parts.map((p) => ({ id: p.id, fr: p.en, en: p.en, o: p.en, date: p.date, poster: null }));
    db.prepare('INSERT INTO collections (key, tmdb_id, parts, fetched_at) VALUES (?, 1, ?, ?)').run(key, JSON.stringify(full), NOW);
  };
  return { db, show, set };
}

const SHOW: ShowData = { status: 'Returning Series', seasons: [{ n: 1, count: 8, date: '2025-01-01' }], last: { s: 1, e: 8, date: '2025-02-19' }, next: null };
const brief = (e: SoonEntry) =>
  e.kind === 'season' ? `season ${e.tmdbId} S${e.season} ${e.date}` : `film ${e.film.id} ${e.date} set=${e.set} cinema=${e.cinema} reminder=${e.reminder}`;

test("a followed show's next season is coming soon, an unfollowed one's is not", async () => {
  const { db, show } = library();
  const item = show(1, { ...SHOW, next: { s: 2, e: 1, date: '2027-07-08' } });
  show(2, { ...SHOW, next: { s: 2, e: 1, date: '2027-01-01' } }, 'kids');
  show(3, { ...SHOW, next: { s: 1, e: 9, date: '2026-11-02' } });
  show(4, { ...SHOW, seasons: [...SHOW.seasons, { n: 2, count: 0, date: null }] });
  const out = await comingSoon(db, null, 'FR', NOW, new Map());
  assert.deepEqual(out.map(brief), ['season 1 S2 2027-07-08', 'season 4 S2 null']);
  assert.equal(out[0]!.kind === 'season' && out[0]!.itemId, item);
  setFollow(db, 1, false, NOW);
  assert.deepEqual((await comingSoon(db, null, 'FR', NOW, new Map())).map(brief), ['season 4 S2 null']);
});

test('sequels: films of a set on the NAS that are not out, not owned and not turned down', async () => {
  const { db, set } = library();
  set('Saga', 10, [
    { id: 10, en: 'Owned', date: '2020-01-01' },
    { id: 11, en: 'Out already', date: '2026-10-01' },
    { id: 12, en: 'Next', date: '2026-12-18' },
    { id: 13, en: 'Undated', date: null },
    { id: 14, en: 'Turned down', date: '2027-05-01' },
  ]);
  setPick(db, 14, 'skip', NOW);
  const out = await comingSoon(db, null, 'FR', NOW, new Map());
  assert.deepEqual(out.map(brief), ['film 12 2026-12-18 set=Saga cinema=false reminder=false', 'film 13 null set=Saga cinema=false reminder=false']);
});

test('cinema: films coming to cinemas, not the ones on now', async () => {
  const { db } = library();
  const tmdb = fakeTmdb({ upcoming: [{ id: 20, en: 'Soon', date: '2026-12-05' }], nowPlaying: [{ id: 21, en: 'On now', date: '2026-10-01' }] });
  const out = await comingSoon(db, tmdb, 'FR', NOW, new Map());
  assert.deepEqual(out.map(brief), ['film 20 2026-12-05 set=null cinema=true reminder=false']);
});

test('reminders: films wanted that are not out yet', async () => {
  const { db } = library();
  const tmdb = fakeTmdb({ films: [{ id: 30, en: 'Later', date: '2027-03-12' }, { id: 31, en: 'Out', date: '2026-01-01' }, { id: 32, en: 'No date', date: '' }] });
  for (const id of [30, 31, 32]) setPick(db, id, 'want', NOW);
  const out = await comingSoon(db, tmdb, 'FR', NOW, new Map());
  assert.deepEqual(out.map(brief), ['film 30 2027-03-12 set=null cinema=false reminder=true', 'film 32 null set=null cinema=false reminder=true']);
});

test('a film from several sources shows once, with every source', async () => {
  const { db, set } = library();
  set('Saga', 10, [{ id: 12, en: 'Next', date: '2026-12-20' }]);
  const tmdb = fakeTmdb({ upcoming: [{ id: 12, en: 'Next', date: '2026-12-18' }], films: [{ id: 12, en: 'Next', date: '2026-12-20' }] });
  setPick(db, 12, 'want', NOW);
  const out = await comingSoon(db, tmdb, 'FR', NOW, new Map());
  // The cinema date is the country's.
  assert.deepEqual(out.map(brief), ['film 12 2026-12-18 set=Saga cinema=true reminder=true']);
});

test('soonest first, undated last', async () => {
  const { db, show, set } = library();
  show(1, { ...SHOW, next: { s: 2, e: 1, date: '2027-02-01' } });
  show(2, { ...SHOW, seasons: [...SHOW.seasons, { n: 2, count: 0, date: null }] });
  set('Saga', 10, [{ id: 12, en: 'Next', date: '2026-11-15' }, { id: 13, en: 'Undated', date: null }]);
  const cache: CinemaCache = new Map();
  const out = await comingSoon(db, fakeTmdb({ upcoming: [{ id: 20, en: 'Soon', date: '2027-01-10' }] }), 'FR', NOW, cache);
  assert.deepEqual(out.map((e) => (e.kind === 'season' ? `s${e.tmdbId}` : `f${e.film.id}`)), ['f12', 'f20', 's1', 's2', 'f13']);
});
