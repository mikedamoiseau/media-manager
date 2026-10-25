import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseName, seasonFromDir, normalize } from '../server/parse.ts';

const cases: Array<[string, string, number | undefined, string[]?]> = [
  ['102.Dalmatiens.2000.MULTi.VFF.1080p.WEB-DLLight.x264.Wawacity.cyou.mkv', '102 Dalmatiens', 2000],
  ['Blade.Runner.2049.2017.MULTi.VFF.2160p.10bit.4KLight.HDR.BluRay.TrueHD.Atmos.7.1.x265-Wawacity.bz.mkv', 'Blade Runner 2049', 2017],
  ['1917.2019.VOSTFR.1080p.WEB-DL.X264.AC3-NIKOo.mkv', '1917', 2019],
  ['Despicable me (2010) MULTi TrueFrench AC3 HDLight 1080p x264.Wawacity.red.mkv', 'Despicable me', 2010],
  ['Bande de sauvages (Wild Hogs) (2007).MULTI.VFF-VFQ-VOSTFR.1080p.HDLight.Portos.Wawacity.hair.mkv', 'Bande de sauvages', 2007, ['Wild Hogs']],
  ['127 Heures (2010) (127 Hours).MULTi(TrueFrench).HDLight.1080p x264 AC3 5.1.Wawacity.bz.mkv', '127 Heures', 2010, ['127 Hours']],
  ['La.Panthere.Rose.(2006).(The.Pink.Panther).MULTi TrueFrench.HDLight.1080p.H264.Wawacity.bond.mkv', 'La Panthere Rose', 2006, ['The Pink Panther']],
  ['Les Rivières Pourpres FRENCH HDLight 1080p H264.Wawacity.red.mkv', 'Les Rivières Pourpres', undefined],
  ['The.Body.2001.Le.Tombeau.TRUEFRENCH.DVDRip.XviD.Wawacity.vip.avi', 'The Body', 2001, ['Le Tombeau']],
  ['Robin Hood.Prince Of Thieves-DVDRip[Eng]1991.avi', 'Robin Hood Prince Of Thieves', undefined],
  ['Crazy_kung-fu-2004-MULTI.TrueFrench.1080p.HDLight-Wawacity.red.mkv', 'Crazy kung fu', 2004],
  ['Madagascar.2.-.La.Grande.%c9vasion.French.DVDRIP..wawacity.ec...avi', 'Madagascar 2 - La Grande Évasion', undefined],
  ['Sex and the City 2.avi', 'Sex and the City 2', undefined],
  ['17 Again.avi', '17 Again', undefined],
  ['The 5th Element [1997]- keltz.avi', 'The 5th Element', 1997],
  ['Small.Things.Like.These.2024.MULTi.1080p.WEB.H264-FW-Wawacity.tools (1).mkv', 'Small Things Like These', 2024],
  ['13 Hours (2016) MULTi (VFF-VO-VFQ) [1080p] BluRay x264-PopHD (13 Hours - The Secret Soldiers of Benghazi)-Wawacity.tools.mkv', '13 Hours', 2016],
  ['[NeoRyu-Team]Hokuto_No_Ken_Raoh_Gaiden_Junai_Hen_Director\'s_Cut_DVD_[227D7659].avi', 'Hokuto No Ken Raoh Gaiden Junai Hen', undefined],
  ['Ghost_in_the_Shell_(1995)_[720p,BluRay,x264,DTS-ES]_-_THORA.mkv', 'Ghost in the Shell', 1995],
  ['Into The Wild MULTi VFF 1080p HDLight x264 ac3.Wawacity.blue.mkv', 'Into The Wild', undefined],
  ['Oblivion 2013 MULTI [VFF + VFQ + VOA + VITA] 1080p HDLight x264.Wawacity.blue.mkv', 'Oblivion', 2013],
  ['the.social.network.2010.bdrip.xvid-imbt.avi', 'the social network', 2010],
  ['Menace II Society (1993) Directors Cut MULTi VFI 2160p 10bit 4KLight DV HDR BluRay DDP 7.1 x265.mkv', 'Menace II Society', 1993],
  ['Le gendarme a new-york (1965) - 1080p x264 ac3 mHDgz.mkv', 'Le gendarme a new-york', 1965],
  ['Wolverine - Le combat de l\'immortel (2013) EXTENDED MULTi VFF 1080p 10bit HDLight x265 AAC 7.1.Wawacity.one.mkv', 'Wolverine - Le combat de l\'immortel', 2013],
  ['Spectacle_Starmania_20190424.HD.mov', 'Spectacle Starmania 20190424', undefined],
  ['2001.A.Space.Odyssey.1968.MULTi.1080p.mkv', '2001 A Space Odyssey', 1968],
  ['Akira DVD[XviD_704x396].avi', 'Akira', undefined],
  ['VERCINGETORIX.FRENCH.DVDRip.x264.Wawacity.vip.mkv', 'VERCINGETORIX', undefined],
  ['The French Connection 1971 MULTi 1080p.mkv', 'The French Connection', 1971],
  ["En.Taule.Mode.D'Emploi.(Get.Hard).2015.Multi.VFF.WEBRip.1080p.H264.Wawacity.cam.mkv", "En Taule Mode D'Emploi", 2015, ['Get Hard']],
  ['Chien De Flic 2 [K-911].1999.TrueFrench.WEB-DL 720p.AC3.Wawacity.red.mkv', 'Chien De Flic 2', 1999, ['K-911']],
  ['The.Tourist.2010.R5.LiNE.Xvid {1337x}-Noir.avi', 'The Tourist', 2010, []],
  ['Dog Pound 2010 FRENCH HDLigt 1080p h264 AC3 5.1.Wawacity.red.mkv', 'Dog Pound', 2010, []],
];

