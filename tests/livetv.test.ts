import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getSettings } from '../server/db.ts';
import type { M3uEntry } from '../server/iptv.ts';
import type { Programme } from '../server/epg.ts';
import {
  LiveError, saveCatalog, setPicks, setGuidePick, pickedChannels, channelFileText, storeGuide, liveGuide, liveCatalog, guideOf,
} from '../server/livetv.ts';

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
  assert.deepEqual(s.liveGuides, [X, 'https://i.mjh.nz/PlutoTV/fr.xml.gz']);
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
