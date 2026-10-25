import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tmdb, findMatch, similarity, pickTrailer } from '../server/tmdb.ts';

type Movie = { id: number; title: string; original_title: string; release_date: string; popularity: number };

/** Fake TMDB: answers /search/movie and /search/tv from a fixed catalogue, by substring match. */
function fakeFetch(movies: Movie[], shows: Array<{ id: number; name: string; original_name: string; first_air_date: string; popularity: number }> = []) {
  const calls: string[] = [];
  const fn = (async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const q = (url.searchParams.get('query') ?? '').toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const hit = (s: string) => words.every((w) => s.toLowerCase().includes(w));
    if (url.pathname.endsWith('/search/movie')) {
      const year = url.searchParams.get('year');
      const results = movies.filter((m) => (hit(m.title) || hit(m.original_title)) && (!year || m.release_date.startsWith(year)));
      return new Response(JSON.stringify({ results }));
    }
    if (url.pathname.endsWith('/search/tv')) {
      return new Response(JSON.stringify({ results: shows.filter((s) => hit(s.name) || hit(s.original_name)) }));
    }
    if (url.pathname.endsWith('/configuration')) return new Response('{}', { status: url.searchParams.get('api_key') === 'good' ? 200 : 401 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}

const catalogue: Movie[] = [
  { id: 1, title: 'Bande de sauvages', original_title: 'Wild Hogs', release_date: '2007-03-02', popularity: 20 },
  { id: 2, title: 'Les Sauvages', original_title: 'Les Sauvages', release_date: '2001-01-01', popularity: 2 },
  { id: 3, title: 'Prometheus', original_title: 'Prometheus', release_date: '2012-05-30', popularity: 40 },
  { id: 4, title: 'Prometheus Trap', original_title: 'Prometheus Trap', release_date: '2012-01-01', popularity: 1 },
  { id: 5, title: 'Shrek', original_title: 'Shrek', release_date: '2001-05-18', popularity: 60 },
  { id: 6, title: 'Shrek 2', original_title: 'Shrek 2', release_date: '2004-05-19', popularity: 50 },
];

test('similarity basics', () => {
  assert.equal(similarity('Prométhéus', 'prometheus'), 1);
  assert.ok(similarity('Bande de sauvages', 'Les Sauvages') < 0.75);
  assert.ok(similarity('The Lord of the Rings The War of the Rohirrim', 'The Lord of the Rings: The War of the Rohirrim') > 0.95);
});

test('findMatch picks the exact title+year with confidence', async () => {
  const { fn } = fakeFetch(catalogue);
  const r = await findMatch(new Tmdb('k', fn, 0), { type: 'movie', titles: ['Prometheus'], year: 2012 });
  assert.equal(r.best?.id, 3);
  assert.equal(r.confident, true);
});

test('findMatch uses the English sheet title when the parsed one is French', async () => {
  const { fn } = fakeFetch(catalogue);
  const r = await findMatch(new Tmdb('k', fn, 0), { type: 'movie', titles: ['Bande de sauvages'], englishTitle: 'Wild Hogs', year: 2007 });
  assert.equal(r.best?.id, 1);
  assert.equal(r.confident, true);
});

test('findMatch prefers the right year among sequels', async () => {
  const { fn } = fakeFetch(catalogue);
  const r = await findMatch(new Tmdb('k', fn, 0), { type: 'movie', titles: ['Shrek'], year: 2001 });
  assert.equal(r.best?.id, 5);
});

test('findMatch falls back to TV and reports low confidence for junk', async () => {
  const shows = [{ id: 99, name: 'Peppa Pig', original_name: 'Peppa Pig', first_air_date: '2004-05-31', popularity: 30 }];
  const { fn } = fakeFetch(catalogue, shows);
  const r = await findMatch(new Tmdb('k', fn, 0), { type: 'movie', titles: ['Peppa Pig'] });
  assert.equal(r.best?.type, 'tv');
  assert.equal(r.best?.id, 99);
  const junk = await findMatch(new Tmdb('k', fn, 0), { type: 'movie', titles: ['Zzqx Unknown'] });
  assert.equal(junk.confident, false);
});

test('v3 key goes in the query string; v4 token in a Bearer header', async () => {
  const { fn } = fakeFetch([]);
  assert.equal(await new Tmdb('good', fn, 0).validate(), true);
  assert.equal(await new Tmdb('bad', fn, 0).validate(), false);
  let auth: string | null = null;
  const spy = (async (_u: string | URL, init?: RequestInit) => {
    auth = new Headers(init?.headers).get('authorization');
    return new Response('{}');
  }) as typeof fetch;
  await new Tmdb('eyJhbGciOi.token', spy, 0).validate();
  assert.equal(auth, 'Bearer eyJhbGciOi.token');
});

test('pickTrailer prefers official French/English trailers on YouTube', () => {
  assert.equal(
    pickTrailer([
      { key: 'teaser', site: 'YouTube', type: 'Teaser', official: true, iso_639_1: 'fr' },
      { key: 'vimeo', site: 'Vimeo', type: 'Trailer', official: true, iso_639_1: 'fr' },
      { key: 'en', site: 'YouTube', type: 'Trailer', official: true, iso_639_1: 'en' },
      { key: 'fr', site: 'YouTube', type: 'Trailer', official: true, iso_639_1: 'fr' },
    ]),
    'fr',
  );
});

test('search sends NFC queries (macOS file names are NFD)', async () => {
  let sent = '';
  const spy = (async (u: string | URL) => {
    sent = new URL(String(u)).searchParams.get('query') ?? '';
    return new Response(JSON.stringify({ results: [] }));
  }) as typeof fetch;
  await new Tmdb('k', spy, 0).search('movie', 'Astérix');
  assert.equal(sent, 'Astérix');
  assert.equal(sent.length, 7);
});

test('a title that extends a multi-word query is a strong match (Shrek 4)', async () => {
  const { fn } = fakeFetch([
    { id: 10192, title: 'Shrek 4 : Il était une fin', original_title: 'Shrek Forever After', release_date: '2010-05-16', popularity: 30 },
    { id: 5, title: 'Shrek', original_title: 'Shrek', release_date: '2001-05-18', popularity: 60 },
  ]);
  const r = await findMatch(new Tmdb('k', fn, 0), { type: 'movie', titles: ['Shrek 4'], year: 2010 });
  assert.equal(r.best?.id, 10192);
  assert.equal(r.confident, true);
});

test('English-named files get compared with English titles too', async () => {
  // French results only carry the French title; the English search adds the English one.
  const fn = (async (input: string | URL) => {
    const url = new URL(String(input));
    const en = url.searchParams.get('language') === 'en-US';
    const q = (url.searchParams.get('query') ?? '').toLowerCase();
    const results = q.includes('mononoke')
      ? [{ id: 1322218, title: en ? 'Mononoke the Movie: Chapter II - The Ashes of Rage' : 'Mononoke, le film : Chapitre II – Les cendres de la rage', original_title: '劇場版モノノ怪 第二章 火鼠', release_date: '2025-03-14', popularity: 5 }]
      : [];
    return new Response(JSON.stringify({ results }));
  }) as typeof fetch;
  const r = await findMatch(new Tmdb('k', fn, 0), { type: 'movie', titles: ['Mononoke The Movie Chapter II The Ashes Of Rage'], year: 2025 });
  assert.equal(r.best?.id, 1322218);
  assert.equal(r.confident, true);
});

test('a unique exact title wins even when the file year is wrong', async () => {
  const { fn } = fakeFetch([
    { id: 7443, title: 'Chicken Run', original_title: 'Chicken Run', release_date: '2000-06-23', popularity: 20 },
    { id: 520758, title: 'Chicken Run : La Menace nuggets', original_title: 'Chicken Run: Dawn of the Nugget', release_date: '2023-12-08', popularity: 30 },
  ]);
  const r = await findMatch(new Tmdb('k', fn, 0), { type: 'movie', titles: ['Chicken run'], year: 2005 });
  assert.equal(r.best?.id, 7443);
  assert.equal(r.confident, true);
});

test('several films with the exact same title stay for review', async () => {
  const { fn } = fakeFetch([
    { id: 11224, title: 'Cendrillon', original_title: 'Cinderella', release_date: '1950-02-22', popularity: 40 },
    { id: 150689, title: 'Cendrillon', original_title: 'Cinderella', release_date: '2015-03-06', popularity: 45 },
  ]);
  const r = await findMatch(new Tmdb('k', fn, 0), { type: 'movie', titles: ['Cendrillon'] });
  assert.equal(r.confident, false);
  assert.equal(r.candidates.length, 2);
});

test('a year that filters out the right film is dropped and retried', async () => {
  const { fn } = fakeFetch([{ id: 41213, title: 'Pédale douce', original_title: 'Pédale douce', release_date: '1996-02-14', popularity: 8 }]);
  const r = await findMatch(new Tmdb('k', fn, 0), { type: 'movie', titles: ['Pédale douce'], year: 1995 });
  assert.equal(r.best?.id, 41213);
  assert.equal(r.confident, true);
});
