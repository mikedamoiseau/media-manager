import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oneAtATime } from '../server/service.ts';

test('a job asked again while it runs runs once more when done, not once per ask', async () => {
  let runs = 0;
  let finish: () => void = () => {};
  const job = oneAtATime(() => {
    runs++;
    return new Promise<void>((r) => (finish = r));
  });
  const first = job();
  void job();
  void job();
  assert.equal(runs, 1, 'not two at once');
  finish();
  await new Promise((r) => setImmediate(r));
  assert.equal(runs, 2, 'once more, for the asks made meanwhile');
  finish();
  await first;
  void job();
  assert.equal(runs, 3, 'asked when idle: runs right away');
  finish();
});
