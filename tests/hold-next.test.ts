import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, saveSettings } from '../server/db.ts';
import { Service } from '../server/service.ts';
import { MAIN_PROFILE, PROFILE_COLORS, addProfile } from '../server/profiles.ts';
import { setParentsCode } from '../server/kids.ts';
import { addToUpNext, clearUpNext, setSleep } from '../server/upnext.ts';
import { HOLD_NEXT, NEXT_LABEL, nextLabel } from '../server/holdNext.ts';
import { standInKodi } from './standInKodi.ts';

/** A TV played by the stand-in, a film and a series with two episodes in its library. */
async function setup() {
  const kodi = await standInKodi();
  Object.assign(kodi.answers, {
    'VideoLibrary.GetEpisodeDetails': { episodedetails: { episodeid: 102, showtitle: 'The Show', season: 1, episode: 2, title: 'The Return' } },
    'VideoLibrary.GetMovieDetails': { moviedetails: { movieid: 12, title: 'Bee' } },
  });
  const db = openDb(':memory:');
  saveSettings(db, { kodiTvs: [{ id: 'tv1', name: 'Living room', host: '127.0.0.1', port: kodi.port, user: '', pass: '', pathPrefix: 'smb://nas/MEDIA' }] });
  const film = Number(db.prepare(`INSERT INTO items (path, folder, category, is_dir, match_state, present, kodi_id, kodi_type, added_at, updated_at)
    VALUES ('MOVIES/B.mkv', 'MOVIES', 'movies', 0, 'unmatched', 1, 12, 'movie', 1, 1)`).run().lastInsertRowid);
  const show = Number(db.prepare(`INSERT INTO items (path, folder, category, is_dir, match_state, present, added_at, updated_at)
    VALUES ('SERIES/Show', 'SERIES', 'series', 1, 'unmatched', 1, 1, 1)`).run().lastInsertRowid);
  const ep = db.prepare("INSERT INTO episodes (item_id, path, season, episode, title, kodi_id) VALUES (?, ?, 1, ?, 'Pilot', ?)");
  const eps = [1, 2].map((n) => Number(ep.run(show, `SERIES/Show/S01E0${n}.mkv`, n, 100 + n).lastInsertRowid));
  const svc = new Service(db, mkdtempSync(join(tmpdir(), 'data-')));
  svc.kodiConnected('tv1');
  /** What the TV's skin was told, in order. */
  const told = () => kodi.calls.filter((c) => c.method === 'Settings.SetSkinSettingValue').map((c) => c.params);
  return { kodi, db, svc, film, show, eps, told, [Symbol.dispose]: () => kodi.server.close() };
}

const holds = (label: string) => [
  { setting: HOLD_NEXT, value: true },
  { setting: NEXT_LABEL, value: label },
];
const free = [
  { setting: HOLD_NEXT, value: false },
  { setting: NEXT_LABEL, value: '' },
];

test("the label: the series, the episode's number and title; a film's title", () => {
  assert.equal(nextLabel({ show: 'The Show', season: 2, episode: 6, title: 'The Return' }), 'Next: The Show, S2 E6 · The Return');
  assert.equal(nextLabel({ show: 'The Show', season: null, episode: 6, title: null }), 'Next: The Show, E6');
  assert.equal(nextLabel({ show: 'The Show', season: null, episode: null, title: 'Special' }), 'Next: The Show · Special');
  assert.equal(nextLabel({ film: 'Bee' }), 'Next: Bee');
});

test('Up next has an entry: the TV leaves what plays next to the app, and shows it as Kodi names it', async () => {
  using s = await setup();
  addToUpNext(s.db, 'tv1', MAIN_PROFILE, s.show, s.eps[1]!, Date.now());
  s.svc.upNextChanged();
  await s.svc.syncHoldNext();
  assert.deepEqual(s.told(), holds('Next: The Show, S1 E2 · The Return'));
  assert.deepEqual(s.kodi.calls.find((c) => c.method === 'VideoLibrary.GetEpisodeDetails')?.params, {
    episodeid: 102,
    properties: ['showtitle', 'season', 'episode', 'title'],
  });
});

test('a film in Up next is named as Kodi has it', async () => {
  using s = await setup();
  addToUpNext(s.db, 'tv1', MAIN_PROFILE, s.film, null, Date.now());
  await s.svc.syncHoldNext();
  assert.deepEqual(s.told(), holds('Next: Bee'));
});

test("Kodi can't name it: the app's own names", async () => {
  using s = await setup();
  s.kodi.invalid.add('VideoLibrary.GetEpisodeDetails');
  matchSeries(s.db, s.show, 'The Show (app)');
  addToUpNext(s.db, 'tv1', MAIN_PROFILE, s.show, s.eps[0]!, Date.now());
  await s.svc.syncHoldNext();
  assert.deepEqual(s.told(), holds('Next: The Show (app), S1 E1 · Pilot'));
});

