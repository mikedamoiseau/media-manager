import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seekKey } from '../web/src/seekKeys.ts';

test('keys on the seek bar move in the video, never the cursor of Kodi', () => {
  assert.deepEqual(seekKey('ArrowLeft'), { action: 'rewind' });
  assert.deepEqual(seekKey('ArrowDown'), { action: 'rewind' });
  assert.deepEqual(seekKey('ArrowRight'), { action: 'forward' });
  assert.deepEqual(seekKey('ArrowUp'), { action: 'forward' });
  assert.deepEqual(seekKey('Home'), { action: 'seek', value: 0 });
  assert.equal(seekKey('End'), null, 'a stray key must not end the film');
  assert.equal(seekKey(' '), null, 'space still plays and pauses');
});