for (const [input, title, year, alts] of cases) {
  test(`parse: ${input}`, () => {
    const p = parseName(input);
    assert.equal(p.title, title);
    assert.equal(p.year, year);
    if (alts) assert.deepEqual(p.altTitles, alts);
  });
}

test('parse: SxxEyy episodes', () => {
  const p = parseName('1883 (2021) - S01E10 - This Is Not Your Heaven (1080p PMTP WEB-DL x265 t3nzin).mkv');
  assert.equal(p.title, '1883');
  assert.equal(p.season, 1);
  assert.equal(p.episode, 10);
  assert.equal(p.episodeTitle, 'This Is Not Your Heaven');
  const f = parseName('Fallout.2024.S01E04.1080p.WEB.H264-SuccessfulCrab.mkv');
  assert.equal(f.title, 'Fallout');
  assert.equal(f.year, 2024);
  assert.equal(f.episode, 4);
  assert.equal(f.episodeTitle, undefined);
});

test('parse: in-folder episode numbering', () => {
  const a = parseName("Episode 9 Thanks for Waiting, Lord Beerus! A Super Saiyan God is Born At Last!.mp4");
  assert.equal(a.episode, 9);
  assert.equal(a.episodeTitle, 'Thanks for Waiting, Lord Beerus! A Super Saiyan God is Born At Last!');
  const b = parseName("029 - Nicky Larson - Un juste prix.avi");
  assert.equal(b.episode, 29);
  assert.equal(b.episodeTitle, 'Un juste prix');
});

test('parse: quality badges', () => {
  const q = parseName('Blade.Runner.2049.2017.MULTi.VFF.2160p.10bit.4KLight.HDR.BluRay.x265-Wawacity.bz.mkv').quality;
  assert.equal(q.res, '4K');
  assert.equal(q.hdr, true);
  assert.deepEqual(q.langs, ['MULTI', 'VF']);
  assert.equal(q.source, 'BluRay');
  assert.equal(parseName('the.tiger.2015.fansub.vostfr.bdrip.x264.mkv').quality.langs.includes('VOSTFR'), true);
});

test('parse: directory names', () => {
  assert.equal(parseName('Fallout (2024) S01', { isDir: true }).title, 'Fallout');
  assert.equal(parseName('Chernobyl (2019) Season 1', { isDir: true }).year, 2019);
  assert.equal(seasonFromDir('Dragon Ball Super - Season 03 - Universe 6 Saga'), 3);
  assert.equal(seasonFromDir('Saison 2'), 2);
  assert.equal(seasonFromDir('Featurettes'), undefined);
});

test('normalize strips accents and punctuation', () => {
  assert.equal(normalize("L'Attaque du Métro 123"), 'l attaque du metro 123');
  assert.equal(normalize('Fast & Furious'), 'fast and furious');
});

test('parse: decomposed (NFD) names come out composed (NFC)', () => {
  const p = parseName('Astérix et Cléopâtre (1968).avi');
  assert.equal(p.title, 'Astérix et Cléopâtre');
  assert.equal(p.title, p.title.normalize('NFC'));
  assert.equal(p.year, 1968);
});
