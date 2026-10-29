import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, saveSettings } from '../server/db.ts';
import { Service } from '../server/service.ts';
import { fskRatings, ratingChanges, syncAgeRatings } from '../server/kodiRatings.ts';
import { standInKodi } from './standInKodi.ts';

/** Titles linked to Kodi's library, each with the age ratings TMDB gave. */
function library() {
  const db = openDb(':memory:');
  const title = db.prepare("INSERT INTO titles (media_type, tmdb_id, certs, source, fetched_at) VALUES (?, ?, ?, 'tmdb', 1)");
  const item = db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, tmdb_id, match_state, present, kodi_id, kodi_type, added_at, updated_at)
    VALUES (?, 'MOVIES', 'movies', 0, ?, ?, 'matched', 1, ?, ?, 1, 1)`);
  const add = (n: number, type: 'movie' | 'tv', certs: object | null, kodiId: number | null) => {
    title.run(type, n, certs ? JSON.stringify(certs) : null);
    item.run(`MOVIES/${n}.mkv`, type, n, kodiId, kodiId === null ? null : type === 'tv' ? 'tvshow' : 'movie');
  };
  add(1, 'movie', { DE: '12', US: 'PG-13' }, 11);
  add(2, 'movie', { DE: '0' }, 12);
  add(3, 'movie', { US: 'R' }, 13); // no German rating: left as Kodi has it
  add(4, 'movie', { DE: '' }, 14);
  add(5, 'movie', { DE: '16' }, null); // not in Kodi's library
  add(6, 'tv', { DE: '18' }, 3);
  add(7, 'movie', null, 17);
  // A file gone from the NAS keeps its old link; Kodi may give that id to another title since.
  add(8, 'movie', { DE: '6' }, 11);
  db.prepare("UPDATE items SET present = 0 WHERE path = 'MOVIES/8.mkv'").run();
  return db;
}

test("the rating each title gets in Kodi: Germany's, as Kodi's own scraper writes it", () => {
  assert.deepEqual(
    [...fskRatings(library())].sort(),
    [
      ['movie:11', 'FSK 12'],
      ['movie:12', 'FSK 0'],
      ['tvshow:3', 'FSK 18'],
    ],
  );
});

test('only a rating not yet in Kodi is written', () => {
  const want = new Map([
    ['movie:11', 'FSK 12'],
    ['movie:12', 'FSK 0'],
    ['tvshow:3', 'FSK 18'],
  ]);
  const kodi = [
    { key: 'movie:11', mpaa: 'Rated PG-13' },
    { key: 'movie:12', mpaa: 'FSK 0' },
    { key: 'movie:13', mpaa: 'Rated R' },
    { key: 'tvshow:3', mpaa: '' },
  ];
  assert.deepEqual(ratingChanges(kodi, want), [
    { key: 'movie:11', mpaa: 'FSK 12' },
    { key: 'tvshow:3', mpaa: 'FSK 18' },
  ]);
});

test("the ratings in Kodi: one TV for both (one library), only the titles that change, only their rating", async () => {
  const kodi = await standInKodi();
  try {
    Object.assign(kodi.answers, {
      'VideoLibrary.GetMovies': { movies: [{ movieid: 11, mpaa: 'Rated PG-13' }, { movieid: 12, mpaa: 'FSK 0' }, { movieid: 13, mpaa: 'Rated R' }], limits: { total: 3 } },
      'VideoLibrary.GetTVShows': { tvshows: [{ tvshowid: 3, mpaa: '' }], limits: { total: 1 } },
    });
    assert.equal(await syncAgeRatings(library(), { host: '127.0.0.1', port: kodi.port }), 2);
    assert.deepEqual(
      kodi.calls.filter((c) => c.method.startsWith('VideoLibrary.Set')),
      [
        { method: 'VideoLibrary.SetMovieDetails', params: { movieid: 11, mpaa: 'FSK 12' } },
        { method: 'VideoLibrary.SetTVShowDetails', params: { tvshowid: 3, mpaa: 'FSK 18' } },
      ],
    );
    assert.deepEqual(kodi.calls.find((c) => c.method === 'VideoLibrary.GetMovies')?.params.properties, ['mpaa']);
  } finally {
    kodi.server.close();
  }
});

test('Kodi syncs and new ratings bring the TVs in step, after the same pause as the Kids tag', async () => {
  const kodi = await standInKodi();
  try {
    Object.assign(kodi.answers, {
      'VideoLibrary.GetMovies': { movies: [{ movieid: 11, mpaa: 'Rated PG-13' }], limits: { total: 1 } },
      'VideoLibrary.GetTVShows': { tvshows: [], limits: { total: 0 } },
    });
    const db = library();
    saveSettings(db, { kodiTvs: [{ id: 'tv1', name: 'Living room', host: '127.0.0.1', port: kodi.port, user: '', pass: '', pathPrefix: '' }] });
    const svc = new Service(db, mkdtempSync(join(tmpdir(), 'data-')));
    svc.kidsChanged();
    await new Promise((r) => setTimeout(r, 5500));
    assert.deepEqual(
      kodi.calls.filter((c) => c.method.startsWith('VideoLibrary.Set')),
      [{ method: 'VideoLibrary.SetMovieDetails', params: { movieid: 11, mpaa: 'FSK 12' } }],
    );
  } finally {
    kodi.server.close();
  }
});
