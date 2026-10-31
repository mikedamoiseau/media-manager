import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getSettings } from '../server/db.ts';
import type { M3uEntry } from '../server/iptv.ts';
import type { Programme } from '../server/epg.ts';
import {
  LiveError, saveCatalog, setPicks, setGuidePick, setStream, pickedChannels, channelFileText, storeGuide, liveGuide, liveCatalog, guideOf, addressToward, appAddress,
  kodiPath, guideAddress, guideFileText, setKids, setLogo, setPlayer,
} from '../server/livetv.ts';
import { EXTRA_CHANNELS } from '../server/extraChannels.ts';
import { guideCandidates } from '../server/epg.ts';

const X = 'https://xmltvfr.fr/xmltv/xmltv.xml.gz';
const entry = (key: string, name: string, more: Partial<M3uEntry> = {}): M3uEntry => ({ key, name, logo: `https://logo/${name}.png`, group: 'General', opts: [], url: `http://s/${key}.m3u8`, ...more });
const TF1 = entry('TF1.fr@SD', 'TF1');
const M6 = entry('M6.fr@HD', 'M6 HD', { opts: ['#EXTVLCOPT:http-user-agent=UA'] });
const LCI = entry('LCI.fr@SD', 'LCI');
const LCI_HD = entry('LCI.fr@HD', 'LCI');
const BX1 = entry('BX1.be@SD', 'BX1');
const at = (h: number, m = 0) => Date.UTC(2026, 9, 28, h, m);

function catalog() {
  const db = openDb(':memory:');
  saveCatalog(db, [{ list: 'fr', entries: [TF1, M6, LCI, LCI_HD] }, { list: 'be', entries: [{ ...LCI, url: 'http://be/lci.m3u8' }, BX1] }], at(1));
  return db;
}

test('the settings for live TV have their defaults', () => {
  const s = getSettings(openDb(':memory:'));
  assert.equal(s.liveFile, '/Volumes/video/IPTV/channels.m3u');
  assert.deepEqual(s.liveGuides, [X, 'https://i.mjh.nz/PlutoTV/fr.xml.gz', 'https://i.mjh.nz/SamsungTVPlus/fr.xml.gz']);
  assert.equal(s.liveRefreshedAt, 0);
});

test('the catalog: the first list wins a channel both have', () => {
  const db = catalog();
  const rows = liveCatalog(db, [X]);
  assert.deepEqual(rows.map((r) => r.key).sort(), ['BX1.be@SD', 'LCI.fr@HD', 'LCI.fr@SD', 'M6.fr@HD', 'TF1.fr@SD']);
  const lci = rows.find((r) => r.key === 'LCI.fr@SD')!;
  assert.equal(lci.list, 'fr');
  assert.equal(pickedChannels((setPicks(db, ['LCI.fr@SD']), db))[0]!.entry.url, 'http://s/LCI.fr@SD.m3u8');
});

test('a channel iptv-org drops stays, marked as no longer listed, and is still written', () => {
  const db = catalog();
  setPicks(db, ['TF1.fr@SD', 'M6.fr@HD']);
  saveCatalog(db, [{ list: 'fr', entries: [M6, LCI, LCI_HD] }, { list: 'be', entries: [BX1] }], at(2));
  const rows = liveCatalog(db, [X]);
  assert.equal(rows.find((r) => r.key === 'TF1.fr@SD')!.listed, false);
  assert.equal(rows.find((r) => r.key === 'M6.fr@HD')!.listed, true);
  assert.equal(rows.find((r) => r.key === 'BX1.be@SD')!.listed, true);
  assert.match(channelFileText(db), /tvg-id="TF1.fr@SD" tvg-chno="1"/);
});

test('a list refreshed with no channel: none of its channels is listed any more', () => {
  const db = catalog();
  saveCatalog(db, [{ list: 'fr', entries: [] }, { list: 'be', entries: [BX1] }], at(2));
  const rows = liveCatalog(db, [X]);
  assert.deepEqual(rows.filter((r) => r.listed).map((r) => r.key), ['BX1.be@SD']);
});

test('the picks: in order, numbered, checked', () => {
  const db = catalog();
  setPicks(db, ['M6.fr@HD', 'TF1.fr@SD']);
  assert.deepEqual(pickedChannels(db).map((c) => [c.number, c.name, c.entry.key]), [[1, 'M6 HD', 'M6.fr@HD'], [2, 'TF1', 'TF1.fr@SD']]);
  assert.throws(() => setPicks(db, ['nope']), LiveError);
  assert.throws(() => setPicks(db, ['TF1.fr@SD', 'TF1.fr@SD']), LiveError);
  assert.equal(pickedChannels(db).length, 2, 'a refused change changes nothing');
  setPicks(db, ['TF1.fr@SD']);
  assert.deepEqual(pickedChannels(db).map((c) => c.entry.key), ['TF1.fr@SD']);
  assert.equal(liveCatalog(db, [X]).find((r) => r.key === 'TF1.fr@SD')!.position, 1);
  assert.equal(liveCatalog(db, [X]).find((r) => r.key === 'M6.fr@HD')!.position, null);
});

test('two channels with the same name are written under different names', () => {
  const db = catalog();
  setPicks(db, ['LCI.fr@SD', 'LCI.fr@HD']);
  assert.deepEqual(pickedChannels(db).map((c) => c.name), ['LCI', 'LCI 2']);
  assert.match(channelFileText(db), /tvg-chno="2" tvg-name="LCI 2"/);
});

const prog = (channel: string, start: number, stop: number, title: string): Programme => ({ channel, start, stop, title });

