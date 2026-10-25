import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type DB } from '../server/db.ts';
import { suggestions, recordActivity, rate } from '../server/suggestions.ts';

// Fixed clock: interest fades with time (half-life 14 days).
const NOW = Date.parse('2026-10-24T12:00:00');
const DAY = 24 * 3600 * 1000;
import { Tmdb } from '../server/tmdb.ts';

function seed() {
  const db = openDb(':memory:');
  const title = db.prepare(`INSERT INTO titles (media_type, tmdb_id, title_en, year, collection, source, fetched_at) VALUES ('movie', ?, ?, ?, ?, 'tmdb', 1)`);
  const item = db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, tmdb_id, match_state, present, hidden, playcount, resume, last_played, added_at, updated_at)
    VALUES (?, 'MOVIES', 'movies', 0, 'movie', ?, 'matched', ?, ?, ?, ?, ?, 1, 1)`);
  const add = (tmdbId: number, name: string, year: number, o: { set?: string; present?: number; hidden?: number; plays?: number; resume?: number; last?: string } = {}) => {
    title.run(tmdbId, name, year, o.set ?? null);
    return Number(item.run(`MOVIES/${name}.mkv`, tmdbId, o.present ?? 1, o.hidden ?? 0, o.plays ?? 0, o.resume ?? 0, o.last ?? null).lastInsertRowid);
  };
  const ids = {
    hp1: add(671, 'HP 1', 2001, { set: 'Harry Potter Collection', plays: 1, last: '2026-10-21 23:00:00' }),
    hp2: add(672, 'HP 2', 2002, { set: 'Harry Potter Collection' }),
    hp3: add(673, 'HP 3', 2004, { set: 'Harry Potter Collection' }),
    mufasa: add(762509, 'Mufasa', 2024, { plays: 1, last: '2026-09-30 21:00:00' }),
    lionKing: add(8587, 'The Lion King', 1994),
    narnia: add(411, 'Narnia', 2005),
    hook: add(879, 'Hook', 1991),
    watched: add(12, 'Finding Nemo', 2003, { plays: 2, last: '2020-01-01 10:00:00' }),
    started: add(585, 'Monsters, Inc.', 2001, { resume: 0.4, last: '2026-10-01 10:00:00' }),
    gone: add(259316, 'Fantastic Beasts', 2016, { present: 0 }),
    hidden: add(10191, 'How to Train Your Dragon', 2010, { hidden: 1 }),
  };
  return { db, ids };
}

function fakeTmdb(recs: Record<number, number[]>, calls: string[] = []) {
  const fetchFn = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    calls.push(u.pathname);
    const m = /^\/3\/movie\/(\d+)\/recommendations$/.exec(u.pathname);
    if (!m) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({ results: (recs[Number(m[1])] ?? []).map((id) => ({ id })) }));
  }) as typeof fetch;
  return new Tmdb('k', fetchFn, 0);
}

const show = (db: DB, list: Array<{ id: number; because: number; kind: string }>) => {
  const name = (id: number) => (db.prepare('SELECT path FROM items WHERE id = ?').get(id) as { path: string }).path.slice(7, -4);
  return list.map((s) => `${name(s.id)} <${s.kind}> ${name(s.because)}`);
};

test('suggests the next film of a started set, then TMDB recommendations of recent views', async () => {
  const { db, ids } = seed();
  const tmdb = fakeTmdb({
    671: [672, 411, 879, 12, 259316, 10191], // HP 1: HP 2, Narnia, Hook, and some to leave out
    762509: [8587, 411, 585], // Mufasa: The Lion King, Narnia, and one already started
  });
  const out = await suggestions(db, tmdb, NOW);
  // Recent views weigh more: Hook (3rd for HP 1, 3 days ago) beats The Lion King (1st for Mufasa, 3 weeks ago).
  assert.deepEqual(show(db, out), [
    'HP 2 <next> HP 1',
    'Narnia <like> HP 1',
    'Hook <like> HP 1',
    'The Lion King <like> Mufasa',
  ]);
  assert.ok(!out.some((s) => s.id === ids.hp3), 'only the next film of a set');
});

test('TMDB lists are cached; without TMDB only sets are suggested', async () => {
  const { db } = seed();
  const calls: string[] = [];
  const tmdb = fakeTmdb({ 671: [411] }, calls);
  await suggestions(db, tmdb, NOW);
  const first = calls.length;
  assert.equal(first, 4, 'one call per title watched or started');
  await suggestions(db, tmdb, NOW + DAY);
  assert.equal(calls.length, first, 'second run uses the cache');
  assert.deepEqual(show(db, await suggestions(db, null, NOW)), ['HP 2 <next> HP 1', 'Narnia <like> HP 1'], 'cached lists still count');
  const fresh = seed().db;
  assert.deepEqual(show(fresh, await suggestions(fresh, null, NOW)), ['HP 2 <next> HP 1'], 'no key, nothing cached: sets only');
});

test('a TMDB failure for one title does not lose the others', async () => {
  const { db } = seed();
  const fetchFn = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    if (u.pathname.includes('/671/')) return new Response('', { status: 500 });
    return new Response(JSON.stringify({ results: [{ id: 8587 }] }));
  }) as typeof fetch;
  const out = await suggestions(db, new Tmdb('k', fetchFn, 0), NOW);
  // The other titles all recommend The Lion King; the most recent of them is the reason.
  assert.deepEqual(show(db, out), ['HP 2 <next> HP 1', 'The Lion King <like> Monsters, Inc.']);
});

test('what you do in the app steers suggestions: pages opened, trailers, plays', async () => {
  const { db, ids } = seed();
  const tmdb = fakeTmdb({ 671: [672], 411: [879, 8587] }); // Narnia: Hook, The Lion King
  assert.deepEqual(show(db, await suggestions(db, tmdb, NOW)), ['HP 2 <next> HP 1'], 'nothing points at Narnia yet');
  // Narnia's page opened twice and its trailer watched today: now the strongest interest.
  recordActivity(db, ids.narnia, 'open', NOW - 3600_000);
  recordActivity(db, ids.narnia, 'open', NOW - 1200_000);
  recordActivity(db, ids.narnia, 'trailer', NOW - 1100_000);
  assert.deepEqual(show(db, await suggestions(db, tmdb, NOW)), ['HP 2 <next> HP 1', 'Hook <like> Narnia', 'The Lion King <like> Narnia']);
  // The Lion King played in VLC: no longer suggested.
  recordActivity(db, ids.lionKing, 'play', NOW - 60_000);
  assert.deepEqual(show(db, await suggestions(db, tmdb, NOW)), ['HP 2 <next> HP 1', 'Hook <like> Narnia']);
});

test('repeated events in a short time count once', () => {
  const { db, ids } = seed();
  recordActivity(db, ids.narnia, 'open', NOW);
  recordActivity(db, ids.narnia, 'open', NOW + 5 * 60_000);
  recordActivity(db, ids.narnia, 'play', NOW + 6 * 60_000);
  recordActivity(db, ids.narnia, 'play', NOW + 20 * 60_000); // VLC asks for the file many times while seeking
  recordActivity(db, ids.narnia, 'open', NOW + 11 * 60_000);
  const kinds = (db.prepare('SELECT kind FROM activity ORDER BY at').all() as Array<{ kind: string }>).map((r) => r.kind);
  assert.deepEqual(kinds, ['open', 'play', 'open']);
});

test('one film per set: the one after the latest you saw, else the earliest you have not seen', async () => {
  const { db, ids } = seed();
  // HP 1 seen; TMDB likes HP 3 more than HP 2 for Mufasa: the votes go to HP 2, the next one.
  const tmdb = fakeTmdb({ 762509: [673, 672] });
  let out = await suggestions(db, tmdb, NOW);
  assert.deepEqual(show(db, out), ['HP 2 <next> HP 1']);
  assert.ok(!out.some((s) => s.id === ids.hp3));
  // Only the last film seen (like Le Gendarme et les Gendarmettes): start the set from the beginning.
  db.prepare("UPDATE items SET playcount = 0, last_played = NULL WHERE id = ?").run(ids.hp1);
  db.prepare("UPDATE items SET playcount = 1, last_played = '2026-10-23 21:00:00' WHERE id = ?").run(ids.hp3);
  out = await suggestions(db, fakeTmdb({ 762509: [672] }), NOW + DAY * 31);
  assert.deepEqual(show(db, out), ['HP 1 <next> HP 3']);
});

test('a film you liked steers suggestions more than a play, even one watched long ago', async () => {
  const { db } = seed();
  const tmdb = fakeTmdb({ 671: [411], 12: [879] }); // HP 1: Narnia; Finding Nemo (watched in 2020): Hook
  assert.deepEqual(show(db, await suggestions(db, tmdb, NOW)), ['HP 2 <next> HP 1', 'Narnia <like> HP 1', 'Hook <like> Finding Nemo']);
  rate(db, 'movie', 12, 1, NOW);
  assert.deepEqual(show(db, await suggestions(db, tmdb, NOW)), ['Hook <like> Finding Nemo', 'HP 2 <next> HP 1', 'Narnia <like> HP 1']);
});

test('a film you did not like stops steering, and what TMDB pairs with it drops', async () => {
  const { db } = seed();
  const tmdb = fakeTmdb({ 671: [8587], 762509: [8587, 411] }); // HP 1: The Lion King; Mufasa: The Lion King, Narnia
  assert.deepEqual(show(db, await suggestions(db, tmdb, NOW)), ['HP 2 <next> HP 1', 'The Lion King <like> HP 1', 'Narnia <like> Mufasa']);
  rate(db, 'movie', 671, -1, NOW);
  assert.deepEqual(show(db, await suggestions(db, tmdb, NOW)), ['Narnia <like> Mufasa']);
  rate(db, 'movie', 671, null, NOW);
  assert.equal((await suggestions(db, tmdb, NOW)).length, 3, 'rating removed');
});
