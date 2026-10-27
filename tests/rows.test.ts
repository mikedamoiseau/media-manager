import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowOf, ROW_TITLES } from '../web/src/rows.ts';

test("a row's own page: from its path, the films elsewhere and at the cinema never for a kid", () => {
  assert.equal(rowOf('/row/continue', false), 'continue');
  assert.equal(rowOf('/row/suggested', false), 'suggested');
  assert.equal(rowOf('/row/elsewhere', false), 'elsewhere');
  assert.equal(rowOf('/row/cinema', false), 'cinema');
  assert.equal(rowOf('/row/continue', true), 'continue');
  assert.equal(rowOf('/row/suggested', true), 'suggested');
  assert.equal(rowOf('/row/elsewhere', true), null);
  assert.equal(rowOf('/row/cinema', true), null);
  assert.equal(rowOf('/row/other', false), null);
  assert.equal(rowOf('/row/constructor', false), null);
  assert.equal(rowOf('/row/continue/more', false), null);
  assert.equal(rowOf('/set/Shrek', false), null);
  assert.equal(rowOf('/', false), null);
  assert.equal(ROW_TITLES.elsewhere, 'Not on the NAS');
});
