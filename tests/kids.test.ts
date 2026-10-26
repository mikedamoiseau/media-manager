import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { ageOf } from '../server/kids.ts';
import { enrichTitles } from '../server/metadata.ts';
import type { Tmdb, TitleDetails } from '../server/tmdb.ts';

test('age: Germany first, else the stricter of France and the US', () => {
  assert.equal(ageOf({ DE: '12', FR: 'TP', US: 'PG' }), 12);
  assert.equal(ageOf({ FR: 'TP', US: 'R' }), 17);
  assert.equal(ageOf({ FR: 'TP' }), 0);
  assert.equal(ageOf({ FR: '10' }), 10);
  assert.equal(ageOf({ FR: '-12' }), 12);
  assert.equal(ageOf({ US: 'TV-Y7' }), 7);
  assert.equal(ageOf({ US: 'PG-13' }), 13);
  assert.equal(ageOf({ US: 'NR' }), undefined);
  assert.equal(ageOf({}), undefined);
  assert.equal(ageOf(null), undefined);
});

test('titles without age ratings are fetched again, once', async () => {
  const db = openDb(':memory:');
  const item = db.prepare(`INSERT INTO items (path, folder, category, media_type, tmdb_id, match_state, added_at, updated_at)
    VALUES (?, 'MOVIES', 'movies', 'movie', ?, 'matched', 1, 1)`);
  item.run('MOVIES/A.mkv', 1);
  item.run('MOVIES/B.mkv', 2);
  const title = db.prepare("INSERT INTO titles (media_type, tmdb_id, genres, source, fetched_at, certs) VALUES ('movie', ?, '[]', 'tmdb', 1, ?)");
  title.run(1, null);
  title.run(2, '{}');
  const asked: number[] = [];
  const tmdb = {
    details: async (type: 'movie' | 'tv', id: number): Promise<TitleDetails> => {
      asked.push(id);
      return { type, id, genres: ['Animation'], cast: [], directors: [], certs: { DE: '6' } };
    },
  } as unknown as Tmdb;
  await enrichTitles(db, tmdb);
  assert.deepEqual(asked, [1]);
  const certs = (id: number) => (db.prepare('SELECT certs FROM titles WHERE tmdb_id = ?').get(id) as { certs: string | null }).certs;
  assert.equal(certs(1), '{"DE":"6"}');
  assert.equal(certs(2), '{}');
});
