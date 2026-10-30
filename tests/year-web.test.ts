import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coveredLine, daysLine, hourLabel, primeLine, storyCards, teaser } from '../web/src/yearInFilm.ts';
import type { YearInFilm } from '../web/src/types.ts';

const at = (month: number, day: number, year = 2026) => new Date(year, month, day, 20).getTime();
const title = { itemId: 1, name: 'A film', poster: null };

/** A year with genres and prime time, but no actor, no series and nothing logged. */
const year = (more: Partial<YearInFilm> = {}): YearInFilm => ({
  year: 2026, from: at(0, 1), to: at(9, 29), films: 46, episodes: 103, hours: 76, estimated: true, titles: 60,
  genres: [{ name: 'Drama', n: 20 }], actor: null, series: [], hours24: Array.from({ length: 24 }, (_, h) => (h === 22 ? 5 : 0)),
  primeHour: 22, primeCount: 5, plays: 5, afterMidnight: 0, tvs: null, oldest: null, posters: [], asked: false, ...more,
});

test('the cards: those with something to say, the first and the last always', () => {
  assert.deepEqual(storyCards(year()), ['open', 'count', 'hours', 'genres', 'prime', 'summary']);
  assert.deepEqual(
    storyCards(year({
      actor: { name: 'X', n: 2, tie: null, photo: null, titles: [title], onlyFilms: true },
      series: [{ ...title, episodes: 3, backdrop: null }],
      tvs: { since: at(9, 30), rows: [{ name: 'Living room', n: 2 }] },
    })),
    ['open', 'count', 'hours', 'genres', 'actor', 'series', 'prime', 'tvs', 'summary'],
  );
  assert.deepEqual(storyCards(year({ hours: 0, genres: [], primeHour: null })), ['open', 'count', 'summary']);
});

test('an hour of the day, as said', () => {
  assert.deepEqual([22, 0, 12, 9, 13].map(hourLabel), ['10 PM', 'Midnight', 'Noon', '9 AM', '1 PM']);
});

test('the hours in days', () => {
  assert.equal(daysLine(76), 'More than three days');
  assert.equal(daysLine(30), 'More than a day');
  assert.equal(daysLine(48), 'More than a day', 'two days is not more than two days');
  assert.equal(daysLine(23), null);
  assert.equal(daysLine(24), null);
  assert.equal(daysLine(300), 'More than 12 days');
});

test('the teaser: films, episodes, and the actor when there is one', () => {
  assert.equal(teaser(year({ actor: { name: 'X', n: 2, tie: null, photo: null, titles: [], onlyFilms: true } })), '46 films, 103 episodes and one actor you kept coming back to');
  assert.equal(teaser(year()), '46 films and 103 episodes');
  assert.equal(teaser(year({ films: 1, episodes: 0 })), '1 film');
  assert.equal(teaser(year({ films: 0, episodes: 3, actor: { name: 'X', n: 2, tie: null, photo: null, titles: [], onlyFilms: true } })), '3 episodes and one actor you kept coming back to');
});

test('the dates covered: while the year runs, up to today', () => {
  assert.equal(coveredLine(year(), at(9, 29)), '1 January to 29 October');
  assert.equal(coveredLine(year({ to: at(11, 31) }), at(0, 3, 2027)), null);
});

test('prime time, as said', () => {
  assert.equal(primeLine(year()), '5 of your 5 films and episodes started between 10 PM and 11 PM.');
  assert.equal(primeLine(year({ primeHour: 23, primeCount: 2, plays: 9, episodes: 0 })), '2 of your 9 films started between 11 PM and midnight.');
  assert.equal(primeLine(year({ primeHour: 11, primeCount: 1, plays: 4, films: 0 })), '1 of your 4 episodes started between 11 AM and noon.');
});
