import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { libraryCards } from '../server/views.ts';
import { setParts } from '../server/sets.ts';
import { Tmdb } from '../server/tmdb.ts';
import { groupCards, groupSets, isSet, setLineup, setName, splitSet, DEFAULT_FILTERS } from '../web/src/search.ts';
import type { Card } from '../web/src/types.ts';

let nextId = 1;
const film = (fr: string, y: number, k?: string, a = y): Card => {
  const id = nextId++;
  return {
    id, g: `movie:${id}`, fr, en: fr, o: fr, y, c: 'movies', ge: [], p: null, r: null, q: [], t: 'movie', d: false, n: 1,
    m: 'matched', w: false, rs: false, pr: true, h: false, a, s: fr.toLowerCase(), ...(k ? { k } : {}),
  };
};

test('sets come first, in the order of their best-ranked film, then the other titles', () => {
  // Sorted by "recently added": Heat is the newest, then Rocky III, Alien 3, Rocky...
  const groups = groupCards([
    film('Heat', 1995, undefined, 1000),
    film('Rocky III', 1982, 'Rocky Collection', 900),
    film('Alien 3', 1992, 'Alien Collection', 850),
    film('Rocky', 1976, 'Rocky Collection', 700),
    film('Rambo', 1982, 'Rambo Collection', 600),
    film('Alien', 1979, 'Alien Collection', 500),
  ]);
  const out = groupSets(groups, DEFAULT_FILTERS);
  assert.deepEqual(out.map((e) => (isSet(e) ? `set:${e.name}` : e.main.fr)), ['set:Rocky', 'set:Alien', 'Heat', 'Rambo']);
  const rocky = out[0]!;
  assert.ok(isSet(rocky));
  assert.deepEqual(rocky.members.map((g) => g.main.fr), ['Rocky', 'Rocky III'], 'members in release order');
  assert.ok(!isSet(out[3]!), 'a lone member stays a plain title');
});

test('title sort orders sets by their own name', () => {
  const groups = groupCards([
    film('La Guerre des étoiles', 1977, 'Star Wars Collection'),
    film("L'Empire contre-attaque", 1980, 'Star Wars Collection'),
    film('Rocky II', 1979, 'Rocky Collection'),
    film('Rocky III', 1982, 'Rocky Collection'),
    film('Speed', 1994),
    film('Titanic', 1997),
  ]);
  const sorted = [...groups].sort((a, b) => a.main.fr.localeCompare(b.main.fr));
  const names = groupSets(sorted, { ...DEFAULT_FILTERS, sort: 'title' }).map((e) => (isSet(e) ? e.name : e.main.fr));
  assert.deepEqual(names, ['Rocky', 'Star Wars', 'Speed', 'Titanic']);
});

test('set names drop the TMDB "Collection" suffix', () => {
  assert.equal(setName('Le Gendarme de Saint-Tropez Collection'), 'Le Gendarme de Saint-Tropez');
  assert.equal(setName('Asterix and Obelix (Animation) Collection'), 'Asterix and Obelix (Animation)');
  assert.equal(setName('Collection'), 'Collection');
});

test('library cards carry the TMDB collection', () => {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO titles (media_type, tmdb_id, title_en, collection, source, fetched_at) VALUES ('movie', 1366, 'Rocky', 'Rocky Collection', 'tmdb', 1)`).run();
  const ins = db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, tmdb_id, match_state, added_at, updated_at)
    VALUES (?, 'MOVIES', 'movies', 0, 'movie', ?, 'matched', 1, 1)`);
  ins.run('MOVIES/Rocky (1976).mkv', 1366);
  ins.run('MOVIES/Heat (1995).mkv', null);
  const cards = libraryCards(db);
  assert.equal(cards.find((c) => c.fr === 'Rocky')?.k, 'Rocky Collection');
  assert.equal('k' in JSON.parse(JSON.stringify(cards.find((c) => c.fr !== 'Rocky'))), false, 'no key when there is no collection');
});

