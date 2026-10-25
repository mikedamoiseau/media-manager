import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, rowsFromCsv, tabsFromHtml, fileKey, sheetIdFrom } from '../server/sheet.ts';

test('sheetIdFrom takes the id or any link to the sheet', () => {
  assert.equal(sheetIdFrom(' abc_DEF-123 '), 'abc_DEF-123');
  assert.equal(sheetIdFrom('https://docs.google.com/spreadsheets/d/abc_DEF-123/edit?gid=0#gid=0'), 'abc_DEF-123');
  assert.equal(sheetIdFrom('docs.google.com/spreadsheets/d/abc_DEF-123'), 'abc_DEF-123');
  assert.equal(sheetIdFrom(''), '');
});

test('parseCsv handles quotes, commas and escaped quotes', () => {
  assert.deepEqual(parseCsv('a,"b,c","say ""hi"""\r\nd,,e\n'), [
    ['a', 'b,c', 'say "hi"'],
    ['d', '', 'e'],
  ]);
});

test('rowsFromCsv unpacks rows pasted into a single cell', () => {
  const csv = [
    'Filename / folder,English title,French title,Year,Folder',
    '"17 Again.avi,17 Again,17 Ans Encore,2009",17 Again,17 Ans Encore,2009,MOVIES2',
    '"Ghost_in_the_Shell_(1995)_[720p,BluRay,x264,DTS-ES]_-_THORA.mkv",Ghost in the Shell,Ghost in the Shell,1995,ANIMES_TEMP',
    'Some.Movie.mkv,Some Movie,Un Film,2001,"MOVIES, MOVIES2"',
  ].join('\n');
  const rows = rowsFromCsv('MOVIES', csv);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.filename, '17 Again.avi');
  assert.equal(rows[0]!.titleFr, '17 Ans Encore');
  assert.equal(rows[0]!.year, 2009);
  assert.equal(rows[1]!.filename, 'Ghost_in_the_Shell_(1995)_[720p,BluRay,x264,DTS-ES]_-_THORA.mkv');
  assert.deepEqual(rows[2]!.folders, ['MOVIES', 'MOVIES2']);
});

test('rowsFromCsv reads bare filename tabs', () => {
  const rows = rowsFromCsv('KIDS', 'A Bugs Life .mkv\nAntz.avi\n');
  assert.deepEqual(
    rows.map((r) => [r.filename, r.titleEn]),
    [
      ['A Bugs Life .mkv', undefined],
      ['Antz.avi', undefined],
    ],
  );
});

test('tabsFromHtml extracts tab names and gids', () => {
  const html = `x {name: "ANIMES", pageUrl: "https:\\/\\/docs.google.com\\/x?gid=0", gid: "0"} y {name: "KIDS", pageUrl: "u", gid: "1233413509"}`;
  assert.deepEqual(tabsFromHtml(html), [
    { name: 'ANIMES', gid: '0' },
    { name: 'KIDS', gid: '1233413509' },
  ]);
});

test('fileKey drops extension and case', () => {
  assert.equal(fileKey('Antz.AVI'), 'antz');
  assert.equal(fileKey('102.Dalmatiens.2000.MULTi.VFF.1080p.WEB-DLLight.x264.Wawacity.cyou'), '102.dalmatiens.2000.multi.vff.1080p.web-dllight.x264.wawacity.cyou');
});
