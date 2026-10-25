import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { elsewhere, cinema, setPick, wantedFilms, type CinemaCache } from '../server/films.ts';
import { Tmdb } from '../server/tmdb.ts';
import { rate } from '../server/suggestions.ts';

const NOW = Date.parse('2026-10-25T12:00:00');
const HOUR = 3600 * 1000;

function seed() {
  const db = openDb(':memory:');
  const title = db.prepare(`INSERT INTO titles (media_type, tmdb_id, title_en, year, source, fetched_at) VALUES ('movie', ?, ?, 2000, 'tmdb', 1)`);
  const item = db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, tmdb_id, match_state, present, hidden, playcount, last_played, added_at, updated_at)
    VALUES (?, 'MOVIES', 'movies', 0, 'movie', ?, 'matched', ?, ?, ?, ?, 1, 1)`);
  const add = (tmdbId: number, name: string, o: { present?: number; hidden?: number; plays?: number; last?: string } = {}) => {
    title.run(tmdbId, name);
    return Number(item.run(`MOVIES/${name}.mkv`, tmdbId, o.present ?? 1, o.hidden ?? 0, o.plays ?? 0, o.last ?? null).lastInsertRowid);
  };
  return { db, add };
}

/** TMDB with recommendations, film details (English, with a French translation) and cinema lists. */
function fakeTmdb(data: {
  recs?: Record<number, number[]>;
  films?: Record<number, { en: string; fr?: string; date?: string }>;
  lists?: Record<string, Array<{ id: number; en: string; fr: string; o?: string; date: string }>>;
  calls?: string[];
  fail?: boolean;
}) {
  const fetchFn = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    data.calls?.push(`${u.pathname}${u.searchParams.get('region') ? `?${u.searchParams.get('region')}` : ''}`);
    if (data.fail) return new Response('{}', { status: 503 });
    let m = /^\/3\/movie\/(\d+)\/recommendations$/.exec(u.pathname);
    if (m) return Response.json({ results: (data.recs?.[Number(m[1])] ?? []).map((id) => ({ id })) });
    m = /^\/3\/movie\/(now_playing|upcoming)$/.exec(u.pathname);
    if (m) {
      const fr = u.searchParams.get('language') === 'fr-FR';
      return Response.json({ results: (data.lists?.[m[1]!] ?? []).map((f) => ({ id: f.id, title: fr ? f.fr : f.en, original_title: f.o ?? f.en, release_date: f.date, poster_path: `/${f.id}.jpg` })) });
    }
    m = /^\/3\/movie\/(\d+)$/.exec(u.pathname);
    const f = m && data.films?.[Number(m[1])];
    if (!f) return new Response('{}', { status: 404 });
    return Response.json({
      id: Number(m![1]), title: f.en, original_title: f.en, release_date: f.date ?? '',
      translations: { translations: f.fr ? [{ iso_639_1: 'fr', iso_3166_1: 'FR', data: { title: f.fr } }] : [] },
    });
  }) as typeof fetch;
  return new Tmdb('k', fetchFn, 0);
}

test('films not on the NAS, from what you watched lately: released, unseen, not turned down', async () => {
  const { db, add } = seed();
  const heat = add(949, 'Heat', { plays: 1, last: '2026-10-20 21:00:00' });
  add(1366, 'Rocky'); // on the NAS
  add(10191, 'Dragon', { hidden: 1 }); // hidden, but on the NAS
  add(806, 'Cobra', { present: 0 }); // only in the sheet: suggested
  add(807, 'Se7en', { present: 0, plays: 1 }); // only in the sheet, and watched
  const tmdb = fakeTmdb({
    recs: { 949: [1366, 10191, 806, 807, 500, 600, 700, 800] },
    films: {
      806: { en: 'Cobra', date: '1986-05-23' },
      500: { en: 'Collateral', fr: 'Collatéral', date: '2004-08-06' },
      600: { en: 'Not out yet', date: '2027-03-01' },
      700: { en: 'No date' },
      800: { en: 'Thief', date: '1981-03-27' },
    },
  });
  setPick(db, 800, 'skip');
  const out = await elsewhere(db, tmdb, NOW);
  assert.deepEqual(
    out.map((s) => [s.film.id, s.film.fr, s.film.en, s.film.date, s.because]),
    [
      [806, 'Cobra', 'Cobra', '1986-05-23', heat],
      [500, 'Collatéral', 'Collateral', '2004-08-06', heat],
    ],
  );
  // Details are kept: a second look asks TMDB nothing new.
  const calls: string[] = [];
  await elsewhere(db, fakeTmdb({ calls, recs: { 949: [806, 500] } }), NOW + HOUR);
  assert.deepEqual(calls, []);
});

test('cinemas of a country: on now (popular first), then out soon (earliest first)', async () => {
  const { db, add } = seed();
  add(1, 'Owned');
  setPick(db, 2, 'skip');
  const lists = {
    now_playing: [
      { id: 10, en: 'Clayface', fr: 'Clayface', date: '2026-10-22' },
      { id: 1, en: 'Owned', fr: 'Owned', date: '2026-10-01' },
      { id: 2, en: 'Skipped', fr: 'Skipped', date: '2026-10-01' },
      { id: 11, en: 'Hope', fr: 'Hope FR', date: '2026-10-28' }, // listed as showing, out in three days
      { id: 12, en: 'Runner', fr: 'Runner', date: '2026-10-15' },
      { id: 13, en: 'Jailer 2', fr: 'ஜெயிலர் 2', o: 'ஜெயிலர் 2', date: '2026-10-15' }, // no French title: TMDB sends the original
    ],
    upcoming: [
      { id: 21, en: 'Godzilla', fr: 'Godzilla', date: '2026-11-04' },
      { id: 11, en: 'Hope', fr: 'Hope FR', date: '2026-10-28' },
      { id: 22, en: 'Crawlers', fr: 'Crawlers', date: '2026-10-29' },
    ],
  };
  const calls: string[] = [];
  const cache: CinemaCache = new Map();
  const out = await cinema(db, fakeTmdb({ lists, calls }), 'TH', NOW, cache);
  assert.deepEqual(
    out.map((f) => `${f.fr} ${f.date}${f.soon ? ' soon' : ''}`),
    ['Clayface 2026-10-22', 'Runner 2026-10-15', 'Jailer 2 2026-10-15', 'Hope FR 2026-10-28 soon', 'Crawlers 2026-10-29 soon', 'Godzilla 2026-11-04 soon'],
  );
  assert.deepEqual([out[2]!.fr, out[2]!.en, out[2]!.o], ['Jailer 2', 'Jailer 2', 'ஜெயிலர் 2']);
  assert.deepEqual(calls.sort(), ['/3/movie/now_playing?TH', '/3/movie/now_playing?TH', '/3/movie/upcoming?TH', '/3/movie/upcoming?TH']);

  // Kept a few hours, per country; when TMDB fails later, the last lists stay.
  calls.length = 0;
  await cinema(db, fakeTmdb({ lists, calls }), 'TH', NOW + HOUR, cache);
  assert.deepEqual(calls, []);
  assert.equal((await cinema(db, fakeTmdb({ fail: true }), 'TH', NOW + 7 * HOUR, cache)).length, 6);
  await cinema(db, fakeTmdb({ lists, calls }), 'FR', NOW + HOUR, cache);
  assert.equal(calls.length, 4);
});

test('films to get leave the list once a copy is on the NAS', async () => {
  const { db, add } = seed();
  const tmdb = fakeTmdb({ films: { 500: { en: 'Collateral', date: '2004-08-06' }, 806: { en: 'Cobra', date: '1986-05-23' } } });
  setPick(db, 500, 'want');
  setPick(db, 806, 'want');
  setPick(db, 999, 'skip');
  assert.deepEqual((await wantedFilms(db, tmdb, NOW)).map((f) => f.en).sort(), ['Cobra', 'Collateral']);
  add(500, 'Collateral');
  assert.deepEqual((await wantedFilms(db, tmdb, NOW)).map((f) => f.en), ['Cobra']);
  setPick(db, 806, null);
  assert.deepEqual(await wantedFilms(db, tmdb, NOW), []);
});

test('films not on the NAS: what TMDB pairs with a film you did not like drops out', async () => {
  const { db, add } = seed();
  add(949, 'Heat', { plays: 1, last: '2026-10-20 21:00:00' });
  add(800, 'Thief', { plays: 1, last: '2020-01-01 21:00:00' });
  const films = { 500: { en: 'Collateral', date: '2004-08-06' }, 806: { en: 'Cobra', date: '1986-05-23' } };
  const tmdb = fakeTmdb({ recs: { 949: [500, 806], 800: [500] }, films });
  assert.deepEqual((await elsewhere(db, tmdb, NOW)).map((s) => s.film.en), ['Collateral', 'Cobra']);
  rate(db, 'movie', 800, -1, NOW);
  assert.deepEqual((await elsewhere(db, tmdb, NOW)).map((s) => s.film.en), ['Cobra']);
});
