import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliderKey } from '../web/src/sliderKeys.ts';

test('keys on the seek bar move in the video, never the cursor of Kodi', () => {
  const seek = { max: 6720, back: 10, forward: 30 };
  assert.equal(sliderKey('ArrowLeft', 450, seek), 440);
  assert.equal(sliderKey('ArrowDown', 450, seek), 440);
  assert.equal(sliderKey('ArrowRight', 450, seek), 480);
  assert.equal(sliderKey('ArrowUp', 450, seek), 480);
  assert.equal(sliderKey('Home', 450, seek), 0);
  assert.equal(sliderKey('ArrowLeft', 4, seek), 0, 'not before the start');
  assert.equal(sliderKey('End', 450, seek), null, 'a stray key must not end the film');
  assert.equal(sliderKey(' ', 450, seek), null, 'space still plays and pauses');
});

test('keys on the volume bar: steps of 5, Home for silence, never straight to full', () => {
  const volume = { max: 100, back: 5, forward: 5 };
  assert.equal(sliderKey('ArrowUp', 50, volume), 55);
  assert.equal(sliderKey('ArrowLeft', 50, volume), 45);
  assert.equal(sliderKey('ArrowRight', 98, volume), 100);
  assert.equal(sliderKey('Home', 50, volume), 0);
  assert.equal(sliderKey('End', 50, volume), null);
});