test('the guide: programmes in the window, by channel in the owner order', () => {
  const db = catalog();
  setPicks(db, ['TF1.fr@SD', 'M6.fr@HD', 'BX1.be@SD']);
  storeGuide(db, X, [{ id: 'TF1.fr', name: 'TF1' }, { id: 'M6.fr', name: 'M6' }], [
    prog('TF1.fr', at(11), at(12), 'B'),
    prog('TF1.fr', at(10), at(11), 'A'),
    prog('TF1.fr', at(14) - 30 * 3600_000, at(14) - 30 * 3600_000 + 1800_000, 'Old'),
    prog('M6.fr', at(9), at(10), 'Before'),
  ], at(14));
  const g = liveGuide(db, [X], at(10, 30), at(11, 30));
  assert.deepEqual(g.map((c) => [c.number, c.name, c.vlc]), [[1, 'TF1', 'direct'], [2, 'M6 HD', 'playlist'], [3, 'BX1', 'direct']]);
  assert.deepEqual(g[0]!.programmes, [{ start: at(10), stop: at(11), title: 'A' }, { start: at(11), stop: at(12), title: 'B' }]);
  assert.deepEqual(g[1]!.programmes, [], 'nothing of M6 in the window');
  assert.deepEqual(g[2]!.programmes, [], 'no guide');
  assert.equal(g[0]!.logo, 'https://logo/TF1.png');
  assert.equal(g[0]!.url, 'http://s/TF1.fr@SD.m3u8');
  const all = liveGuide(db, [X], 0, at(23));
  assert.ok(!all[0]!.programmes.some((p) => p.title === 'Old'), 'ended over a day before: dropped');
});

test('a source stored again replaces what it had', () => {
  const db = catalog();
  setPicks(db, ['TF1.fr@SD']);
  storeGuide(db, X, [{ id: 'TF1.fr', name: 'TF1' }], [prog('TF1.fr', at(10), at(11), 'A'), prog('TF1.fr', at(11), at(12), 'B')], at(9));
  storeGuide(db, X, [{ id: 'TF1.fr', name: 'TF1' }], [prog('TF1.fr', at(10), at(11), 'A2')], at(9));
  assert.deepEqual(liveGuide(db, [X], 0, at(23))[0]!.programmes.map((p) => p.title), ['A2']);
});

test("the owner's guide pick: none, back to automatic, or another guide channel", () => {
  const db = catalog();
  setPicks(db, ['TF1.fr@SD']);
  storeGuide(db, X, [{ id: 'TF1.fr', name: 'TF1' }, { id: 'TMC.fr', name: 'TMC' }], [prog('TF1.fr', at(10), at(11), 'A'), prog('TMC.fr', at(10), at(11), 'T')], at(9));
  assert.deepEqual(liveCatalog(db, [X]).find((r) => r.key === 'TF1.fr@SD')!.guide, { mode: 'auto', source: X, id: 'TF1.fr', name: 'TF1' });
  setGuidePick(db, 'TF1.fr@SD', 'none');
  assert.deepEqual(liveGuide(db, [X], 0, at(23))[0]!.programmes, []);
  assert.deepEqual(liveCatalog(db, [X]).find((r) => r.key === 'TF1.fr@SD')!.guide, { mode: 'none' });
  setGuidePick(db, 'TF1.fr@SD', { source: X, id: 'TMC.fr' });
  assert.deepEqual(guideOf(db, 'TF1.fr@SD', [X]), { source: X, id: 'TMC.fr', name: 'TMC' });
  assert.deepEqual(liveCatalog(db, [X]).find((r) => r.key === 'TF1.fr@SD')!.guide, { mode: 'manual', source: X, id: 'TMC.fr', name: 'TMC' });
  assert.deepEqual(liveGuide(db, [X], 0, at(23))[0]!.programmes.map((p) => p.title), ['T']);
  setGuidePick(db, 'TF1.fr@SD', null);
  assert.equal(liveCatalog(db, [X]).find((r) => r.key === 'TF1.fr@SD')!.guide.mode, 'auto');
  assert.throws(() => setGuidePick(db, 'BX1.be@SD', 'none'), LiveError, 'only a picked channel');
});

// ---------- refresh, stream checks, the file on the NAS ----------

import { mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { writeChannelFile, streamAnswers, refreshCatalog, refreshGuides, checkStreams, LIVE_LISTS } from '../server/livetv.ts';

/** A fetch that answers from a table: a Response, or a function of the request. */
function fakeFetch(table: Record<string, Response | ((init?: RequestInit) => Response | Promise<Response>)>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const r = table[url];
    if (!r) return new Response('not here', { status: 404 });
    return typeof r === 'function' ? r(init) : r.clone();
  }) as typeof fetch;
  return { fn, calls };
}

test('the file on the NAS: never written when the share is not mounted', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'live-'));
  assert.equal(writeChannelFile(join(tmp, 'missing-share', 'IPTV', 'channels.m3u'), 'x'), 'not_mounted');
  assert.equal(existsSync(join(tmp, 'missing-share')), false);
});

test('the file on the NAS: its folder with .nomedia, written whole, not again when unchanged', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'live-'));
  mkdirSync(join(tmp, 'share'));
  const file = join(tmp, 'share', 'IPTV', 'channels.m3u');
  assert.equal(writeChannelFile(file, '#EXTM3U\none\n'), 'written');
  assert.equal(readFileSync(join(tmp, 'share', 'IPTV', '.nomedia'), 'utf8'), '');
  assert.equal(readFileSync(file, 'utf8'), '#EXTM3U\none\n');
  assert.deepEqual(readdirSync(join(tmp, 'share', 'IPTV')).sort(), ['.nomedia', 'channels.m3u'], 'no temporary file left');
  assert.equal(writeChannelFile(file, '#EXTM3U\none\n'), 'same');
  assert.equal(writeChannelFile(file, '#EXTM3U\ntwo\n'), 'written');
  assert.equal(readFileSync(file, 'utf8'), '#EXTM3U\ntwo\n');
});

