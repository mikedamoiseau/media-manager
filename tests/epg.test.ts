import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xmltvTime, readXmltv, matchGuide, type GuideChannel, type GuideIds, type Programme } from '../server/epg.ts';

const XML = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE tv SYSTEM "xmltv.dtd"><tv>
<channel id="TF1.fr"><display-name>TF1</display-name><icon src="http://x/tf1.png"/></channel>
<channel id="NT1.fr"><display-name lang="fr">TFX</display-name></channel>
<programme start="20261028120000 +0100" stop="20261028124500 +0100" channel="TF1.fr"><title lang="fr">Le 13h &amp; météo</title><sub-title lang="fr">Édition</sub-title><desc lang="fr">Infos &lt;du jour&gt;</desc><category lang="fr">Info</category><icon src="http://x/1.jpg"/></programme>
<programme start="20261025013000 +0200" stop="20261025020000 +0200" channel="NT1.fr"><title>Nuit</title></programme>
</tv>`;

test('XMLTV times keep their offset (summer +0200, winter +0100)', () => {
  assert.equal(xmltvTime('20261028120000 +0100'), Date.UTC(2026, 9, 28, 11, 0, 0));
  assert.equal(xmltvTime('20261025013000 +0200'), Date.UTC(2026, 9, 24, 23, 30, 0));
  assert.equal(xmltvTime('20261028120000'), Date.UTC(2026, 9, 28, 12, 0, 0), 'no offset: UTC');
});

test('channels then programmes, whatever the chunk boundaries', async () => {
  for (const size of [7, 64, XML.length]) {
    const chunks = async function* () {
      for (let i = 0; i < XML.length; i += size) yield XML.slice(i, i + size);
    };
    const ch: GuideChannel[] = [];
    const pr: Programme[] = [];
    await readXmltv(chunks(), { channel: (c) => ch.push(c), programme: (p) => pr.push(p) });
    assert.deepEqual(ch, [{ id: 'TF1.fr', name: 'TF1' }, { id: 'NT1.fr', name: 'TFX' }]);
    assert.deepEqual(pr, [
      { channel: 'TF1.fr', start: Date.UTC(2026, 9, 28, 11, 0), stop: Date.UTC(2026, 9, 28, 11, 45), title: 'Le 13h & météo', sub: 'Édition', category: 'Info', descr: 'Infos <du jour>', icon: 'http://x/1.jpg' },
      { channel: 'NT1.fr', start: Date.UTC(2026, 9, 24, 23, 30), stop: Date.UTC(2026, 9, 25, 0, 0), title: 'Nuit' },
    ]);
  }
});

test('CDATA text stays as written, commented-out elements are not read', async () => {
  const xml = `<tv><!-- <channel id="Old.fr"><display-name>Old</display-name></channel>
<programme start="20261028100000 +0100" stop="20261028110000 +0100" channel="Old.fr"><title>Gone</title></programme> -->
<programme start="20261028120000 +0100" stop="20261028124500 +0100" channel="TF1.fr"><title><![CDATA[A &amp; B]]></title><desc>x <![CDATA[<b>]]> &amp; y</desc></programme></tv>`;
  for (const size of [5, xml.length]) {
    const chunks = async function* () {
      for (let i = 0; i < xml.length; i += size) yield xml.slice(i, i + size);
    };
    const ch: GuideChannel[] = [];
    const pr: Programme[] = [];
    await readXmltv(chunks(), { channel: (c) => ch.push(c), programme: (p) => pr.push(p) });
    assert.deepEqual(ch, []);
    assert.deepEqual(pr.map((p) => [p.channel, p.title, p.descr]), [['TF1.fr', 'A &amp; B', 'x <b> & y']]);
  }
});

test('a guide channel for a playlist channel: id, then aliases, then Pluto, sources in order', () => {
  const ids = (...a: string[]) => new Map(a.map((x) => [x.toLowerCase(), x]));
  const x = 'https://xmltvfr.fr/xmltv/xmltv.xml.gz';
  const pluto = 'https://i.mjh.nz/PlutoTV/fr.xml.gz';
  const guides: GuideIds[] = [
    { source: x, ids: ids('TF1.fr', 'NT1.fr', 'MaTele.be') },
    { source: pluto, ids: ids('TF1.fr', '6823648580b2665220d9e69a') },
  ];
  assert.deepEqual(matchGuide({ key: 'TF1.fr@SD', url: 'http://a' }, guides), { source: x, id: 'TF1.fr' }, 'the first source wins');
  assert.deepEqual(matchGuide({ key: 'Matele.be@SD', url: 'http://a' }, guides), { source: x, id: 'MaTele.be' }, 'case ignored');
  assert.deepEqual(matchGuide({ key: 'TFX.fr@SD', url: 'http://a' }, guides), { source: x, id: 'NT1.fr' }, 'alias');
  assert.deepEqual(
    matchGuide({ key: 'Cine666byPlutoTV.de@FR', url: 'https://jmp2.uk/plu-6823648580b2665220d9e69a.m3u8' }, guides),
    { source: pluto, id: '6823648580b2665220d9e69a' },
  );
  assert.equal(matchGuide({ key: 'Klara.be@SD', url: 'http://a' }, guides), null);
  const samsung = 'https://i.mjh.nz/SamsungTVPlus/fr.xml.gz';
  assert.deepEqual(
    matchGuide({ key: 'Pocoyo.extra', url: 'https://jmp2.uk/stvp-FR700001VJ' }, [...guides, { source: samsung, ids: ids('FR700001VJ') }]),
    { source: samsung, id: 'FR700001VJ' },
    'a Samsung TV Plus id read from its stream address',
  );
});

test('the end of a guide split across two chunks still counts as its end', async () => {
  const none = { channel() {}, programme() {} };
  async function* split() {
    yield '<tv><channel id="a"><display-name>A</display-name></channel>\n</t';
    yield 'v>\n';
  }
  assert.equal(await readXmltv(split(), none), true);
  async function* cut() {
    yield '<tv><channel id="a"><display-name>A</display-name></channel>\n';
  }
  assert.equal(await readXmltv(cut(), none), false);
});
