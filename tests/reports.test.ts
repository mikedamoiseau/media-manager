import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { duplicateFilms, incompleteSets } from '../server/reports.ts';
import { ownedSetKeys, staleSetKeys } from '../server/sets.ts';

const GB = 1024 ** 3;
const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-10-25T12:00:00');

function seed() {
  const db = openDb(':memory:');
  const ins = db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, tmdb_id, match_state, present, hidden, size, quality, playcount, added_at, updated_at)
    VALUES (?, ?, 'movies', 0, ?, ?, 'matched', ?, ?, ?, ?, ?, 1, 1)`);
  const add = (path: string, tmdb: number | null, o: { type?: string; present?: number; hidden?: number; size?: number; q?: object; plays?: number } = {}) =>
    Number(ins.run(path, path.split('/')[0]!, o.type ?? 'movie', tmdb, o.present ?? 1, o.hidden ?? 0, o.size ?? GB, o.q ? JSON.stringify(o.q) : null, o.plays ?? 0).lastInsertRowid);
  const title = db.prepare(`INSERT INTO titles (media_type, tmdb_id, title_en, year, collection, source, fetched_at) VALUES ('movie', ?, ?, ?, ?, 'tmdb', 1)`);
  return { db, add, title };
}

test('films with more than one copy on the NAS, biggest copy first', () => {
  const { db, add } = seed();
  const hd = add('MOVIES/HP 1 (2001).mkv', 671, { size: 8 * GB, q: { res: '1080p', langs: ['MULTI'] }, plays: 1 });
  const uhd = add('MOVIES2/HP 1 4K.mkv', 671, { size: 20 * GB, q: { res: '4K', hdr: true } });
  add('MOVIES3/HP 1 old.avi', 671, { present: 0 }); // only in the sheet now
  const hidden = add('KIDS/HP 1 VF.mkv', 671, { size: 2 * GB, hidden: 1 }); // hidden, but still a file on the NAS
  add('MOVIES/Narnia.mkv', 411);
  add('SERIES/Lost', 4607, { type: 'tv' });
  add('SERIES2/Lost', 4607, { type: 'tv' }); // series are not films
  add('MOVIES/Unknown.mkv', null);
  add('MOVIES/Unknown 2.mkv', null);
  assert.deepEqual(duplicateFilms(db), [
    {
      tmdbId: 671,
      copies: [
        { id: uhd, path: 'MOVIES2/HP 1 4K.mkv', size: 20 * GB, quality: ['4K', 'HDR'], hidden: false, watched: false },
        { id: hd, path: 'MOVIES/HP 1 (2001).mkv', size: 8 * GB, quality: ['1080p', 'MULTI'], hidden: false, watched: true },
        { id: hidden, path: 'KIDS/HP 1 VF.mkv', size: 2 * GB, quality: [], hidden: true, watched: false },
      ],
    },
  ]);
});

test('sets missing a released film, once TMDB has listed them', () => {
  const { db, add, title } = seed();
  const part = (id: number, en: string, date: string | null) => ({ id, fr: en, en, o: en, date, poster: '/p.jpg' });
  const cache = db.prepare('INSERT INTO collections (key, tmdb_id, parts, fetched_at) VALUES (?, ?, ?, ?)');
  title.run(1367, 'Rocky II', 1979, 'Rocky Collection');
  title.run(1371, 'Rocky III', 1982, 'Rocky Collection');
  add('MOVIES/Rocky II.mkv', 1367);
  add('MOVIES/Rocky III.mkv', 1371, { hidden: 1 }); // hidden: missing, like on the set page
  cache.run('Rocky Collection', 1575, JSON.stringify([part(1366, 'Rocky', '1976-11-21'), part(1367, 'Rocky II', '1979-06-15'), part(1371, 'Rocky III', '1982-05-28'), part(9999, 'Rocky VII', '2099-01-01')]), NOW - DAY);
  title.run(348, 'Alien', 1979, 'Alien Collection');
  add('MOVIES/Alien.mkv', 348);
  cache.run('Alien Collection', 8091, JSON.stringify([part(348, 'Alien', '1979-05-25'), part(8888, 'Alien 9', null)]), NOW - 8 * DAY); // complete
  title.run(646, 'Dr. No', 1962, 'James Bond Collection');
  add('MOVIES/Dr No.mkv', 646); // not fetched from TMDB yet
  title.run(12, 'Finding Nemo', 2003, 'Finding Nemo Collection');
  add('MOVIES/Nemo.mkv', 12, { present: 0 }); // not on the NAS: no set to check

  assert.deepEqual(incompleteSets(db, '2026-10-25'), [
    { key: 'Rocky Collection', onNas: 1, released: 3, missing: [{ id: 1366, fr: 'Rocky', en: 'Rocky', o: 'Rocky', date: '1976-11-21' }, { id: 1371, fr: 'Rocky III', en: 'Rocky III', o: 'Rocky III', date: '1982-05-28' }] },
  ]);
  const keys = ownedSetKeys(db);
  assert.deepEqual(keys, ['Alien Collection', 'James Bond Collection', 'Rocky Collection']);
  assert.deepEqual(staleSetKeys(db, keys, NOW), ['Alien Collection', 'James Bond Collection'], 'never fetched, or over a week old');
});