test('a stream answers: an HLS playlist or a raw stream, with the channel headers', async () => {
  const e = (url: string, opts: string[] = []) => ({ key: 'K', name: 'K', logo: '', group: '', opts, url });
  const { fn, calls } = fakeFetch({
    'http://hls': new Response('#EXTM3U\n#EXT-X-VERSION:3\n', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } }),
    'http://ts': new Response(new Uint8Array(9000), { headers: { 'content-type': 'application/octet-stream' } }),
    'http://html': new Response('<html>blocked</html>', { headers: { 'content-type': 'text/html' } }),
    'http://403': new Response('no', { status: 403 }),
    'http://never': () => new Promise<Response>(() => {}),
  });
  assert.equal(await streamAnswers(e('http://hls', ['#EXTVLCOPT:http-user-agent=UA/1', '#EXTVLCOPT:http-referrer=https://r/']), fn), true);
  assert.equal(new Headers(calls[0]!.init?.headers).get('user-agent'), 'UA/1');
  assert.equal(new Headers(calls[0]!.init?.headers).get('referer'), 'https://r/');
  assert.equal(await streamAnswers(e('http://ts'), fn), true, "France 3's raw MPEG-TS");
  assert.equal(await streamAnswers(e('http://html'), fn), false);
  assert.equal(await streamAnswers(e('http://403'), fn), false);
  const t = Date.now();
  assert.equal(await streamAnswers(e('http://never'), fn, 50), false);
  assert.ok(Date.now() - t < 1000, 'gives up at its timeout');
});

const M3U = (...lines: string[]) => ['#EXTM3U', ...lines].join('\n');

test('a list that fails to download leaves its channels as they were', async () => {
  const db = catalog();
  const { fn } = fakeFetch({
    [LIVE_LISTS[0]!.url]: new Response('down', { status: 500 }),
    [LIVE_LISTS[1]!.url]: new Response(M3U('#EXTINF:-1 tvg-id="BX1.be@SD" tvg-logo="" group-title="General",BX1 (720p)', 'http://new/bx1.m3u8', '#EXTINF:-1 tvg-id="LCI.fr@SD" tvg-logo="" group-title="News",LCI', 'http://be/lci2.m3u8')),
  });
  const res = await refreshCatalog(db, fn, at(5));
  assert.ok(res.find((r) => r.list === 'fr')!.error);
  setPicks(db, ['TF1.fr@SD', 'LCI.fr@SD', 'BX1.be@SD']);
  const picked = pickedChannels(db);
  assert.equal(picked[0]!.entry.url, 'http://s/TF1.fr@SD.m3u8', 'fr rows untouched');
  assert.equal(picked[2]!.entry.url, 'http://new/bx1.m3u8', 'be rows updated');
  assert.equal(picked[1]!.entry.url, 'http://s/LCI.fr@SD.m3u8', 'still the first list’s channel');
  assert.equal(liveCatalog(db, [X]).find((r) => r.key === 'TF1.fr@SD')!.listed, true, 'a failed list says nothing about its channels');
});

test('a list that downloads empty counts as failed', async () => {
  const db = catalog();
  const { fn } = fakeFetch({ [LIVE_LISTS[0]!.url]: new Response('#EXTM3U\n'), [LIVE_LISTS[1]!.url]: new Response('') });
  const res = await refreshCatalog(db, fn, at(5));
  assert.ok(res.every((r) => r.error));
  assert.equal(liveCatalog(db, [X]).filter((r) => r.listed && r.list !== 'extra').length, 5);
});

const GUIDE = `<?xml version="1.0"?><tv>
<channel id="TF1.fr"><display-name>TF1</display-name></channel>
<channel id="Nobody.fr"><display-name>Nobody</display-name></channel>
<programme start="20261028120000 +0100" stop="20261028124500 +0100" channel="TF1.fr"><title>Le 13h</title></programme>
<programme start="20261028120000 +0100" stop="20261028124500 +0100" channel="Nobody.fr"><title>Unseen</title></programme>
</tv>`;

