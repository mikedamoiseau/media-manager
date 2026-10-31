import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { openDb, saveSettings } from '../server/db.ts';
import { Service } from '../server/service.ts';
import { createApi } from '../server/api.ts';
import { addProfile, PROFILE_COLORS } from '../server/profiles.ts';
import { setParentsCode } from '../server/kids.ts';
import { saveCatalog, storeGuide, guideChannels } from '../server/livetv.ts';
import { channelPlaylist, type M3uEntry } from '../server/iptv.ts';
import { standInKodi } from './standInKodi.ts';

const X = 'https://xmltvfr.fr/xmltv/xmltv.xml.gz';
const entry = (key: string, name: string, opts: string[] = []): M3uEntry => ({ key, name, logo: '', group: 'General', opts, url: `http://s/${key}.m3u8` });
const TF1 = entry('TF1.fr@SD', 'TF1');
const M6 = entry('M6.fr@HD', 'M6 HD', ['#EXTVLCOPT:http-user-agent=UA']);
const path = (key: string, rest = '') => `/api/livetv/${encodeURIComponent(key)}${rest}`;

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'live-api-'));
  const db = openDb(':memory:');
  saveSettings(db, { liveFile: join(tmp, 'missing-share', 'IPTV', 'channels.m3u'), liveGuides: [X] });
  const now = Date.now();
  saveCatalog(db, [{ list: 'fr', entries: [TF1, M6] }], now);
  storeGuide(db, X, [{ id: 'TF1.fr', name: 'TF1' }, { id: 'TMC.fr', name: 'TMC' }], [{ channel: 'TF1.fr', start: now - 600_000, stop: now + 600_000, title: 'Le 13h' }], now);
  const svc = new Service(db, join(tmp, 'data'));
  const app = new Hono().route('/api', createApi(svc));
  const json = (method: string, body: unknown, headers: Record<string, string> = {}) => ({ method, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
  return { db, svc, app, json };
}

/** The app over the stand-in Kodi as its one TV, TF1 and M6 picked, TF1 for kids, and a kids profile. */
async function withKid() {
  const s = setup();
  const kodi = await standInKodi();
  // The server goes even when the setup below fails: a test left with it open never ends.
  kodi.server.unref();
  saveSettings(s.db, { kodiTvs: [{ id: 'tv1', name: 'TV', host: '127.0.0.1', port: kodi.port, user: '', pass: '', pathPrefix: '' }] });
  s.svc.saveLivePicks(['M6.fr@HD', 'TF1.fr@SD']);
  s.svc.setLiveKids('TF1.fr@SD', true);
  setParentsCode(s.db, '4821');
  const kid = addProfile(s.db, { name: 'Kid', color: PROFILE_COLORS[2], kids: true });
  const as = (profile: number) => ({ headers: { 'x-profile': String(profile), 'x-kodi-tv': 'tv1' } });
  kodi.answers['XBMC.GetInfoBooleans'] = { 'Skin.HasSetting(KidsView)': false };
  kodi.answers['PVR.GetChannels'] = { channels: [{ channelid: 7, channel: 'TF1', channelnumber: 2 }, { channelid: 8, channel: 'M6 HD', channelnumber: 1 }] };
  return { ...s, kodi, kid: kid.id, as, [Symbol.dispose]: () => kodi.server.close() };
}

test("a kids profile sees and starts the kids channels only; the rest of live TV stays closed", async () => {
  using t = await withKid();
  const { app, kodi, kid, as } = t;
  const guide = (await (await app.request('/api/livetv/guide', as(kid))).json()) as { channels: Array<{ key: string }> };
  assert.deepEqual(guide.channels.map((c) => c.key), ['TF1.fr@SD']);
  assert.equal((await app.request(path('M6.fr@HD', '/play'), { method: 'POST', ...as(kid) })).status, 403);
  assert.equal((await app.request(path('TF1.fr@SD', '/play'), { method: 'POST', ...as(kid) })).status, 200);
  assert.deepEqual(kodi.opened(), [{ channelid: 7 }]);
  assert.equal((await app.request(path('M6.fr@HD', '/playing'), as(kid))).status, 403);
  for (const [method, url] of [['GET', '/api/livetv/catalog'], ['GET', path('TF1.fr@SD', '/vlc.m3u')], ['PUT', '/api/livetv/channels'], ['PUT', '/api/livetv/channels/TF1.fr%40SD/kids'], ['POST', '/api/livetv/refresh']] as const) {
    assert.equal((await app.request(url, { method, ...as(kid) })).status, 403, `${method} ${url}`);
  }
});

test('at bedtime a kids profile starts no channel', async () => {
  using t = await withKid();
  const { db, app, kodi, kid, as } = t;
  // Bedtime a minute ago, whatever the time now.
  const d = new Date(Date.now() - 60_000);
  db.prepare('UPDATE profiles SET bedtime = ? WHERE id = ?').run(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, kid);
  const r = await app.request(path('TF1.fr@SD', '/play'), { method: 'POST', ...as(kid) });
  assert.equal(r.status, 403);
  assert.equal(((await r.json()) as { code: string }).code, 'bedtime');
  assert.deepEqual(kodi.opened(), []);
});

test("what plays, for a kids profile: a kids channel with what's on, and its keys; another channel hidden", async () => {
  using t = await withKid();
  const { app, kodi, kid, as } = t;
  kodi.players.push({ playerid: 1, type: 'video' });
  kodi.answers['Application.GetProperties'] = { volume: 50, muted: false };
  kodi.answers['Player.GetProperties'] = { time: { hours: 0, minutes: 0, seconds: 0 }, totaltime: { hours: 0, minutes: 0, seconds: 0 }, speed: 1, subtitleenabled: false };
  kodi.answers['Player.GetItem'] = { item: { type: 'channel', id: 7, label: 'TF1', channel: 'TF1', title: 'Le 13h' } };
  const now = (await (await app.request('/api/kodi/now', as(kid))).json()) as { hidden?: boolean; live?: { key: string; programmes: Array<{ title: string }> } };
  assert.equal(now.hidden, undefined);
  assert.equal(now.live?.key, 'TF1.fr@SD');
  assert.deepEqual(now.live?.programmes.map((p) => p.title), ['Le 13h']);
  const stop = () => app.request('/api/kodi/remote', { method: 'POST', body: JSON.stringify({ action: 'stop' }), headers: { ...as(kid).headers, 'content-type': 'application/json' } });
  assert.equal((await stop()).status, 200);
  kodi.answers['Player.GetItem'] = { item: { type: 'channel', id: 8, label: 'M6 HD', channel: 'M6 HD' } };
  assert.deepEqual(await (await app.request('/api/kodi/now', as(kid))).json(), { active: true, hidden: true });
  assert.equal((await stop()).status, 403);
});

test("the owner's kids switch: on the TVs' list at once", async () => {
  const { svc, app, json } = setup();
  svc.saveLivePicks(['TF1.fr@SD']);
  const r = await app.request('/api/livetv/channels/TF1.fr%40SD/kids', json('PUT', { kids: true }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { file: 'not_mounted' });
  const cat = (await (await app.request('/api/livetv/catalog')).json()) as { rows: Array<{ key: string; kids: boolean }> };
  assert.equal(cat.rows.find((x) => x.key === 'TF1.fr@SD')!.kids, true);
  assert.equal((await app.request('/api/livetv/channels/TF1.fr%40SD/kids', json('PUT', { kids: 'yes' }))).status, 400);
  assert.equal((await app.request('/api/livetv/channels/M6.fr%40HD/kids', json('PUT', { kids: true }))).status, 400, 'not one of the owner\'s');
});

test('picking channels saves them even when the NAS is not mounted, and says so', async () => {
  const { app, json } = setup();
  const r = await app.request('/api/livetv/channels', json('PUT', { keys: ['TF1.fr@SD'] }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { file: 'not_mounted' });
  const cat = (await (await app.request('/api/livetv/catalog')).json()) as { rows: Array<{ key: string; position: number | null }>; file: string };
  assert.equal(cat.rows.find((x) => x.key === 'TF1.fr@SD')!.position, 1);
  assert.equal(cat.file, 'not_mounted');
  assert.equal((await app.request('/api/livetv/channels', json('PUT', { keys: ['nope'] }))).status, 400);
  assert.equal((await app.request('/api/livetv/channels', json('PUT', { keys: 'TF1.fr@SD' }))).status, 400);
});

test("the guide: the owner's channels in order, with what's on", async () => {
  const { svc, app } = setup();
  svc.saveLivePicks(['M6.fr@HD', 'TF1.fr@SD']);
  const g = (await (await app.request('/api/livetv/guide')).json()) as { channels: Array<{ key: string; number: number; programmes: Array<{ title: string }> }> };
  assert.deepEqual(g.channels.map((c) => [c.number, c.key]), [[1, 'M6.fr@HD'], [2, 'TF1.fr@SD']]);
  assert.deepEqual(g.channels[1]!.programmes.map((p) => p.title), ['Le 13h']);
});

test("VLC's one-channel playlist for a channel with headers", async () => {
  const { svc, app } = setup();
  svc.saveLivePicks(['M6.fr@HD']);
  const r = await app.request(path('M6.fr@HD', '/vlc.m3u'));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/x-mpegurl');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(await r.text(), channelPlaylist('M6 HD', M6));
  assert.equal((await app.request(path('TF1.fr@SD', '/vlc.m3u'))).status, 404, 'only a channel of the owner');
});

test('playing a channel that is not one of the owner channels', async () => {
  const { app } = setup();
  assert.equal((await app.request(path('nope', '/play'), { method: 'POST' })).status, 404);
});

test('a manual guide pick, and the guide channels to pick from', async () => {
  const { db, svc, app, json } = setup();
  svc.saveLivePicks(['TF1.fr@SD']);
  assert.deepEqual(guideChannels(db, [X]), [{ source: X, id: 'TF1.fr', name: 'TF1' }, { source: X, id: 'TMC.fr', name: 'TMC' }]);
  const list = (await (await app.request('/api/livetv/guide-channels')).json()) as { channels: unknown[] };
  assert.equal(list.channels.length, 2);
  const r = await app.request(`/api/livetv/channels/${encodeURIComponent('TF1.fr@SD')}/guide`, json('PUT', { guide: 'none' }));
  assert.equal(r.status, 200);
  const cat = (await (await app.request('/api/livetv/catalog')).json()) as { rows: Array<{ key: string; guide: { mode: string } }> };
  assert.equal(cat.rows.find((x) => x.key === 'TF1.fr@SD')!.guide.mode, 'none');
  assert.equal((await app.request(`/api/livetv/channels/${encodeURIComponent('TF1.fr@SD')}/guide`, json('PUT', { guide: { source: X } }))).status, 400);
  assert.equal((await app.request(`/api/livetv/channels/${encodeURIComponent('M6.fr@HD')}/guide`, json('PUT', { guide: 'none' }))).status, 400, 'not picked');
});

test('guide sources must be https addresses', async () => {
  const { svc, app, json } = setup();
  (svc as unknown as { refreshLiveGuides: () => Promise<void> }).refreshLiveGuides = async () => {};
  assert.equal((await app.request('/api/settings', json('PUT', { liveGuides: ['https://a/x.xml.gz'] }))).status, 200);
  assert.deepEqual(((await (await app.request('/api/settings')).json()) as { liveGuides: string[] }).liveGuides, ['https://a/x.xml.gz']);
  assert.equal((await app.request('/api/settings', json('PUT', { liveGuides: ['http://a', 'file:///etc'] }))).status, 400);
});

test('a manual guide pick must be a guide channel of a configured source, and fetches the guides', async () => {
  const { svc, app, json } = setup();
  svc.saveLivePicks(['TF1.fr@SD']);
  let refreshes = 0;
  (svc as unknown as { refreshLiveGuides: () => Promise<void> }).refreshLiveGuides = async () => void refreshes++;
  const url = `/api/livetv/channels/${encodeURIComponent('TF1.fr@SD')}/guide`;
  assert.equal((await app.request(url, json('PUT', { guide: { source: X, id: 'Nope.fr' } }))).status, 400);
  assert.equal((await app.request(url, json('PUT', { guide: { source: 'https://other/g.xml', id: 'TF1.fr' } }))).status, 400);
  assert.equal(refreshes, 0);
  assert.equal((await app.request(url, json('PUT', { guide: { source: X, id: 'TMC.fr' } }))).status, 200);
  assert.equal(refreshes, 1);
});

test('new guide sources are fetched at once', async () => {
  const { svc, app, json } = setup();
  let refreshes = 0;
  (svc as unknown as { refreshLiveGuides: () => Promise<void> }).refreshLiveGuides = async () => void refreshes++;
  await app.request('/api/settings', json('PUT', { liveGuides: [X] }));
  assert.equal(refreshes, 0, 'unchanged');
  await app.request('/api/settings', json('PUT', { liveGuides: [X, 'https://b/g.xml'] }));
  assert.equal(refreshes, 1);
});

test("a channel's own stream address: http(s) only, one of the owner's channels, written and checked", async () => {
  const { svc, app, json } = setup();
  svc.saveLivePicks(['M6.fr@HD']);
  const url = (key: string) => `/api/livetv/channels/${encodeURIComponent(key)}/stream`;
  assert.equal((await app.request(url('M6.fr@HD'), json('PUT', { url: 'ftp://x/m6' }))).status, 400);
  assert.equal((await app.request(url('M6.fr@HD'), json('PUT', { url: 42 }))).status, 400);
  assert.equal((await app.request(url('TF1.fr@SD'), json('PUT', { url: 'https://own/tf1.m3u8' }))).status, 400, 'not picked');
  // A local address nothing answers on: checked at once, without reaching out.
  const r = await app.request(url('M6.fr@HD'), json('PUT', { url: 'http://127.0.0.1:9/m6.m3u8' }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { file: 'not_mounted', ok: false });
  const vlc = await (await app.request(path('M6.fr@HD', '/vlc.m3u'))).text();
  assert.match(vlc, /http:\/\/127\.0\.0\.1:9\/m6\.m3u8/);
  assert.doesNotMatch(vlc, /EXTVLCOPT/);
  assert.equal((await app.request(url('M6.fr@HD'), json('PUT', { url: null }))).status, 200);
  assert.match(await (await app.request(path('M6.fr@HD', '/vlc.m3u'))).text(), /EXTVLCOPT/, "back to iptv-org's");
});

test("a channel's qualities for the TVs: fetched at its address, without the backup server's", async (t) => {
  const { svc, app } = setup();
  svc.saveLivePicks(['M6.fr@HD']);
  const master = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"', 'v/live.m3u8', '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a-backup"', 'https://b/v.m3u8', ''].join('\n');
  const asked: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    asked.push(`${String(url)} ${(init?.headers as Record<string, string> | undefined)?.['user-agent'] ?? ''}`);
    return String(url).includes('fails') ? new Response('', { status: 503 }) : new Response(master, { status: 200 });
  });
  const r = await app.request(path('M6.fr@HD', '/tv.m3u8'));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /mpegurl/);
  assert.equal(await r.text(), ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"', 'http://s/v/live.m3u8', ''].join('\n'));
  assert.deepEqual(asked, ['http://s/M6.fr@HD.m3u8 UA'], "asked with the channel's own headers");
  assert.equal((await app.request(path('TF1.fr@SD', '/tv.m3u8'))).status, 404, 'only a channel of the owner');
  svc.db.prepare("UPDATE live_channels SET url = 'http://fails/m6.m3u8' WHERE key = 'M6.fr@HD'").run();
  assert.equal((await app.request(path('M6.fr@HD', '/tv.m3u8'))).status, 502);
});

test("the TVs' list is written again when the TVs change, as the app's address in it may", (t) => {
  const { svc } = setup();
  t.mock.method(svc as unknown as { connectTvs(): void }, 'connectTvs', () => {});
  t.mock.method(svc, 'syncKodi', async () => {});
  const written = t.mock.method(svc, 'writeLiveFile');
  const tv = (host: string) => ({ id: 'tv1', name: 'TV', host, port: 8080, user: '', pass: '', pathPrefix: '' });
  svc.saveTvs([tv('192.168.1.20')]);
  assert.equal(written.mock.callCount(), 0, 'no channel picked yet: no file');
  svc.saveLivePicks(['M6.fr@HD']);
  const before = written.mock.callCount();
  svc.saveTvs([tv('192.168.1.21')]);
  assert.equal(written.mock.callCount(), before + 1);
  written.mock.mockImplementation(() => { throw new Error('EACCES'); });
  assert.doesNotThrow(() => svc.saveTvs([tv('192.168.1.22')]), 'a file that cannot be written stops nothing');
});

test("a channel's guide changed by hand changes Kodi's guide file", async () => {
  const { db, svc, app, json } = setup();
  const share = mkdtempSync(join(tmpdir(), 'share-'));
  saveSettings(db, { liveFile: join(share, 'IPTV', 'channels.m3u') });
  svc.saveLivePicks(['TF1.fr@SD']);
  const guide = () => readFileSync(join(share, 'IPTV', 'guide.xml'), 'utf8');
  assert.match(guide(), /<title>Le 13h<\/title>/);
  assert.equal((await app.request(`/api/livetv/channels/${encodeURIComponent('TF1.fr@SD')}/guide`, json('PUT', { guide: 'none' }))).status, 200);
  assert.doesNotMatch(guide(), /<programme/, 'no guide for it now');
  assert.equal((await app.request(`/api/livetv/channels/${encodeURIComponent('TF1.fr@SD')}/guide`, json('PUT', { guide: null }))).status, 200);
  assert.match(guide(), /<title>Le 13h<\/title>/, 'back to the one found for it');
});

test("the TVs' list tells Kodi where its guide is, as the TVs reach the NAS", () => {
  const { db, svc } = setup();
  const share = mkdtempSync(join(tmpdir(), 'share-'));
  const tv = (id: string) => ({ id, name: id, host: '127.0.0.1', port: 9, user: '', pass: '', pathPrefix: 'smb://nas/video/MEDIA' });
  saveSettings(db, { liveFile: join(share, 'IPTV', 'channels.m3u'), mediaRoot: join(share, 'MEDIA'), kodiTvs: [tv('tv1'), tv('tv2')] });
  svc.saveLivePicks(['TF1.fr@SD']);
  assert.equal(readFileSync(join(share, 'IPTV', 'channels.m3u'), 'utf8').split('\n')[0], '#EXTM3U x-tvg-url="smb://nas/video/IPTV/guide.xml"');
});

test("what plays: one of the owner's channels, with what's on and what's next; not for a kid", async () => {
  const { db, svc, app } = setup();
  const kodi = await standInKodi();
  try {
    saveSettings(db, { kodiTvs: [{ id: 'tv1', name: 'TV', host: '127.0.0.1', port: kodi.port, user: '', pass: '', pathPrefix: '' }] });
    const now = Date.now();
    storeGuide(db, X, [{ id: 'TF1.fr', name: 'TF1' }], [
      { channel: 'TF1.fr', start: now - 600_000, stop: now + 600_000, title: 'Le 13h' },
      { channel: 'TF1.fr', start: now + 600_000, stop: now + 3_600_000, title: 'Météo' },
      { channel: 'TF1.fr', start: now + 3_600_000, stop: now + 7_200_000, title: 'Later' },
    ], now);
    svc.saveLivePicks(['M6.fr@HD', 'TF1.fr@SD']);
    kodi.players.push({ playerid: 1, type: 'video' });
    kodi.answers['Application.GetProperties'] = { volume: 50, muted: false };
    kodi.answers['Player.GetProperties'] = { time: { hours: 0, minutes: 0, seconds: 0 }, totaltime: { hours: 0, minutes: 0, seconds: 0 }, speed: 1, subtitleenabled: false };
    kodi.answers['Player.GetItem'] = { item: { type: 'channel', id: 7, label: 'TF1', channel: 'TF1', title: 'Le 13h' } };
    const h = { headers: { 'x-kodi-tv': 'tv1' } };
    const np = (await (await app.request('/api/kodi/now', h)).json()) as { live?: { key: string; number: number; name: string; programmes: Array<{ title: string }> } };
    assert.deepEqual([np.live?.key, np.live?.number, np.live?.name], ['TF1.fr@SD', 2, 'TF1']);
    assert.deepEqual(np.live?.programmes.map((p) => p.title), ['Le 13h', 'Météo'], "what's on, then next");
    assert.ok(kodi.calls.some((c) => c.method === 'Player.GetItem' && (c.params.properties as string[]).includes('channel')));
    // A kid sees nothing of it.
    setParentsCode(db, '4821');
    const kid = addProfile(db, { name: 'Kid', color: PROFILE_COLORS[2], kids: true });
    assert.deepEqual(await (await app.request('/api/kodi/now', { headers: { ...h.headers, 'x-profile': String(kid.id) } })).json(), { active: true, hidden: true });
    // A channel not of the owner's, then a film: no live channel.
    kodi.answers['Player.GetItem'] = { item: { type: 'channel', id: 9, label: 'Other', channel: 'Other' } };
    assert.equal(((await (await app.request('/api/kodi/now', h)).json()) as { live?: unknown }).live, undefined);
    kodi.answers['Player.GetItem'] = { item: { type: 'movie', id: 3, label: 'TF1', title: 'TF1' } };
    assert.equal(((await (await app.request('/api/kodi/now', h)).json()) as { live?: unknown }).live, undefined);
  } finally {
    kodi.server.close();
  }
});

test("a TV's media path found by the app puts the guide's address in the TVs' list", async () => {
  const { db, svc } = setup();
  const kodi = await standInKodi();
  try {
    const share = mkdtempSync(join(tmpdir(), 'share-'));
    mkdirSync(join(share, 'MEDIA', 'MOVIES'), { recursive: true });
    saveSettings(db, { liveFile: join(share, 'IPTV', 'channels.m3u'), mediaRoot: join(share, 'MEDIA'), kodiTvs: [{ id: 'tv1', name: 'TV', host: '127.0.0.1', port: kodi.port, user: '', pass: '', pathPrefix: '' }] });
    svc.saveLivePicks(['TF1.fr@SD']);
    const first = () => readFileSync(join(share, 'IPTV', 'channels.m3u'), 'utf8').split('\n')[0];
    assert.equal(first(), '#EXTM3U', 'no TV path known yet: no guide named');
    kodi.answers['Files.GetSources'] = { sources: [{ file: 'smb://nas/video/MEDIA/MOVIES/' }] };
    assert.equal(await svc.findPathPrefix('tv1'), 'smb://nas/video/MEDIA');
    assert.equal(first(), '#EXTM3U x-tvg-url="smb://nas/video/IPTV/guide.xml"');
  } finally {
    kodi.server.close();
  }
});

test("a guide picked by hand reaches Kodi's guide file even while the guides are being read", async (t) => {
  const { db, svc, app, json } = setup();
  const share = mkdtempSync(join(tmpdir(), 'share-'));
  saveSettings(db, { liveFile: join(share, 'IPTV', 'channels.m3u') });
  const now = Date.now();
  storeGuide(db, X, [{ id: 'TF1.fr', name: 'TF1' }, { id: 'TMC.fr', name: 'TMC' }], [
    { channel: 'TF1.fr', start: now - 600_000, stop: now + 600_000, title: 'Le 13h' },
    { channel: 'TMC.fr', start: now - 600_000, stop: now + 600_000, title: 'Quotidien' },
  ], now);
  svc.saveLivePicks(['TF1.fr@SD']);
  // Another live TV task runs: reading the guides again waits for another day.
  t.mock.method(svc, 'refreshLiveGuides', async () => {});
  const r = await app.request(`/api/livetv/channels/${encodeURIComponent('TF1.fr@SD')}/guide`, json('PUT', { guide: { source: X, id: 'TMC.fr' } }));
  assert.equal(r.status, 200);
  assert.match(readFileSync(join(share, 'IPTV', 'guide.xml'), 'utf8'), /<title>Quotidien<\/title>/);
});