test('a set lists every film of its TMDB collection, fetched once then cached', async () => {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO titles (media_type, tmdb_id, title_en, collection, source, fetched_at) VALUES ('movie', 1368, 'First Blood', 'Rambo Collection', 'tmdb', 1)`).run();
  const calls: string[] = [];
  const parts = (lang: string) => [
    { id: 1369, title: lang === 'fr-FR' ? 'Rambo II : La Mission' : 'Rambo: First Blood Part II', original_title: 'Rambo: First Blood Part II', release_date: '1985-05-22', poster_path: '/b.jpg' },
    { id: 1368, title: lang === 'fr-FR' ? 'Rambo' : 'First Blood', original_title: 'First Blood', release_date: '1982-10-22', poster_path: '/a.jpg' },
    { id: 9999, title: 'Rambo 6', original_title: 'Rambo 6', release_date: '', poster_path: null },
  ];
  const fake = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    calls.push(`${u.pathname}${u.searchParams.get('language') ? `?${u.searchParams.get('language')}` : ''}`);
    if (u.pathname === '/3/movie/1368') return new Response(JSON.stringify({ id: 1368, belongs_to_collection: { id: 5039, name: 'Rambo Collection' } }));
    if (u.pathname === '/3/collection/5039') return new Response(JSON.stringify({ id: 5039, parts: parts(u.searchParams.get('language')!) }));
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  const tmdb = new Tmdb('k', fake, 0);

  const first = await setParts(db, tmdb, 'Rambo Collection', 1000);
  assert.deepEqual(first.map((p) => [p.id, p.fr, p.en, p.date]), [
    [1368, 'Rambo', 'First Blood', '1982-10-22'],
    [1369, 'Rambo II : La Mission', 'Rambo: First Blood Part II', '1985-05-22'],
    [9999, 'Rambo 6', 'Rambo 6', null],
  ], 'release order, undated last');
  assert.equal(first[0]!.poster, 'https://image.tmdb.org/t/p/w342/a.jpg');
  assert.equal(calls.length, 3);

  assert.deepEqual(await setParts(db, tmdb, 'Rambo Collection', 2000), first, 'served from the cache');
  assert.equal(calls.length, 3);

  // A week later TMDB is down: the stale list is better than nothing.
  const broken = new Tmdb('k', (async () => new Response('', { status: 503 })) as typeof fetch, 0);
  assert.deepEqual(await setParts(db, broken, 'Rambo Collection', 1000 + 8 * 24 * 3600 * 1000), first);
});

test('a set nobody can place in a TMDB collection has no extra films', async () => {
  const db = openDb(':memory:');
  const tmdb = new Tmdb('k', (async () => { throw new Error('no network expected'); }) as typeof fetch, 0);
  assert.deepEqual(await setParts(db, tmdb, 'Unknown Collection'), []);
});

test('a set page splits films on the NAS from missing ones', () => {
  const owned = film('Rambo', 1982, 'Rambo Collection');
  const sheetOnly = { ...film('Rambo III', 1988, 'Rambo Collection'), pr: false };
  const kodiOnly = film('John Rambo', 2008); // its title row lost the collection, TMDB still lists it
  const groups = groupCards([owned, sheetOnly, kodiOnly]);
  const id = (c: Card) => Number(c.g.split(':')[1]);
  const part = (c: Card | number, date: string | null, fr = 'x') => ({ id: typeof c === 'number' ? c : id(c), fr, en: fr, o: fr, date, poster: null });
  const parts = [
    part(owned, '1982-10-22'), part(77, '1985-05-22', 'Rambo II'), part(sheetOnly, '1988-05-24'),
    part(kodiOnly, '2008-01-24'), part(78, '2030-01-01', 'Rambo 6'),
  ];
  const onNas = groups.filter((g) => g.items.some((c) => c.pr));
  const s = splitSet('Rambo Collection', parts, onNas, groups, '2026-10-24');
  assert.deepEqual(s.available.map((g) => g.main.fr), ['Rambo', 'John Rambo']);
  assert.deepEqual(s.missing.map((m) => [m.part.id, m.group?.main.fr]), [[77, undefined], [id(sheetOnly), 'Rambo III'], [78, undefined]]);
  assert.deepEqual([s.onNas, s.released], [2, 4], 'unreleased films do not count');
});

test("a film's page shows its whole set in release order, films not on the NAS greyed", () => {
  const rocky = film('Rocky', 1976, 'Rocky Collection');
  const rocky3 = film('Rocky III', 1982, 'Rocky Collection');
  const rocky4 = film('Rocky IV', 1985, 'Rocky Collection'); // matched to an id TMDB doesn't list for the set
  const balboa = { ...film('Rocky Balboa', 2006, 'Rocky Collection'), h: true }; // hidden from the library
  const groups = groupCards([rocky, rocky3, rocky4, balboa, film('Heat', 1995)]);
  const id = (c: Card) => Number(c.g.split(':')[1]);
  const part = (pid: number, date: string, fr: string) => ({ id: pid, fr, en: fr, o: fr, date, poster: null });
  const parts = [part(id(rocky), '1976-11-21', 'Rocky'), part(990, '1979-06-15', 'Rocky II'), part(id(rocky3), '1982-05-28', 'Rocky III'), part(id(balboa), '2006-12-20', 'Rocky Balboa')];
  const show = (l: ReturnType<typeof setLineup>) => l.map((e) => (e.group ? e.group.main.fr : `(${e.part!.fr})`));
  assert.deepEqual(show(setLineup('Rocky Collection', parts, groups)), ['Rocky', '(Rocky II)', 'Rocky III', 'Rocky IV', '(Rocky Balboa)']);
  assert.deepEqual(show(setLineup('Rocky Collection', [], groups)), ['Rocky', 'Rocky III', 'Rocky IV'], 'before TMDB answers: the library films');
});