test('guides: gzipped or not, only the channels in use, a source that fails keeps what it had', async () => {
  const db = catalog();
  setPicks(db, ['TF1.fr@SD']);
  const B = 'https://b/guide.xml';
  storeGuide(db, B, [{ id: 'TF1.fr', name: 'TF1' }], [prog('TF1.fr', at(9), at(10), 'Kept')], at(8));
  const { fn } = fakeFetch({ [X]: new Response(gzipSync(GUIDE)), [B]: new Response('down', { status: 500 }) });
  const res = await refreshGuides(db, [X, B], fn, at(10));
  assert.deepEqual(res.map((r) => [r.source, !!r.error]), [[X, false], [B, true]]);
  assert.deepEqual(liveGuide(db, [X], 0, at(23))[0]!.programmes.map((p) => p.title), ['Le 13h']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM epg_programmes WHERE channel = 'Nobody.fr'").get()!.n, 0, 'no channel uses it');
  assert.deepEqual(liveGuide(db, [B], 0, at(23))[0]!.programmes.map((p) => p.title), ['Kept']);
  assert.deepEqual(liveCatalog(db, [X]).find((r) => r.key === 'BX1.be@SD')!.guide, { mode: 'auto' });

  const html = fakeFetch({ [X]: new Response('<html>maintenance</html>', { headers: { 'content-type': 'text/html' } }) });
  const again = await refreshGuides(db, [X], html.fn, at(11));
  assert.ok(again[0]!.error, 'not a guide');
  assert.deepEqual(liveGuide(db, [X], 0, at(23))[0]!.programmes.map((p) => p.title), ['Le 13h'], 'kept');
});

test('stream checks are noted per channel', async () => {
  const db = catalog();
  const { fn } = fakeFetch({ 'http://s/TF1.fr@SD.m3u8': new Response('#EXTM3U\n'), 'http://s/M6.fr@HD.m3u8': new Response('no', { status: 403 }) });
  await checkStreams(db, ['TF1.fr@SD', 'M6.fr@HD'], fn, at(3));
  const rows = liveCatalog(db, [X]);
  assert.equal(rows.find((r) => r.key === 'TF1.fr@SD')!.ok, true);
  assert.equal(rows.find((r) => r.key === 'M6.fr@HD')!.ok, false);
  assert.equal(rows.find((r) => r.key === 'BX1.be@SD')!.ok, null);
});

import { Service } from '../server/service.ts';
import { saveSettings } from '../server/db.ts';

test("the daily refresh leaves the NAS file alone until the owner has picked channels", async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'live-'));
  mkdirSync(join(tmp, 'share', 'IPTV'), { recursive: true });
  const file = join(tmp, 'share', 'IPTV', 'channels.m3u');
  writeFileSync(file, '#EXTM3U\n#EXTINF:-1,Starter\nhttp://starter\n');
  const db = openDb(':memory:');
  saveSettings(db, { liveFile: file, liveGuides: [X] });
  const svc = new Service(db, join(tmp, 'data'));
  const lists = M3U('#EXTINF:-1 tvg-id="TF1.fr@SD" tvg-logo="" group-title="General",TF1', 'http://s/tf1.m3u8');
  const { fn } = fakeFetch({ [LIVE_LISTS[0]!.url]: new Response(lists), [LIVE_LISTS[1]!.url]: new Response(M3U('#EXTINF:-1 tvg-id="BX1.be@SD",BX1', 'http://s/bx1')), [X]: new Response(GUIDE) });
  await svc.refreshLiveNow(fn);
  assert.equal(readFileSync(file, 'utf8'), '#EXTM3U\n#EXTINF:-1,Starter\nhttp://starter\n', 'no picks yet: the list the TVs use stays');
  assert.equal(svc.saveLivePicks(['TF1.fr@SD']), 'written');
  assert.match(readFileSync(file, 'utf8'), /tvg-name="TF1"/);
  assert.ok(getSettings(db).liveRefreshedAt > 0);
});

test("Kodi's guide sits next to the list: written with the owner's channels, again once the guides are read", async (t) => {
  mock.timers.enable({ apis: ['Date'], now: at(11) });
  try {
    const tmp = mkdtempSync(join(tmpdir(), 'live-'));
    mkdirSync(join(tmp, 'share'));
    const db = openDb(':memory:');
    saveSettings(db, { liveFile: join(tmp, 'share', 'IPTV', 'channels.m3u'), liveGuides: [X] });
    saveCatalog(db, [{ list: 'fr', entries: [TF1] }], at(1));
    const svc = new Service(db, join(tmp, 'data'));
    const guide = join(tmp, 'share', 'IPTV', 'guide.xml');
    svc.saveLivePicks(['TF1.fr@SD']);
    assert.match(readFileSync(guide, 'utf8'), /<channel id="TF1.fr@SD"><display-name>TF1<\/display-name>/);
    assert.doesNotMatch(readFileSync(guide, 'utf8'), /<programme/, 'no guide read yet');
    const { fn } = fakeFetch({
      [LIVE_LISTS[0]!.url]: new Response(M3U('#EXTINF:-1 tvg-id="TF1.fr@SD" group-title="General",TF1', 'http://s/TF1.fr@SD.m3u8')),
      [LIVE_LISTS[1]!.url]: new Response(M3U('#EXTINF:-1 tvg-id="BX1.be@SD",BX1', 'http://s/bx1')),
      [X]: new Response(GUIDE),
    });
    await svc.refreshLiveNow(fn);
    assert.match(readFileSync(guide, 'utf8'), /channel="TF1.fr@SD"><title>Le 13h<\/title>/);
    // The guides alone (a guide channel picked by hand) write it too.
    storeGuide(db, X, [{ id: 'TF1.fr', name: 'TF1' }], [], at(11));
    t.mock.method(globalThis, 'fetch', fakeFetch({ [X]: new Response(GUIDE.replace('Le 13h', 'Le 13h, en direct')) }).fn);
    await svc.refreshLiveGuides();
    assert.match(readFileSync(guide, 'utf8'), /<title>Le 13h, en direct<\/title>/);
  } finally {
    mock.timers.reset();
  }
});

test('a stream that answers with nothing or a text error does not count', async () => {
  const e = (url: string) => ({ key: 'K', name: 'K', logo: '', group: '', opts: [], url });
  const { fn } = fakeFetch({
    'http://empty': new Response('', { headers: { 'content-type': 'application/octet-stream' } }),
    'http://text': new Response('Stream offline', { headers: { 'content-type': 'text/plain' } }),
    'http://ts-untyped': new Response(new Uint8Array([0x47, 0x40, 0x11, 0x10, ...new Array(400).fill(0)])),
  });
  assert.equal(await streamAnswers(e('http://empty'), fn), false);
  assert.equal(await streamAnswers(e('http://text'), fn), false);
  assert.equal(await streamAnswers(e('http://ts-untyped'), fn), true, 'MPEG-TS sync byte');
});

