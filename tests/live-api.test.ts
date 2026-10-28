import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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

test('kids mode reaches no live TV route', async () => {
  const { db, app } = setup();
  setParentsCode(db, '4821');
  const kid = addProfile(db, { name: 'Kid', color: PROFILE_COLORS[2], kids: true });
  const h = { headers: { 'x-profile': String(kid.id) } };
  for (const [method, url] of [['GET', '/api/livetv/guide'], ['GET', '/api/livetv/catalog'], ['POST', path('TF1.fr@SD', '/play')], ['GET', path('M6.fr@HD', '/vlc.m3u')], ['PUT', '/api/livetv/channels']] as const) {
    const r = await app.request(url, { method, ...h });
    assert.equal(r.status, 403, `${method} ${url}`);
  }
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
