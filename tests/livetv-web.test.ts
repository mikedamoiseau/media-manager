import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveView, nowAndNext, gridSpan, gridStart, gridFrom, liveVlcHref, GRID_MIN_WIDTH } from '../web/src/liveTv.ts';
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
