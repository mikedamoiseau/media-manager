import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { peopleIndex, findPeople } from '../server/people.ts';
import { applyFilters, groupCards, DEFAULT_FILTERS } from '../web/src/search.ts';
import { peopleTitles } from '../web/src/peopleTitles.ts';
import type { Card } from '../web/src/types.ts';

function seed() {
  const db = openDb(':memory:');
  const title = db.prepare(`INSERT INTO titles (media_type, tmdb_id, title_en, cast_json, directors, source, fetched_at) VALUES (?, ?, ?, ?, ?, 'tmdb', 1)`);
  const item = db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, tmdb_id, match_state, present, hidden, added_at, updated_at)
    VALUES (?, 'MOVIES', 'movies', 0, ?, ?, 'matched', ?, ?, 1, 1)`);
  const copy = (type: string, id: number, path: string, o: { present?: number; hidden?: number } = {}) => item.run(path, type, id, o.present ?? 1, o.hidden ?? 0);
  const add = (type: string, id: number, name: string, cast: string[] | null, directors: string[], o: { present?: number; hidden?: number } = {}) => {
    title.run(type, id, name, cast && JSON.stringify(cast.map((n) => ({ name: n, character: 'Someone' }))), JSON.stringify(directors));
    copy(type, id, `MOVIES/${name}.mkv`, o);
  };
  return { db, add, copy };
}

function library() {
  const { db, add, copy } = seed();
  add('movie', 949, 'Heat', ['Al Pacino', 'Robert De Niro'], ['Michael Mann']);
  copy('movie', 949, 'MOVIES/Heat 4K.mkv');
  add('movie', 398978, 'The Irishman', ['Robert De Niro', 'Al Pacino', 'Joe Pesci'], ['Martin Scorsese']);
  add('movie', 769, 'Goodfellas', ['Robert De Niro', 'Joe Pesci'], ['Martin Scorsese']);
  add('movie', 524, 'Casino', ['Robert De Niro', 'Sharon Stone'], ['Martin Scorsese'], { present: 0 });
  add('movie', 1, 'Hidden', ['Robert De Niro'], [], { hidden: 1 });
  add('movie', 2, 'Unforgiven', ['Clint Eastwood'], ['Clint Eastwood']);
  add('movie', 3, 'Le Gendarme de Saint-Tropez', ['Louis de Funès'], ['Jean Girault']);
  add('tv', 1399, 'Game of Thrones', ['Peter Dinklage'], ['David Benioff']);
  add('movie', 4, 'No cast yet', null, []);
  db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, match_state, present, added_at, updated_at)
    VALUES ('MOVIES/Unknown.mkv', 'MOVIES', 'movies', 0, 'movie', 'unmatched', 1, 1, 1)`).run();
  return peopleIndex(db);
}

test('everyone in the titles of the library: their titles, and how many the library shows', () => {
  const index = library();
  const deNiro = index.get('Robert De Niro')!;
  // Every title, for the filter to work with any status (not on the NAS, hidden)...
  assert.deepEqual([...deNiro.g].sort(), ['movie:1', 'movie:398978', 'movie:524', 'movie:769', 'movie:949']);
  // ...but the count is what the library shows by default: on the NAS, not hidden, two copies once.
  assert.equal(deNiro.n, 3);
  assert.equal(index.get('Martin Scorsese')!.n, 2, 'directors too');
  assert.equal(index.get('Clint Eastwood')!.n, 1, 'acting in and directing a title counts it once');
  assert.deepEqual([...index.get('David Benioff')!.g], ['tv:1399'], 'series: their creators');
  assert.equal(index.get('Sharon Stone')!.n, 0);
});

test('finding people: the most titles first, by any part of the name, accents or not', () => {
  const index = library();
  assert.deepEqual(
    findPeople(index, '').slice(0, 4).map((p) => [p.name, p.n]),
    [['Robert De Niro', 3], ['Al Pacino', 2], ['Joe Pesci', 2], ['Martin Scorsese', 2]],
  );
  assert.deepEqual(findPeople(index, 'louis funes').map((p) => p.name), ['Louis de Funès']);
  assert.deepEqual(findPeople(index, 'PESCI').map((p) => p.name), ['Joe Pesci']);
  assert.deepEqual(findPeople(index, 'stone'), [], 'no title shown by default: not offered');
  assert.equal(findPeople(index, '', 2).length, 2);
});

