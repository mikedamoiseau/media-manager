import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveView, nowAndNext, gridSpan, gridStart, gridFrom, liveVlcHref, moveKey, dragMove, guideLabel, GRID_MIN_WIDTH, listName, listsIn, inSlots, zapTarget } from '../web/src/liveTv.ts';
import type { LiveChannel } from '../web/src/types.ts';

test('grid on wide screens, list on narrow ones, the switch until the screen changes', () => {
  assert.equal(GRID_MIN_WIDTH, 700);
  assert.equal(liveView({ w: 393, h: 852 }, null), 'list');
  assert.equal(liveView({ w: 852, h: 393 }, null), 'grid');
  assert.equal(liveView({ w: 810, h: 1080 }, null), 'grid');
  assert.equal(liveView({ w: 393, h: 852 }, { view: 'grid', w: 393, h: 852 }), 'grid');
  assert.equal(liveView({ w: 852, h: 393 }, { view: 'grid', w: 393, h: 852 }), 'grid', 'rotated: back to automatic');
  assert.equal(liveView({ w: 852, h: 393 }, { view: 'list', w: 393, h: 852 }), 'grid');
});

test('now, next and how far in', () => {
  const at = (h: number, m = 0) => Date.UTC(2026, 9, 28, h, m);
  const ps = [{ start: at(11), stop: at(12), title: 'A' }, { start: at(12), stop: at(13), title: 'B' }];
  assert.deepEqual(nowAndNext(ps, at(11, 15)), { now: ps[0], next: ps[1], progress: 0.25 });
  assert.deepEqual(nowAndNext(ps, at(13, 30)), { now: undefined, next: undefined, progress: 0 });
  assert.deepEqual(nowAndNext(ps, at(10)), { now: undefined, next: ps[0], progress: 0 });
});

test('a programme in the grid, clipped to the window', () => {
  const at = (h: number, m = 0) => Date.UTC(2026, 9, 28, h, m);
  assert.deepEqual(gridSpan({ start: at(11), stop: at(12), title: 'A' }, at(11, 30), at(14), 2), { left: 0, width: 60 });
  assert.deepEqual(gridSpan({ start: at(12), stop: at(15), title: 'B' }, at(11, 30), at(14), 2), { left: 60, width: 240 });
  assert.equal(gridSpan({ start: at(9), stop: at(10), title: 'A' }, at(11), at(14), 2), null);
  assert.equal(gridStart(Date.UTC(2026, 9, 28, 11, 47)), Date.UTC(2026, 9, 28, 11, 0));
  assert.equal(gridStart(Date.UTC(2026, 9, 28, 11, 29)), Date.UTC(2026, 9, 28, 10, 30));
});

test('a guide left open moves its window on, hours later', () => {
  const at = (h: number, m = 0) => Date.UTC(2026, 9, 28, h, m);
  assert.equal(gridFrom(at(11), at(16, 59)), at(11), 'still near the start: the grid stays put');
  assert.equal(gridFrom(at(11), at(17, 1)), at(16, 30));
  assert.equal(gridFrom(at(11), at(11, 5) + 24 * 3600_000), at(10, 30) + 24 * 3600_000);
});

test('VLC gets the stream itself, or the one-channel playlist when the channel needs headers', () => {
  const ch = { key: 'M6.fr@HD', url: 'http://b/m6.m3u8', vlc: 'playlist' } as LiveChannel;
  assert.equal(liveVlcHref('http://mac:8642', { ...ch, vlc: 'direct' }, null), `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent('http://b/m6.m3u8')}`);
  assert.equal(liveVlcHref('http://mac:8642', ch, null), `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent('http://mac:8642/api/livetv/M6.fr%40HD/vlc.m3u')}`);
});