test('a guide that lists a channel after programmes still keeps its programmes', async () => {
  const db = catalog();
  setPicks(db, ['TF1.fr@SD', 'M6.fr@HD']);
  const xml = `<tv><channel id="TF1.fr"><display-name>TF1</display-name></channel>
<programme start="20261028120000 +0100" stop="20261028124500 +0100" channel="TF1.fr"><title>Le 13h</title></programme>
<channel id="M6.fr"><display-name>M6</display-name></channel>
<programme start="20261028124500 +0100" stop="20261028131000 +0100" channel="M6.fr"><title>Le 12.45</title></programme></tv>`;
  const { fn } = fakeFetch({ [X]: new Response(xml) });
  await refreshGuides(db, [X], fn, at(10));
  assert.deepEqual(liveGuide(db, [X], 0, at(23)).map((c) => c.programmes.map((p) => p.title)), [['Le 13h'], ['Le 12.45']]);
});

test('a gzipped guide whose first chunk is a single byte is still unpacked', async () => {
  const db = catalog();
  setPicks(db, ['TF1.fr@SD']);
  const gz = gzipSync(GUIDE);
  // Chunks on separate ticks, as the network delivers them: the first holds one byte.
  const parts = [gz.subarray(0, 1), gz.subarray(1, 5), gz.subarray(5)];
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      await new Promise((r) => setTimeout(r, 5));
      const p = parts.shift();
      if (p) c.enqueue(p);
      else c.close();
    },
  });
  const { fn } = fakeFetch({ [X]: () => new Response(body) });
  const res = await refreshGuides(db, [X], fn, at(10));
  assert.equal(res[0]!.error, undefined);
  assert.deepEqual(liveGuide(db, [X], 0, at(23))[0]!.programmes.map((p) => p.title), ['Le 13h']);
});

test('a guide cut off before its end keeps what the source had', async () => {
  const db = catalog();
  setPicks(db, ['TF1.fr@SD']);
  storeGuide(db, X, [{ id: 'TF1.fr', name: 'TF1' }], [prog('TF1.fr', at(9), at(10), 'Kept')], at(8));
  const { fn } = fakeFetch({ [X]: new Response(GUIDE.slice(0, GUIDE.indexOf('</tv>'))) });
  const res = await refreshGuides(db, [X], fn, at(10));
  assert.match(res[0]!.error ?? '', /incomplete/);
  assert.deepEqual(liveGuide(db, [X], 0, at(23))[0]!.programmes.map((p) => p.title), ['Kept']);
});

test("a guide's end is its own closing tag, not one quoted in a comment or a description", async () => {
  const db = catalog();
  setPicks(db, ['TF1.fr@SD']);
  storeGuide(db, X, [{ id: 'TF1.fr', name: 'TF1' }], [prog('TF1.fr', at(9), at(10), 'Kept')], at(8));
  const quoted = GUIDE.replace('<title>Le 13h</title>', '<title>Le 13h</title><desc><![CDATA[</tv>]]></desc>').replace('<channel id="Nobody.fr">', '<!-- </tv> --><channel id="Nobody.fr">');
  const { fn } = fakeFetch({ [X]: new Response(quoted.slice(0, quoted.lastIndexOf('</tv>'))) });
  const res = await refreshGuides(db, [X], fn, at(10));
  assert.match(res[0]!.error ?? '', /incomplete/);
  assert.deepEqual(liveGuide(db, [X], 0, at(23))[0]!.programmes.map((p) => p.title), ['Kept']);
});

test('a NAS file that cannot be written does not stop the lists, the guides or the checks', async () => {
  // The Service refreshes at its own clock: the day of the guide below.
  mock.timers.enable({ apis: ['Date'], now: at(11) });
  try {
    const tmp = mkdtempSync(join(tmpdir(), 'live-'));
    mkdirSync(join(tmp, 'share'));
    writeFileSync(join(tmp, 'share', 'IPTV'), 'a file where the folder goes');
    const db = openDb(':memory:');
    saveSettings(db, { liveFile: join(tmp, 'share', 'IPTV', 'channels.m3u'), liveGuides: [X] });
    saveCatalog(db, [{ list: 'fr', entries: [TF1] }], at(1));
    setPicks(db, ['TF1.fr@SD']);
    const svc = new Service(db, join(tmp, 'data'));
    const { fn } = fakeFetch({
      [LIVE_LISTS[0]!.url]: new Response(M3U('#EXTINF:-1 tvg-id="TF1.fr@SD" group-title="General",TF1', 'http://s/TF1.fr@SD.m3u8')),
      [LIVE_LISTS[1]!.url]: new Response(M3U('#EXTINF:-1 tvg-id="BX1.be@SD",BX1', 'http://s/bx1')),
      [X]: new Response(GUIDE),
      'http://s/TF1.fr@SD.m3u8': new Response('#EXTM3U\n'),
    });
    await svc.refreshLiveNow(fn);
    assert.ok(getSettings(db).liveRefreshedAt > 0, 'the refresh went on');
    assert.deepEqual(liveGuide(db, [X], 0, at(23))[0]!.programmes.map((p) => p.title), ['Le 13h']);
    assert.equal(liveCatalog(db, [X]).find((r) => r.key === 'TF1.fr@SD')!.ok, true);
    assert.match(svc.status.live.message ?? '', /the file on the NAS/);
  } finally {
    mock.timers.reset();
  }
});

