import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gapLabel, nextLabel, soonWhy } from '../web/src/series.ts';
import type { Film } from '../web/src/types.ts';

const TODAY = new Date('2026-10-29T12:00:00');
const film: Film = { id: 1, fr: 'Film', en: 'Film', o: 'Film', date: null, poster: null };

test('a season missing every aired episode, or some of them as ranges', () => {
  assert.equal(gapLabel({ season: 2, aired: 10, missing: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }), 'Season 2: all 10 episodes');
  assert.equal(gapLabel({ season: 4, aired: 1, missing: [1] }), 'Season 4: 1 episode');
  assert.equal(gapLabel({ season: 1, aired: 10, missing: [8, 3, 7] }), 'Season 1: E03, E07–E08');
  assert.equal(gapLabel({ season: 3, aired: 8, missing: [1, 2, 3] }), 'Season 3: E01–E03');
  assert.equal(gapLabel({ season: 12, aired: 120, missing: [101] }), 'Season 12: E101');
});

test('what comes next on a series page', () => {
  assert.equal(nextLabel({ kind: 'season', season: 4, date: '2027-07-08' }, TODAY), 'Season 4 starts 8 Jul 2027');
  assert.equal(nextLabel({ kind: 'season', season: 3, date: null }, TODAY), 'Season 3 announced');
  assert.equal(nextLabel({ kind: 'episode', s: 3, e: 5, date: '2026-11-02' }, TODAY), 'Next episode S03E05 on 2 Nov');
  assert.equal(nextLabel({ kind: 'episode', s: 3, e: 5, date: null }, TODAY), 'Next episode S03E05');
});

test('why a tile is in Coming soon', () => {
  assert.equal(soonWhy({ kind: 'season', tmdbId: 1, itemId: 1, season: 4, date: '2027-07-08' }, TODAY), 'Season 4 · 8 Jul 2027');
  assert.equal(soonWhy({ kind: 'season', tmdbId: 1, itemId: 1, season: 3, date: null }, TODAY), 'Season 3 · no date yet');
  const f = { kind: 'film', film, set: null, cinema: false, reminder: false } as const;
  assert.equal(soonWhy({ ...f, date: '2026-12-18', set: 'Dune Collection', cinema: true, reminder: true }, TODAY), 'Next in Dune · 18 Dec');
  assert.equal(soonWhy({ ...f, date: null, set: 'Dune Collection' }, TODAY), 'Next in Dune · no date yet');
  assert.equal(soonWhy({ ...f, date: '2026-12-05', cinema: true, reminder: true }, TODAY), 'In cinemas 5 Dec');
  assert.equal(soonWhy({ ...f, date: '2027-03-12', reminder: true }, TODAY), 'Reminder · 12 Mar 2027');
  assert.equal(soonWhy({ ...f, date: null, reminder: true }, TODAY), 'Reminder · no date yet');
});