let nextId = 1;
const film = (fr: string, g: string): Card => ({
  id: nextId++, g, fr, en: fr, o: fr, y: 2000, c: 'movies', ge: [], p: null, r: null, q: [], t: 'movie', d: false, n: 1,
  m: 'matched', w: false, rs: false, pr: true, h: false, a: nextId, s: fr.toLowerCase(),
});

test('the library filtered to people: titles with all of them', () => {
  const groups = groupCards([film('Heat', 'movie:949'), film('The Irishman', 'movie:398978'), film('Goodfellas', 'movie:769')]);
  const keys = new Map([
    ['Al Pacino', new Set(['movie:949', 'movie:398978'])],
    ['Joe Pesci', new Set(['movie:398978', 'movie:769'])],
  ]);
  const titles = (people: string[]) => applyFilters(groups, { ...DEFAULT_FILTERS, people }, 'fr', keys).map((g) => g.main.fr);
  assert.deepEqual(titles(['Al Pacino']).sort(), ['Heat', 'The Irishman']);
  assert.deepEqual(titles(['Al Pacino', 'Joe Pesci']), ['The Irishman']);
  assert.deepEqual(titles(['Robert De Niro']), [], 'until their titles are loaded, none show');
  assert.equal(titles([]).length, 3);
});

/** A server whose answers come when the test says. */
function slowServer() {
  const calls: Array<{ name: string; resolve: (g: string[]) => void; reject: (e: Error) => void }> = [];
  const titles = peopleTitles((name) => new Promise((resolve, reject) => calls.push({ name, resolve, reject })));
  return { calls, titles };
}
const settle = () => new Promise((r) => setImmediate(r));

test('the titles of a person: asked once per library, an answer for an older library dropped', async () => {
  const { calls, titles } = slowServer();
  titles.want(['Al Pacino'], 'v1');
  titles.want(['Al Pacino'], 'v1');
  assert.equal(calls.length, 1, 'asked once');
  // The library changes while the answer is on its way.
  titles.want(['Al Pacino'], 'v2');
  assert.equal(calls.length, 2, 'asked again for the new library');
  calls[0]!.resolve(['movie:1']);
  await settle();
  assert.equal(titles.get().keys.has('Al Pacino'), false, 'the answer for the older library is dropped');
  calls[1]!.resolve(['movie:949']);
  await settle();
  assert.deepEqual([...titles.get().keys.get('Al Pacino')!], ['movie:949']);
});

test('a failed lookup is not "no titles": asked again after retry', async () => {
  const { calls, titles } = slowServer();
  titles.want(['Joe Pesci'], 'v1');
  calls[0]!.reject(new Error('Network down'));
  await settle();
  assert.equal(titles.get().error, 'Network down');
  assert.equal(titles.get().keys.has('Joe Pesci'), false);
  titles.want(['Joe Pesci'], 'v1');
  assert.equal(calls.length, 1, 'not asked again and again while failing');
  titles.retry();
  titles.want(['Joe Pesci'], 'v1');
  assert.equal(calls.length, 2);
  calls[1]!.resolve([]);
  await settle();
  assert.deepEqual([...titles.get().keys.get('Joe Pesci')!], [], 'a real answer of no titles is kept');
  assert.equal(titles.get().error, null);
});

test('a lookup for an older library failing leaves the newer one alone', async () => {
  const { calls, titles } = slowServer();
  titles.want(['Al Pacino'], 'v1');
  titles.want(['Al Pacino'], 'v2');
  calls[0]!.reject(new Error('Network down'));
  await settle();
  titles.want(['Al Pacino'], 'v2');
  assert.equal(calls.length, 2, 'the newer lookup is still on its way: not asked again');
  assert.equal(titles.get().error, null);
  calls[1]!.resolve(['movie:949']);
  await settle();
  assert.deepEqual([...titles.get().keys.get('Al Pacino')!], ['movie:949']);
});