test("the owner's own stream address: written without request headers, kept when reordered, cleared", () => {
  const db = catalog();
  setPicks(db, ['M6.fr@HD', 'TF1.fr@SD']);
  setStream(db, 'M6.fr@HD', 'https://own/m6.m3u8');
  const m6 = pickedChannels(db)[0]!;
  assert.equal(m6.entry.url, 'https://own/m6.m3u8');
  assert.deepEqual(m6.entry.opts, [], "iptv-org's headers were for iptv-org's address");
  assert.match(channelFileText(db), /https:\/\/own\/m6\.m3u8/);
  assert.doesNotMatch(channelFileText(db), /EXTVLCOPT/);
  assert.equal(liveGuide(db, [X], 0, at(23))[0]!.vlc, 'direct');
  assert.equal(liveCatalog(db, [X]).find((r) => r.key === 'M6.fr@HD')!.stream, 'https://own/m6.m3u8');
  assert.equal(liveCatalog(db, [X]).find((r) => r.key === 'TF1.fr@SD')!.stream, null);
  setPicks(db, ['TF1.fr@SD', 'M6.fr@HD']);
  assert.equal(pickedChannels(db)[1]!.entry.url, 'https://own/m6.m3u8', 'kept when reordered');
  setStream(db, 'M6.fr@HD', null);
  assert.equal(pickedChannels(db)[1]!.entry.url, M6.url);
  assert.deepEqual(pickedChannels(db)[1]!.entry.opts, M6.opts);
  assert.throws(() => setStream(db, 'BX1.be@SD', 'https://x/bx1.m3u8'), LiveError, 'not one of the owner channels');
});

test("a stream check asks the owner's own address, which starts unchecked", async () => {
  const db = catalog();
  setPicks(db, ['M6.fr@HD']);
  const old = fakeFetch({ [M6.url]: new Response('#EXTM3U\n') });
  await checkStreams(db, ['M6.fr@HD'], old.fn, at(2));
  setStream(db, 'M6.fr@HD', 'https://own/m6.m3u8');
  assert.equal(liveCatalog(db, [X]).find((r) => r.key === 'M6.fr@HD')!.ok, null, 'a new address is not checked yet');
  const { fn, calls } = fakeFetch({ 'https://own/m6.m3u8': new Response('#EXTM3U\n') });
  await checkStreams(db, ['M6.fr@HD'], fn, at(3));
  assert.deepEqual(calls.map((c) => c.url), ['https://own/m6.m3u8']);
  assert.equal(liveCatalog(db, [X]).find((r) => r.key === 'M6.fr@HD')!.ok, true);
});

test('a check of an old address says nothing about the new one', async () => {
  const db = catalog();
  setPicks(db, ['M6.fr@HD']);
  let answer!: () => void;
  const slow = fakeFetch({ [M6.url]: () => new Promise<Response>((r) => (answer = () => r(new Response('#EXTM3U\n')))) });
  const checking = checkStreams(db, ['M6.fr@HD'], slow.fn, at(2));
  await new Promise((r) => setTimeout(r, 0));
  setStream(db, 'M6.fr@HD', 'https://own/m6.m3u8');
  answer();
  await checking;
  assert.equal(liveCatalog(db, [X]).find((r) => r.key === 'M6.fr@HD')!.ok, null, 'the new address is still unchecked');
});

test("ParaTV's Dailymotion copies reach the TVs through the app, every other channel directly", () => {
  const db = catalog();
  setPicks(db, ['TF1.fr@SD', 'M6.fr@HD']);
  setStream(db, 'M6.fr@HD', 'https://raw.githubusercontent.com/Paradise-91/ParaTV/main/streams/canalplus/m6-dm.m3u8');
  const text = channelFileText(db, 'http://192.168.1.10:8642');
  assert.match(text, /\nhttp:\/\/192\.168\.1\.10:8642\/api\/livetv\/M6\.fr%40HD\/tv\.m3u8\n/);
  assert.match(text, /\nhttp:\/\/s\/TF1\.fr@SD\.m3u8\n/);
  assert.match(channelFileText(db), /m6-dm\.m3u8/, "without the app's address: directly");
});

