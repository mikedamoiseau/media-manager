import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, videoType } from '../server/media.ts';

test('byte ranges as VLC and browsers send them', () => {
  assert.equal(parseRange(undefined, 1000), null);
  assert.deepEqual(parseRange('bytes=0-', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=100-199', 1000), { start: 100, end: 199 });
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 }, 'end clamped to the file');
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 }, 'suffix range');
  assert.deepEqual(parseRange('bytes=0-1, 5-9', 1000), { start: 0, end: 1 }, 'only the first of several ranges');
  assert.equal(parseRange('bytes=1000-', 1000), 'invalid', 'starts past the end');
  assert.equal(parseRange('bytes=500-100', 1000), 'invalid');
  assert.equal(parseRange('items=0-1', 1000), null, 'unknown unit: send the whole file');
});

test('video content types by extension', () => {
  assert.equal(videoType('MOVIES/Film (2015).mkv'), 'video/x-matroska');
  assert.equal(videoType('a/b.MP4'), 'video/mp4');
  assert.equal(videoType('x.avi'), 'video/x-msvideo');
  assert.equal(videoType('x.weird'), 'application/octet-stream');
});