/** The series matched on TMDB, with its English title. */
function matchSeries(db: ReturnType<typeof openDb>, itemId: number, title: string) {
  db.prepare("INSERT INTO titles (media_type, tmdb_id, title_en, source, fetched_at) VALUES ('tv', 7, ?, 'tmdb', 1)").run(title);
  db.prepare("UPDATE items SET media_type = 'tv', tmdb_id = 7, match_state = 'matched' WHERE id = ?").run(itemId);
}

test('the list emptied: the TV goes on by itself again', async () => {
  using s = await setup();
  addToUpNext(s.db, 'tv1', MAIN_PROFILE, s.film, null, Date.now());
  await s.svc.syncHoldNext();
  clearUpNext(s.db, 'tv1');
  s.svc.upNextChanged();
  await s.svc.syncHoldNext();
  assert.deepEqual(s.told(), [...holds('Next: Bee'), ...free]);
});

test('"stop after this" leaves it to the app; a timer in minutes does not', async () => {
  using s = await setup();
  setSleep(s.db, 'tv1', { minutes: 45 }, Date.now());
  await s.svc.syncHoldNext();
  assert.deepEqual(s.told(), free);
  setSleep(s.db, 'tv1', { afterThis: true }, Date.now());
  await s.svc.syncHoldNext();
  assert.deepEqual(s.told(), [...free, ...holds('')]);
});

test("a kid's bedtime on a TV in the kids view leaves it to the app; before bedtime, the TV goes on", async () => {
  using s = await setup();
  setParentsCode(s.db, '1234');
  addProfile(s.db, { name: 'Kid', color: PROFILE_COLORS[2], kids: true, bedtime: '20:00' });
  s.kodi.answers['XBMC.GetInfoBooleans'] = { 'Skin.HasSetting(CinemathequeKids)': true };
  await s.svc.checkSleep(new Date(2026, 9, 30, 19, 30).getTime());
  assert.deepEqual(s.told(), free);
  await s.svc.checkSleep(new Date(2026, 9, 30, 20, 30).getTime());
  assert.deepEqual(s.told(), [...free, ...holds('')]);
});

test("bedtime on a TV that isn't in the kids view: the TV goes on", async () => {
  using s = await setup();
  setParentsCode(s.db, '1234');
  addProfile(s.db, { name: 'Kid', color: PROFILE_COLORS[2], kids: true, bedtime: '20:00' });
  s.kodi.answers['XBMC.GetInfoBooleans'] = { 'Skin.HasSetting(CinemathequeKids)': false };
  await s.svc.checkSleep(new Date(2026, 9, 30, 20, 30).getTime());
  assert.deepEqual(s.told(), free);
});

test("a TV that isn't connected is told nothing until it connects", async () => {
  using s = await setup();
  const db = s.db;
  saveSettings(db, { kodiTvs: [...s.svc.tvs(), { id: 'tv2', name: 'Bedroom', host: '127.0.0.1', port: s.kodi.port, user: '', pass: '', pathPrefix: '' }] });
  addToUpNext(db, 'tv2', MAIN_PROFILE, s.film, null, Date.now());
  await s.svc.syncHoldNext();
  assert.deepEqual(s.told(), free, 'only the connected one');
  s.svc.kodiConnected('tv2');
  await s.svc.syncHoldNext();
  assert.deepEqual(s.told(), [...free, ...holds('Next: Bee')]);
});

test('told once; a TV that connects again is told again (Kodi may have lost it)', async () => {
  using s = await setup();
  addToUpNext(s.db, 'tv1', MAIN_PROFILE, s.film, null, Date.now());
  await s.svc.syncHoldNext();
  await s.svc.syncHoldNext();
  assert.equal(s.told().length, 2);
  s.svc.kodiConnected('tv1');
  await s.svc.syncHoldNext();
  assert.deepEqual(s.told(), [...holds('Next: Bee'), ...holds('Next: Bee')]);
});

test("a call that didn't get through is made again at the next look, though nothing changed", async () => {
  using s = await setup();
  const warn = mock.method(console, 'warn', () => {});
  try {
    s.kodi.down.now = true;
    await s.svc.syncHoldNext();
    s.kodi.down.now = false;
    await s.svc.syncHoldNext();
    assert.deepEqual(s.told(), free);
    assert.equal(warn.mock.callCount(), 1);
  } finally {
    warn.mock.restore();
  }
});

test("a skin without the settings refuses: noted once, tried again when there's news", async () => {
  using s = await setup();
  const warn = mock.method(console, 'warn', () => {});
  try {
    s.kodi.invalid.add('Settings.SetSkinSettingValue');
    await s.svc.syncHoldNext();
    await s.svc.syncHoldNext();
    assert.equal(s.told().length, 1, 'no label after the refusal, and no second try');
    assert.equal(warn.mock.callCount(), 1);
    addToUpNext(s.db, 'tv1', MAIN_PROFILE, s.film, null, Date.now());
    await s.svc.syncHoldNext();
    assert.equal(s.told().length, 2);
    assert.equal(warn.mock.callCount(), 1, 'the same refusal is noted once');
  } finally {
    warn.mock.restore();
  }
});
