import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getSettings, type DB } from '../server/db.ts';
import { ageOf, setParentsCode, checkParentsCode, hasParentsCode, allowedItems, setOverride, overrideOf, itemKey, kidsProfile, kidsProfiles, kidsRoute, KIDS_REMOTE, isBedtime, bedtimeStop } from '../server/kids.ts';
import { MAIN_PROFILE, PROFILE_COLORS, addProfile, editProfile } from '../server/profiles.ts';
import { enrichTitles } from '../server/metadata.ts';
import type { Tmdb, TitleDetails } from '../server/tmdb.ts';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { KIDS_TAG, kidsTagKeys, tagChanges, syncKidsTag } from '../server/kidsTag.ts';

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

/** A library with one item per case of the rule. */
export function kidsLibrary() {
  const db = openDb(':memory:');
  const item = db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, tmdb_id, match_state, present, hidden, kodi_id, kodi_type, added_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`);
  const title = db.prepare("INSERT OR IGNORE INTO titles (media_type, tmdb_id, genres, source, fetched_at, certs) VALUES (?, ?, ?, 'tmdb', 1, ?)");
  let n = 0;
  const add = (folder: string, o: { tmdb?: number; type?: string; genres?: string[]; certs?: object; dir?: number; present?: number; hidden?: number; kodi?: [string, number] } = {}) => {
    const category = folder === 'KIDS' ? 'kids' : folder === 'ANIMES' ? 'animes' : folder === 'SERIES' ? 'series' : 'movies';
    const type = o.type ?? 'movie';
    if (o.tmdb) title.run(type, o.tmdb, JSON.stringify(o.genres ?? []), o.certs ? JSON.stringify(o.certs) : '{}');
    return Number(item.run(`${folder}/${++n}.mkv`, folder, category, o.dir ?? 0, o.tmdb ? type : null, o.tmdb ?? null, o.tmdb ? 'matched' : 'unmatched',
      o.present ?? 1, o.hidden ?? 0, o.kodi?.[1] ?? null, o.kodi?.[0] ?? null).lastInsertRowid);
  };
  const ids = {
    kidsUnmatched: add('KIDS'),
    animationDe6: add('MOVIES', { tmdb: 101, genres: ['Animation'], certs: { DE: '6' }, kodi: ['movie', 6] }),
    dramaDe0: add('MOVIES', { tmdb: 102, genres: ['Drama'], certs: { DE: '0' } }),
    familyDe16: add('MOVIES', { tmdb: 103, genres: ['Family'], certs: { DE: '16' } }),
    animeFrTpUsR: add('ANIMES', { tmdb: 104, genres: ['Animation'], certs: { FR: 'TP', US: 'R' } }),
    animeFrTp: add('ANIMES', { tmdb: 105, genres: ['Animation'], certs: { FR: 'TP' } }),
    animationUnrated: add('MOVIES', { tmdb: 106, genres: ['Animation'] }),
    kidsDe16: add('KIDS', { tmdb: 107, certs: { DE: '16' } }),
    hiddenCartoon: add('KIDS', { hidden: 1 }),
    goneCartoon: add('KIDS', { present: 0 }),
    animationDe12: add('MOVIES', { tmdb: 108, genres: ['Animation'], certs: { DE: '12' }, kodi: ['movie', 12] }),
    drama18: add('MOVIES', { tmdb: 900, genres: ['Drama'], certs: { DE: '18' } }),
    drama18Copy: add('MOVIES', { tmdb: 900, genres: ['Drama'], certs: { DE: '18' } }),
    kidsShow: add('KIDS', { dir: 1, type: 'tv', kodi: ['tvshow', 3] }),
  };
  return { db, ids };
}

test('what a kid sees: made for kids and within age, unless a parent said otherwise', () => {
  const { db, ids } = kidsLibrary();
  const allowed = allowedItems(db, 12);
  assert.ok(allowed.has(ids.kidsUnmatched), 'in KIDS, no TMDB match: allowed');
  assert.ok(allowed.has(ids.kidsShow), 'a series folder in KIDS');
  assert.ok(allowed.has(ids.animationDe6), 'MOVIES, Animation, FSK 6');
  assert.ok(allowed.has(ids.animationDe12), 'MOVIES, Animation, FSK 12');
  assert.ok(!allowed.has(ids.dramaDe0), 'MOVIES, Drama, FSK 0: not made for kids');
  assert.ok(!allowed.has(ids.familyDe16), 'Family, FSK 16');
  assert.ok(!allowed.has(ids.animeFrTpUsR), 'ANIMES, Animation, FR TP + US R: 17');
  assert.ok(allowed.has(ids.animeFrTp), 'ANIMES, Animation, FR TP only: 0');
  assert.ok(!allowed.has(ids.animationUnrated), 'Animation outside KIDS, no rating');
  assert.ok(!allowed.has(ids.kidsDe16), 'in KIDS but FSK 16');
  assert.ok(!allowed.has(ids.hiddenCartoon) && !allowed.has(ids.goneCartoon), 'hidden or not on disk');
  assert.ok(!allowedItems(db, 6).has(ids.animationDe12), 'FSK 6 limit');

  assert.equal(itemKey(db, ids.drama18), 'movie:900');
  assert.equal(itemKey(db, ids.kidsUnmatched), `i:${ids.kidsUnmatched}`);
  setOverride(db, 'movie:900', 'ok');
  setOverride(db, `i:${ids.kidsUnmatched}`, 'no');
  assert.equal(overrideOf(db, 'movie:900'), 'ok');
  const after = allowedItems(db, 12);
  assert.ok(after.has(ids.drama18) && after.has(ids.drama18Copy), 'OK for kids: both copies');
  assert.ok(!after.has(ids.kidsUnmatched), 'not for kids');
  setOverride(db, 'movie:900', null);
  assert.equal(overrideOf(db, 'movie:900'), null);
  assert.ok(!allowedItems(db, 12).has(ids.drama18), 'back to automatic');
});

test('kids profiles: found by id, the others are not', () => {
  const { db } = kidsLibrary();
  setParentsCode(db, '4821');
  const kid = addProfile(db, { name: 'Kid', color: PROFILE_COLORS[2], kids: true, maxAge: 6, bedtime: '20:00' });
  const other = addProfile(db, { name: 'Other', color: PROFILE_COLORS[3] });
  assert.deepEqual(kidsProfile(db, kid.id), { id: kid.id, name: 'Kid', maxAge: 6, bedtime: '20:00' });
  assert.equal(kidsProfile(db, other.id), null);
  assert.equal(kidsProfile(db, MAIN_PROFILE), null);
  assert.deepEqual(kidsProfiles(db).map((k) => k.id), [kid.id]);
});

test('a kids profile reaches only its own routes', () => {
  for (const [m, p] of [['GET', '/library'], ['GET', '/marks'], ['GET', '/items/12'], ['POST', '/items/12/play'],
    ['POST', '/items/12/activity'], ['PUT', '/items/12/rating'], ['GET', '/continue'], ['POST', '/continue/12/dismiss'],
    ['GET', '/suggestions'], ['GET', '/kodi/now'], ['GET', '/kodi/streams'], ['POST', '/kodi/remote'], ['GET', '/status'],
    ['GET', '/events'], ['GET', '/profiles'], ['GET', '/kids/allowed'], ['POST', '/kids/unlock'], ['POST', '/refresh'],
    ['GET', '/img'], ['GET', '/thumb/12'], ['GET', '/poster/12']]) assert.equal(kidsRoute(m, p), true, `${m} ${p}`);
  for (const [m, p] of [['GET', '/elsewhere'], ['GET', '/cinema'], ['GET', '/films/3'], ['POST', '/kodi/power'], ['POST', '/kodi/input'],
    ['PUT', '/settings'], ['GET', '/settings'], ['PUT', '/profiles/1'], ['POST', '/profiles'], ['DELETE', '/profiles/2'], ['GET', '/person'],
    ['GET', '/people'], ['GET', '/set'], ['POST', '/items/12/match'], ['PATCH', '/items/12'], ['GET', '/media/item/12/a.mkv'],
    ['GET', '/handoff/item/12/x/a.mkv'], ['POST', '/items/12/trailer'], ['PUT', '/kids/code'], ['PUT', '/kids/items/12'], ['GET', '/kids/items/12'],
    ['POST', '/tvs'], ['POST', '/scan'], ['GET', '/reports/wanted'], ['GET', '/items/12/posters'], ['GET', '/items/12/x'], ['DELETE', '/items/12']])
    assert.equal(kidsRoute(m, p), false, `${m} ${p}`);
  assert.deepEqual([...KIDS_REMOTE].sort(), ['audio', 'mute', 'playpause', 'stop', 'subtitles', 'volume']);
});

const at = (hm: string) => new Date(`2026-10-26T${hm}:00`);

test('bedtime: from the time set until 6:00', () => {
  assert.equal(isBedtime(null, at('23:00')), false);
  for (const [hm, want] of [['19:59', false], ['20:00', true], ['23:59', true], ['00:29', true], ['05:59', true], ['06:00', false]] as const)
    assert.equal(isBedtime('20:00', at(hm)), want, `20:00 at ${hm}`);
  for (const [hm, want] of [['23:59', false], ['00:29', false], ['00:30', true], ['05:59', true], ['06:00', false]] as const)
    assert.equal(isBedtime('00:30', at(hm)), want, `00:30 at ${hm}`);
});

test('bedtime stops only what Kodi chained by itself, for a kid, after bedtime', () => {
  const kid = { bedtime: '20:00' };
  assert.equal(bedtimeStop(kid, true, at('21:00')), true);
  assert.equal(bedtimeStop(kid, false, at('20:00')), false, 'Play pressed at 19:59, event at 20:00');
  assert.equal(bedtimeStop(kid, true, at('19:00')), false);
  assert.equal(bedtimeStop({ bedtime: null }, true, at('21:00')), false, 'no bedtime');
  assert.equal(bedtimeStop(null, true, at('21:00')), false, 'a parent');
});

test("the app's bedtime is the server's", async () => {
  const web = await import('../web/src/kids.ts');
  for (const b of ['20:00', '00:30', null]) for (const hm of ['00:00', '00:30', '05:59', '06:00', '19:59', '20:00', '23:59'])
    assert.equal(web.isBedtime(b, at(hm)), isBedtime(b, at(hm)), `${b} at ${hm}`);
  assert.deepEqual(web.FSK_STEPS, [0, 6, 12, 16]);
});

test("the app's library for a kids profile: only its titles, nothing until it knows them", async () => {
  const { kidsLibrary: filter } = await import('../web/src/kids.ts');
  const cards = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(filter(cards, null), cards, 'not a kids profile');
  assert.deepEqual(filter(cards, new Set([2])), [{ id: 2 }]);
  assert.deepEqual(filter(cards, undefined), [], 'a kids list not loaded yet');
});

test('the Kids tag: added and removed, other tags kept', () => {
  // Kodi's tags are the scraper's TMDB keywords, "kids" among them: the app's tag must not be one.
  assert.equal(KIDS_TAG, 'Cinematheque Kids');
  const kodi = [
    { key: 'movie:1', tags: ['Favs', 'kids'] },
    { key: 'movie:2', tags: [KIDS_TAG, 'Favs'] },
    { key: 'tvshow:3', tags: [KIDS_TAG] },
    { key: 'movie:4', tags: [] },
    // Kodi's database ignores case: the tag as it was first spelled is the tag.
    { key: 'movie:5', tags: ['cinematheque kids'] },
    { key: 'movie:8', tags: ['CINEMATHEQUE KIDS', 'kids'] },
  ];
  assert.deepEqual(tagChanges(kodi, new Set(['movie:1', 'tvshow:3', 'movie:5'])), [
    { key: 'movie:1', tags: ['Favs', 'kids', KIDS_TAG] },
    { key: 'movie:2', tags: ['Favs'] },
    { key: 'movie:8', tags: ['kids'] },
  ]);
});

test('the Kids tag holds what every kid may watch', () => {
  // animationDe12 (Kodi movie 12), animationDe6 (Kodi movie 6), kidsShow (KIDS folder series, Kodi tvshow 3)
  const { db } = kidsLibrary();
  assert.deepEqual([...kidsTagKeys(db)], [], 'no kids profile: nothing tagged');
  setParentsCode(db, '4821');
  addProfile(db, { name: 'Older', color: PROFILE_COLORS[2], kids: true, maxAge: 12 });
  assert.deepEqual([...kidsTagKeys(db)].sort(), ['movie:12', 'movie:6', 'tvshow:3']);
  addProfile(db, { name: 'Younger', color: PROFILE_COLORS[3], kids: true, maxAge: 6 });
  assert.deepEqual([...kidsTagKeys(db)].sort(), ['movie:6', 'tvshow:3'], 'only what both may watch');
});

test("the Kids tag in Kodi: only the titles that change, only their tags", async () => {
  const { db } = kidsLibrary();
  // No kids profile yet: Kodi is left alone (a "Kids" tag set by hand stays).
  assert.equal(await syncKidsTag(db, { host: '127.0.0.1', port: 9 }), 0);
  setParentsCode(db, '4821');
  addProfile(db, { name: 'Older', color: PROFILE_COLORS[2], kids: true, maxAge: 12 });
  // A stand-in Kodi: films 6 (untagged) and 7 (tagged, not for kids), show 3 (tagged already).
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const m = JSON.parse(body) as { id: number; method: string; params: Record<string, unknown> };
      calls.push({ method: m.method, params: m.params });
      const result =
        m.method === 'VideoLibrary.GetMovies'
          ? { movies: [{ movieid: 6, tag: ['Favs'] }, { movieid: 7, tag: [KIDS_TAG] }, { movieid: 12, tag: [] }], limits: { total: 3 } }
          : m.method === 'VideoLibrary.GetTVShows'
            ? { tvshows: [{ tvshowid: 3, tag: [KIDS_TAG] }], limits: { total: 1 } }
            : 'OK';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: m.id, jsonrpc: '2.0', result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as AddressInfo).port;
    assert.equal(await syncKidsTag(db, { host: '127.0.0.1', port }), 3);
    const writes = calls.filter((c) => c.method.startsWith('VideoLibrary.Set'));
    assert.deepEqual(writes, [
      { method: 'VideoLibrary.SetMovieDetails', params: { movieid: 6, tag: ['Favs', KIDS_TAG] } },
      { method: 'VideoLibrary.SetMovieDetails', params: { movieid: 7, tag: [] } },
      { method: 'VideoLibrary.SetMovieDetails', params: { movieid: 12, tag: [KIDS_TAG] } },
    ]);
    assert.deepEqual((calls.find((c) => c.method === 'VideoLibrary.GetMovies')?.params.properties), ['tag']);
  } finally {
    server.close();
  }
});
