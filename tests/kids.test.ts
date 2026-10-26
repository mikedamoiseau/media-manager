import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getSettings } from '../server/db.ts';
import { ageOf, setParentsCode, checkParentsCode, hasParentsCode } from '../server/kids.ts';
import { MAIN_PROFILE, PROFILE_COLORS, addProfile, editProfile } from '../server/profiles.ts';
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

test('kids profiles: limit, bedtime, never the main one, code first', () => {
  const db = openDb(':memory:');
  assert.throws(() => addProfile(db, { name: 'Kid', color: PROFILE_COLORS[2], kids: true }), { message: "Set the parents' code first" });
  setParentsCode(db, '4821');
  const kid = addProfile(db, { name: 'Kid', color: PROFILE_COLORS[2], kids: true });
  assert.deepEqual([kid.kids, kid.maxAge, kid.bedtime], [true, 12, null]);
  const later = editProfile(db, kid.id, { maxAge: 6, bedtime: '20:00' });
  assert.deepEqual([later.maxAge, later.bedtime], [6, '20:00']);
  assert.equal(editProfile(db, kid.id, { bedtime: null }).bedtime, null);
  assert.throws(() => editProfile(db, kid.id, { maxAge: 10 }), { message: 'Pick an age limit' });
  assert.throws(() => editProfile(db, kid.id, { bedtime: '8pm' }), { message: 'Bedtime is a time like 20:00' });
  assert.throws(() => editProfile(db, kid.id, { bedtime: '24:00' }), { message: 'Bedtime is a time like 20:00' });
  assert.throws(() => editProfile(db, MAIN_PROFILE, { kids: true }), { message: "The main profile can't be a kids profile" });
  assert.equal(editProfile(db, kid.id, { kids: false }).kids, false);
});

test("parents' code: 4 digits, checked, changed without the old one", () => {
  const db = openDb(':memory:');
  assert.equal(hasParentsCode(db), false);
  assert.equal(checkParentsCode(db, '0000'), false, 'none set');
  assert.throws(() => setParentsCode(db, '12a4'), { message: 'The code is 4 digits' });
  assert.throws(() => setParentsCode(db, '123'), { message: 'The code is 4 digits' });
  setParentsCode(db, '4821');
  assert.equal(hasParentsCode(db), true);
  assert.equal(checkParentsCode(db, '4821'), true);
  assert.equal(checkParentsCode(db, '4822'), false);
  assert.equal(checkParentsCode(db, ' 4821'), false);
  setParentsCode(db, '0000');
  assert.equal(checkParentsCode(db, '4821'), false);
  assert.equal(checkParentsCode(db, '0000'), true);
  assert.equal(JSON.stringify(getSettings(db)).includes('parentsCode'), false, 'never in the settings the app shows');
  const stored = (db.prepare("SELECT value FROM settings WHERE key = 'parentsCode'").get() as { value: string }).value;
  assert.equal(stored.includes('0000'), false, 'not kept in clear');
});
