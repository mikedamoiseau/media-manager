import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plotLang, formatDay, countryName } from '../web/src/search.ts';

test('the plot follows the title language', () => {
  assert.equal(plotLang('fr', 'en'), 'fr');
  assert.equal(plotLang('en', 'fr'), 'en');
});

test('VO shows the plot in the original language when it is French or English, else English', () => {
  assert.equal(plotLang('original', 'fr'), 'fr', 'Les Visiteurs');
  assert.equal(plotLang('original', 'en'), 'en', 'The Da Vinci Code');
  assert.equal(plotLang('original', 'ja'), 'en', 'Spirited Away: no Japanese plot is kept');
  assert.equal(plotLang('original', null), 'en', 'unknown language');
});

test('release dates and countries, for films not on the NAS', () => {
  const today = new Date('2026-10-25T12:00:00');
  assert.equal(formatDay('2026-10-29', today), '29 Oct');
  assert.equal(formatDay('2027-03-03', today), '3 Mar 2027');
  assert.equal(countryName('TH'), 'Thailand');
});