const NETS = {
  lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
  utun4: [{ address: '100.64.0.7', netmask: '255.255.255.255', family: 'IPv4', internal: false }],
  en0: [{ address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false }, { address: '192.168.1.10', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  en1: [{ address: '10.20.0.3', netmask: '255.255.0.0', family: 'IPv4', internal: false }],
};

test("the app's address as a TV reaches it: the one on the TV's network", () => {
  assert.equal(addressToward('192.168.1.20', NETS), '192.168.1.10');
  assert.equal(addressToward('10.20.7.9', NETS), '10.20.0.3', 'by its netmask, not only the first three numbers');
  assert.equal(addressToward('192.168.2.5', NETS), null, 'none on its network');
  assert.equal(addressToward('tv.local', NETS), null, 'a name, not an address');
});

test("the app's address in the TVs' list: only one that every TV reaches", () => {
  assert.equal(appAddress(['192.168.1.20', '192.168.1.21'], 8642, NETS), 'http://192.168.1.10:8642');
  assert.equal(appAddress(['192.168.1.20', '10.20.7.9'], 8642, NETS), null, 'two TVs on two networks');
  assert.equal(appAddress([], 8642, NETS), null, 'no TV');
});

test('the Extra channels: always offered after the lists, even when a list fails', async () => {
  const db = catalog();
  const { fn } = fakeFetch({ [LIVE_LISTS[0]!.url]: new Response('down', { status: 500 }), [LIVE_LISTS[1]!.url]: new Response('down', { status: 500 }) });
  const res = await refreshCatalog(db, fn, at(5));
  assert.deepEqual(res.map((r) => r.list), ['fr', 'be'], 'only the lists downloaded say how it went');
  const rows = liveCatalog(db, [X]);
  const extra = rows.filter((r) => r.list === 'extra');
  assert.equal(extra.length, EXTRA_CHANNELS.length);
  assert.ok(extra.every((r) => r.listed));
  assert.equal(rows.findIndex((r) => r.list === 'extra'), rows.length - extra.length, 'after the lists');
});

test('the Extra channels: one key each, an https address, a name and a logo', () => {
  assert.equal(new Set(EXTRA_CHANNELS.map((e) => e.key)).size, EXTRA_CHANNELS.length);
  for (const e of EXTRA_CHANNELS) {
    assert.match(e.url, /^https:\/\//, e.name);
    assert.ok(e.name && e.logo.startsWith('https://') && e.group, e.key);
    assert.deepEqual(e.opts, []);
  }
});

test("the Extra channels from Belgium's side: TV5MONDE and the kids' cartoons, each found in its guide", () => {
  const ids = (name: string) => guideCandidates(EXTRA_CHANNELS.find((e) => e.name === name)!);
  assert.ok(ids('TV5MONDE').includes('tv5monde.fr'), "xmltvfr's TV5Monde.fr, by its key");
  assert.ok(ids("Maya l'abeille").includes('fr2400002yg'), "Samsung TV Plus's id");
  assert.ok(ids('Les Schtroumpfs').includes('68b16d2282862c1f067dc763'), "Pluto's id");
});

test("each channel's category: the TVs get it as their group, the guide says it", () => {
  const db = catalog();
  saveCatalog(db, [{ list: 'extra', entries: [entry('Pocoyo.extra', 'Pocoyo', { group: 'Kids' })] }], at(1));
  setPicks(db, ['TF1.fr@SD', 'BX1.be@SD', 'Pocoyo.extra']);
  const text = channelFileText(db);
  assert.match(text, /tvg-name="TF1" tvg-logo="[^"]*" group-title="France"/);
  assert.match(text, /tvg-name="BX1" tvg-logo="[^"]*" group-title="Belgium"/);
  assert.match(text, /tvg-name="Pocoyo" tvg-logo="[^"]*" group-title="Extra"/);
  assert.deepEqual(liveGuide(db, [X], 0, at(23)).map((c) => c.list), ['fr', 'be', 'extra']);
});

test("the owner's channels are numbered category by category, each kept in the owner's order", () => {
  const db = catalog();
  saveCatalog(db, [{ list: 'extra', entries: [entry('Pocoyo.extra', 'Pocoyo')] }], at(1));
  setPicks(db, ['Pocoyo.extra', 'BX1.be@SD', 'M6.fr@HD', 'TF1.fr@SD']);
  assert.deepEqual(pickedChannels(db).map((c) => `${c.number} ${c.entry.key}`), ['1 M6.fr@HD', '2 TF1.fr@SD', '3 BX1.be@SD', '4 Pocoyo.extra']);
});

test("where Kodi finds a file of the NAS: from its media folder's path, beside the Mac's", () => {
  const root = '/Volumes/video/MEDIA';
  assert.equal(kodiPath('/Volumes/video/IPTV/guide.xml', root, 'smb://nas/video/MEDIA'), 'smb://nas/video/IPTV/guide.xml');
  assert.equal(kodiPath('/Volumes/video/IPTV/guide.xml', root, 'smb://me@nas/video/MEDIA/'), 'smb://me@nas/video/IPTV/guide.xml');
  assert.equal(kodiPath('/Volumes/video/IPTV/guide.xml', '/Volumes/video/My Films', 'smb://nas/video/My Films'), 'smb://nas/video/IPTV/guide.xml', 'spaces as Kodi writes them');
  assert.equal(kodiPath('/Volumes/video/IPTV/guide.xml', root, '/storage/video/MEDIA'), '/storage/video/IPTV/guide.xml', 'a local path');
  assert.equal(kodiPath('/Volumes/video/IPTV/guide.xml', root, ''), null, 'not known yet');
  const tv = (pathPrefix: string) => ({ pathPrefix });
  assert.equal(guideAddress([tv('smb://nas/video/MEDIA'), tv('smb://nas/video/MEDIA/')], root, '/Volumes/video/IPTV/channels.m3u'), 'smb://nas/video/IPTV/guide.xml');
  assert.equal(guideAddress([tv('smb://nas/video/MEDIA'), tv('')], root, '/Volumes/video/IPTV/channels.m3u'), 'smb://nas/video/IPTV/guide.xml', 'a TV whose path is not known yet');
  assert.equal(guideAddress([tv('smb://nas/video/MEDIA'), tv('nfs://other/MEDIA')], root, '/Volumes/video/IPTV/channels.m3u'), null, 'TVs that see the NAS each its own way');
  assert.equal(guideAddress([], root, '/Volumes/video/IPTV/channels.m3u'), null);
  const db = catalog();
  setPicks(db, ['TF1.fr@SD']);
  assert.match(channelFileText(db, null, 'smb://nas/video/IPTV/guide.xml'), /^#EXTM3U x-tvg-url="smb:\/\/nas\/video\/IPTV\/guide.xml"\n/);
  assert.match(channelFileText(db), /^#EXTM3U\n/);
});

test("Kodi's guide holds what the TVs show: from a day ago to four days ahead", () => {
  const db = catalog();
  setPicks(db, ['TF1.fr@SD']);
  const now = at(12);
  const day = 24 * 3600_000;
  storeGuide(db, X, [{ id: 'TF1.fr', name: 'TF1' }], [
    { channel: 'TF1.fr', start: now - day - 3600_000, stop: now - day - 60_000, title: 'Too old' },
    { channel: 'TF1.fr', start: now - day + 60_000, stop: now - day + 3600_000, title: 'Yesterday' },
    { channel: 'TF1.fr', start: now + 4 * day - 3600_000, stop: now + 4 * day, title: 'In four days' },
    { channel: 'TF1.fr', start: now + 4 * day + 60_000, stop: now + 4 * day + 3600_000, title: 'Too far' },
  ], now);
  const titles = [...guideFileText(db, [X], now).matchAll(/<title>([^<]+)<\/title>/g)].map((m) => m[1]);
  assert.deepEqual(titles, ['Yesterday', 'In four days']);
});

test("a channel for kids: in its category's group and the TVs' Kids group, kept when the channels are reordered", () => {
  const db = catalog();
  setPicks(db, ['TF1.fr@SD', 'M6.fr@HD']);
  setKids(db, 'M6.fr@HD', true);
  setPicks(db, ['M6.fr@HD', 'TF1.fr@SD']);
  assert.match(channelFileText(db), /tvg-name="M6 HD" tvg-logo="[^"]*" group-title="France;Kids"/);
  assert.match(channelFileText(db), /tvg-name="TF1" tvg-logo="[^"]*" group-title="France",/);
  assert.deepEqual(liveGuide(db, [X], 0, at(23)).map((c) => [c.key, c.kids]), [['M6.fr@HD', true], ['TF1.fr@SD', false]]);
  assert.equal(liveCatalog(db, [X]).find((r) => r.key === 'M6.fr@HD')!.kids, true);
  setKids(db, 'M6.fr@HD', false);
  assert.doesNotMatch(channelFileText(db), /Kids/);
  assert.throws(() => setKids(db, 'BX1.be@SD', true), LiveError, "only one of the owner's channels");
});

test("a channel's own logo: on the TVs' list, the guide and the settings, kept when reordered or the lists refresh", () => {
  const db = catalog();
  setPicks(db, ['TF1.fr@SD', 'M6.fr@HD']);
  setLogo(db, 'M6.fr@HD', 'https://own/m6.png');
  setPicks(db, ['M6.fr@HD', 'TF1.fr@SD']);
  saveCatalog(db, [{ list: 'fr', entries: [TF1, { ...M6, logo: 'https://listed/m6-new.png' }, LCI, LCI_HD] }], at(2));
  assert.match(channelFileText(db), /tvg-name="M6 HD" tvg-logo="https:\/\/own\/m6\.png"/);
  assert.match(channelFileText(db), /tvg-name="TF1" tvg-logo="https:\/\/logo\/TF1\.png"/);
  assert.equal(liveGuide(db, [X], 0, at(23)).find((c) => c.key === 'M6.fr@HD')!.logo, 'https://own/m6.png');
  const row = liveCatalog(db, [X]).find((r) => r.key === 'M6.fr@HD')!;
  assert.deepEqual([row.logo, row.ownLogo], ['https://own/m6.png', 'https://own/m6.png']);
  setLogo(db, 'M6.fr@HD', null);
  const back = liveCatalog(db, [X]).find((r) => r.key === 'M6.fr@HD')!;
  assert.deepEqual([back.logo, back.ownLogo], ['https://listed/m6-new.png', null], "back to iptv-org's, as listed now");
  assert.throws(() => setLogo(db, 'BX1.be@SD', 'https://own/bx1.png'), LiveError, "only one of the owner's channels");
});

test("a channel the TVs play with ffmpegdirect: its lines on the TVs' list only, kept when reordered", () => {
  const db = catalog();
  saveCatalog(db, [{ list: 'fr', entries: [TF1, M6, LCI, LCI_HD, { ...entry('France3.fr@SD', 'France 3'), url: 'http://relay/udp/239.1.1.1:5000' }] }], at(2));
  setPicks(db, ['TF1.fr@SD', 'M6.fr@HD', 'France3.fr@SD']);
  setPlayer(db, 'TF1.fr@SD', 'ffmpegdirect');
  setPlayer(db, 'France3.fr@SD', 'ffmpegdirect');
  setPicks(db, ['M6.fr@HD', 'TF1.fr@SD', 'France3.fr@SD']);
  const text = channelFileText(db);
  assert.match(
    text,
    /tvg-name="TF1"[^\n]*\n#KODIPROP:inputstream=inputstream\.ffmpegdirect\n#KODIPROP:inputstream\.ffmpegdirect\.is_realtime_stream=true\n#KODIPROP:inputstream\.ffmpegdirect\.manifest_type=hls\nhttp:\/\/s\/TF1\.fr@SD\.m3u8\n/,
  );
  assert.match(text, /tvg-name="France 3"[^\n]*\n#KODIPROP:inputstream=inputstream\.ffmpegdirect\n#KODIPROP:inputstream\.ffmpegdirect\.is_realtime_stream=true\nhttp:\/\/relay\//, 'not HLS: no manifest type');
  assert.match(text, /tvg-name="M6 HD"[^\n]*\n#EXTVLCOPT:http-user-agent=UA\nhttp:\/\/s\/M6\.fr@HD\.m3u8\n/, 'the others as before');
  assert.equal(liveGuide(db, [X], 0, at(23)).find((c) => c.key === 'TF1.fr@SD')!.vlc, 'direct', "the phone's VLC doesn't get Kodi's lines");
  assert.equal(liveCatalog(db, [X]).find((r) => r.key === 'TF1.fr@SD')!.player, 'ffmpegdirect');
  setPlayer(db, 'TF1.fr@SD', null);
  assert.equal(liveCatalog(db, [X]).find((r) => r.key === 'TF1.fr@SD')!.player, null);
  assert.doesNotMatch(channelFileText(db), /tvg-name="TF1"[^\n]*\n#KODIPROP/);
  assert.throws(() => setPlayer(db, 'BX1.be@SD', 'ffmpegdirect'), LiveError, "only one of the owner's channels");
  setStream(db, 'M6.fr@HD', 'https://own/m6.m3u8#token');
  setPlayer(db, 'M6.fr@HD', 'ffmpegdirect');
  assert.match(channelFileText(db), /manifest_type=hls\nhttps:\/\/own\/m6\.m3u8#token\n/, 'HLS, whatever follows its extension');
});
