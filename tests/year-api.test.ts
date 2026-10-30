import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { openDb, saveSettings } from '../server/db.ts';
import { Service } from '../server/service.ts';
import { createApi } from '../server/api.ts';
import { PROFILE_COLORS, addProfile } from '../server/profiles.ts';
import { setParentsCode } from '../server/kids.ts';

const at = (month: number, day: number, hour = 20) => new Date(2026, month, day, hour).getTime();

/** The app on `now`, with TMDB answering a photo for every person; Anna watched three films, two with the same lead. */
function setup(t: TestContext, now: number) {
  t.mock.timers.enable({ apis: ['Date'], now });
  const people: string[] = [];
  const tmdb = { down: false };
  t.mock.method(globalThis, 'fetch', async (input: string | URL) => {
    const url = new URL(String(input));
    if (tmdb.down) return new Response('{}', { status: 500 });
    if (!url.pathname.endsWith('/search/person')) return new Response('{}', { status: 404 });
    people.push(url.searchParams.get('query')!);
    return new Response(JSON.stringify({ results: [{ profile_path: '/lead.jpg' }] }));
  });
  const db = openDb(':memory:');
  saveSettings(db, { mediaRoot: mkdtempSync(join(tmpdir(), 'media-')), tmdbKey: 'k' });
  const anna = addProfile(db, { name: 'Anna', color: PROFILE_COLORS[1] }).id;
  /** A film watched by `profile` (an item of TMDB film `n`: another copy of it when `n` is used again). */
  const watched = (profile: number, n: number, o: { cast?: string[]; category?: string; present?: number; day?: number } = {}) => {
    db.prepare(`INSERT OR IGNORE INTO titles (media_type, tmdb_id, title_en, runtime, cast_json, source, fetched_at) VALUES ('movie', ?, ?, 100, ?, 'tmdb', 1)`)
      .run(n, `Film ${n}`, JSON.stringify((o.cast ?? []).map((name) => ({ name, character: '' }))));
    const item = Number(db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, tmdb_id, match_state, present, added_at, updated_at)
      VALUES (?, 'MOVIES', ?, 0, 'movie', ?, 'matched', ?, 1, 1)`).run(`MOVIES/${n}.${profile}.${o.present ?? 1}.mkv`, o.category ?? 'movies', n, o.present ?? 1).lastInsertRowid);
    db.prepare(`INSERT INTO plays (profile_id, item_id, kind, device, at, minutes, finished) VALUES (?, ?, 'film', 'tv1', ?, 100, 1)`).run(profile, item, at(9, o.day ?? n));
    return item;
  };
  watched(anna, 1, { cast: ['Lead'] });
  watched(anna, 2, { cast: ['Lead'] });
  watched(anna, 3, { cast: ['Other'] });
  const app = new Hono().route('/api', createApi(new Service(db, mkdtempSync(join(tmpdir(), 'data-')))));
  const call = async (method: string, path: string, profile = anna) => {
    const r = await app.request(`/api${path}`, { method, headers: { 'x-profile': String(profile) } });
    return { status: r.status, json: (r.status === 204 ? null : await r.json()) as Record<string, unknown> };
  };
  return { db, anna, people, tmdb, watched, call };
}

test('the year of the profile asking, and whether it was asked', async (t) => {
  const s = setup(t, at(11, 2));
  let r = await s.call('GET', '/year');
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.year, r.json.films, r.json.asked], [2026, 3, false]);
  assert.equal((await s.call('POST', '/year/asked')).status, 204);
  r = await s.call('GET', '/year');
  assert.equal(r.json.asked, true);
  assert.equal((await s.call('GET', '/year', 1)).status, 404, "the main profile's year: nothing watched");
  assert.deepEqual(
    s.db.prepare('SELECT profile_id, year FROM year_asked').all().map((x) => ({ ...x })),
    [{ profile_id: s.anna, year: 2026 }],
  );
});

test('November: nothing yet; ?year= shows it anyway', async (t) => {
  const s = setup(t, at(10, 15));
  assert.deepEqual(await s.call('GET', '/year'), { status: 404, json: { error: 'Nothing to show' } });
  const r = await s.call('GET', '/year?year=2026');
  assert.deepEqual([r.status, r.json.films], [200, 3]);
  assert.equal((await s.call('GET', '/year?year=soon')).status, 400);
  assert.equal((await s.call('POST', '/year/asked')).status, 404);
});

test("the actor's photo is asked of TMDB once", async (t) => {
  const s = setup(t, at(11, 2));
  const first = (await s.call('GET', '/year')).json.actor as { name: string; photo: string };
  const again = (await s.call('GET', '/year')).json.actor as { name: string; photo: string };
  assert.equal(first.name, 'Lead');
  assert.ok(first.photo.startsWith('/api/img?w=185&u='), first.photo);
  assert.equal(decodeURIComponent(first.photo.split('u=')[1]!), 'https://image.tmdb.org/t/p/w342/lead.jpg');
  assert.equal(again.photo, first.photo);
  assert.deepEqual(s.people, ['Lead']);
});

test("the actor's photo: TMDB failing is no photo, and asked again next time", async (t) => {
  const s = setup(t, at(11, 2));
  s.tmdb.down = true;
  assert.equal(((await s.call('GET', '/year')).json.actor as { photo: string | null }).photo, null);
  s.tmdb.down = false;
  assert.ok(((await s.call('GET', '/year')).json.actor as { photo: string | null }).photo);
  assert.deepEqual(s.people, ['Lead']);
});

test("a kids profile's year: only the titles kids mode shows it", async (t) => {
  const s = setup(t, at(11, 2));
  setParentsCode(s.db, '4821');
  const kid = addProfile(s.db, { name: 'Kid', color: PROFILE_COLORS[2], kids: true }).id;
  const shown = [11, 12, 13].map((n) => s.watched(kid, n, { category: 'kids', cast: n < 13 ? ['Toon'] : [] }));
  s.watched(kid, 11, { category: 'kids', present: 0, day: 20 });
  // Gone from the NAS, its only copy: still the kid's.
  s.watched(kid, 15, { category: 'kids', present: 0 });
  // Started on the TV in its kids view by someone else, or no longer allowed: not for the kid to see.
  s.watched(kid, 14);
  const r = await s.call('GET', '/year', kid);
  assert.deepEqual([r.status, r.json.films, r.json.titles, (r.json.posters as string[]).length], [200, 5, 4, 0]);
  const actor = r.json.actor as { name: string; titles: Array<{ itemId: number }> };
  assert.deepEqual([actor.name, actor.titles.map((x) => x.itemId)], ['Toon', [shown[0], shown[1]]], 'the copy the kid may open, not the one gone');
  assert.equal((await s.call('POST', '/year/asked', kid)).status, 204);
});
