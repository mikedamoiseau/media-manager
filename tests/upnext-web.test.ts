import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryLabel, sleepLabel } from '../web/src/upNext.ts';

const NOW = Date.UTC(2026, 9, 29, 21);

test('an entry says which episode it is, as the library does', () => {
  assert.equal(entryLabel({ season: 2, episode: 5 }), 'S2 E5');
  assert.equal(entryLabel({ season: null, episode: 5 }), 'E5');
  assert.equal(entryLabel({ season: null, episode: null }), null, 'a film');
});

test('the timer says when it stops', () => {
  assert.equal(sleepLabel({ at: NOW + 41.2 * 60_000 }, NOW, true), 'Stops in 42 min');
  assert.equal(sleepLabel({ at: NOW + 10_000 }, NOW, true), 'Stops in 1 min');
  assert.equal(sleepLabel({ at: NOW - 5000 }, NOW, true), 'Stops in 1 min', 'due: about to stop');
  assert.equal(sleepLabel({ afterThis: true }, NOW, true), 'Stops after this episode');
  assert.equal(sleepLabel({ afterThis: true }, NOW, false), 'Stops after this film');
  assert.equal(sleepLabel(null, NOW, true), null);
});