test('dragging a channel one place up or down, never past the ends', () => {
  assert.deepEqual(moveKey(['a', 'b', 'c'], 'a', 1), ['b', 'a', 'c']);
  assert.deepEqual(moveKey(['a', 'b', 'c'], 'c', -1), ['a', 'c', 'b']);
  assert.deepEqual(moveKey(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(moveKey(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c']);
  assert.deepEqual(moveKey(['a', 'b', 'c'], 'x', 1), ['a', 'b', 'c']);
});

test("what a channel's guide reads in Settings", () => {
  const row = { listed: true, guide: { mode: 'auto' as const, source: 'https://xmltvfr.fr/xmltv/xmltv.xml.gz', id: 'TF1.fr', name: 'TF1' } };
  assert.equal(guideLabel(row), 'Guide: TF1 · xmltvfr.fr');
  assert.equal(guideLabel({ ...row, guide: { ...row.guide, mode: 'manual' } }), 'Guide: TF1 · xmltvfr.fr (picked)');
  assert.equal(guideLabel({ ...row, guide: { mode: 'auto' } }), 'No guide found');
  assert.equal(guideLabel({ ...row, guide: { mode: 'none' } }), 'No guide');
  assert.equal(guideLabel({ ...row, guide: { mode: 'manual', source: row.guide.source, id: 'Gone.fr' } }), 'The guide channel picked is gone from the guides');
  assert.equal(guideLabel({ ...row, listed: false }), 'No longer listed by iptv-org');
});

test('a drag moves a row per row-height travelled, stops at the ends, and never swings back and forth', () => {
  const keys = ['a', 'b', 'c', 'd'];
  assert.deepEqual(dragMove(keys, 'a', 10, 40), { keys, rows: 0 });
  assert.deepEqual(dragMove(keys, 'a', 20, 40), { keys, rows: 0 }, 'exactly half a row: not yet (else it would swing back on the next event)');
  assert.deepEqual(dragMove(keys, 'a', 21, 40), { keys: ['b', 'a', 'c', 'd'], rows: 1 });
  assert.deepEqual(dragMove(keys, 'a', 90, 40), { keys: ['b', 'c', 'a', 'd'], rows: 2 });
  assert.deepEqual(dragMove(keys, 'c', -45, 40), { keys: ['a', 'c', 'b', 'd'], rows: -1 });
  assert.deepEqual(dragMove(keys, 'c', 400, 40), { keys: ['a', 'b', 'd', 'c'], rows: 1 }, 'the last place, no further');
});

test('the categories: named, in their order, only those there are', () => {
  assert.deepEqual(['France', 'Belgium', 'Extra', 'xx'], ['fr', 'be', 'extra', 'xx'].map(listName));
  assert.deepEqual(listsIn(['extra', 'fr', 'extra', 'be', 'fr']), ['fr', 'be', 'extra']);
  assert.deepEqual(listsIn(['zz', 'extra', 'fr']), ['fr', 'extra', 'zz'], 'an unknown list last');
});

test("a category's channels reordered in their own places: the others keep their numbers", () => {
  assert.deepEqual(inSlots(['a', 'B1', 'c', 'B2', 'B3'], ['B3', 'B1', 'B2']), ['a', 'B3', 'c', 'B1', 'B2']);
  assert.deepEqual(inSlots(['a', 'b'], ['b', 'a']), ['b', 'a']);
  const order = ['a', 'B1', 'c', 'B2'];
  assert.equal(inSlots(order, ['B1', 'B2']), order, 'unchanged: the same list');
});

test('zapping: along the numbering, round past either end, several taps at once', () => {
  const chs = ['a', 'b', 'c', 'd'].map((key) => ({ key }));
  assert.equal(zapTarget(chs, 'b', 1)?.key, 'c');
  assert.equal(zapTarget(chs, 'b', -1)?.key, 'a');
  assert.equal(zapTarget(chs, 'd', 1)?.key, 'a', 'after the last, the first');
  assert.equal(zapTarget(chs, 'a', -1)?.key, 'd', 'before the first, the last');
  assert.equal(zapTarget(chs, 'b', 3)?.key, 'a');
  assert.equal(zapTarget(chs, 'b', -6)?.key, 'd');
  assert.equal(zapTarget(chs, 'b', 4)?.key, 'b', 'all the way round');
  assert.equal(zapTarget(chs, 'gone', 1), null, 'a channel no longer in the list');
});
