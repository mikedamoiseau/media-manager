import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getSettings, saveSettings, type KodiTv } from '../server/db.ts';
import { pickTv, handoffTv, addTv, editTv, removeTv, publicTvs, firstTvChanged, firstRun } from '../server/tvs.ts';
import { chosenTv } from '../web/src/tvs.ts';

const living: KodiTv = { id: 'tv1', name: 'Living room', host: '192.168.0.20', port: 8080, user: 'kodi', pass: '', pathPrefix: 'smb://nas/video/MEDIA' };
const bedroom: KodiTv = { id: 'tv2', name: 'Bedroom', host: '192.168.0.32', port: 8080, user: 'kodi', pass: 'secret', pathPrefix: '' };

test('the one Kodi set up before TVs becomes the first TV, the living room', () => {
  const db = openDb(':memory:');
  assert.deepEqual(getSettings(db).kodiTvs, [], 'none set up: no TV');
  const old = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries({ kodiHost: '192.168.0.20', kodiPort: 8080, kodiUser: 'kodi', kodiPass: 'pw', kodiPathPrefix: 'smb://nas/video/MEDIA' })) {
    old.run(k, JSON.stringify(v));
  }
  assert.deepEqual(getSettings(db).kodiTvs, [{ ...living, pass: 'pw' }]);
  assert.equal(getSettings(db).kodiTvLast, 1, 'tv1 given: removed, it is not given again');
});

test('TVs as saved, even none: the Kodi set up before them does not come back', () => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?)').run('kodiHost', JSON.stringify('192.168.0.20'));
  saveSettings(db, { kodiTvs: [living, bedroom] });
  assert.deepEqual(getSettings(db).kodiTvs, [living, bedroom]);
  saveSettings(db, { kodiTvs: [] });
  assert.deepEqual(getSettings(db).kodiTvs, []);
});

test('the TV a request is for: the one asked, else the first', () => {
  const tvs = [living, bedroom];
  assert.equal(pickTv(tvs, 'tv2'), bedroom);
  assert.equal(pickTv(tvs, undefined), living);
  assert.equal(pickTv(tvs, 'tv9'), living, 'a TV removed since: the first');
  assert.equal(pickTv([], 'tv1'), undefined);
});

test('the TV a VLC handoff stops: the one its link names, none if removed since; older links, the first', () => {
  const tvs = [living, bedroom];
  assert.equal(handoffTv(tvs, 'tv2'), bedroom);
  assert.equal(handoffTv(tvs, 'tv9'), undefined, 'not another TV playing the same film');
  assert.equal(handoffTv(tvs, undefined), living);
});

test('adding a TV: a name and an address, a new id, Kodi defaults for the rest', () => {
  const tvs = addTv([living], { name: '  Bedroom ', host: ' 192.168.0.32 ' });
  assert.deepEqual(tvs, [living, { id: 'tv2', name: 'Bedroom', host: '192.168.0.32', port: 8080, user: 'kodi', pass: '', pathPrefix: '' }]);
  assert.equal(addTv(removeTv(tvs, 'tv1'), { name: 'Kitchen', host: '192.168.0.50' })[1]!.id, 'tv3', 'after the highest id');
  assert.throws(() => addTv([living], { name: ' ', host: '192.168.0.32' }), /name/i);
  assert.throws(() => addTv([living], { name: 'Bedroom', host: '' }), /address/i);
  assert.throws(() => addTv([living], { name: 'Again', host: '192.168.0.20' }), /Living room/, 'same box twice');
});

test("a removed TV's id is never given again: a phone that kept it must not control another TV", () => {
  // tv2 was the last id given, then removed: the next TV is tv3, not tv2 again.
  assert.equal(addTv([living], { name: 'Kitchen', host: '192.168.0.50' }, 2)[1]!.id, 'tv3');
  const db = openDb(':memory:');
  assert.equal(getSettings(db).kodiTvLast, 0);
  saveSettings(db, { kodiTvLast: 2 });
  assert.equal(getSettings(db).kodiTvLast, 2);
});

test('a Kodi box is looked for on the network on the first run only, not once the TVs were removed', () => {
  assert.equal(firstRun({ kodiTvs: [], kodiTvLast: 0 }), true);
  assert.equal(firstRun({ kodiTvs: [], kodiTvLast: 2 }), false, 'all removed');
  assert.equal(firstRun({ kodiTvs: [living], kodiTvLast: 1 }), false);
});

test('the library syncs again when the first TV is another one, or is reached another way', () => {
  const tvs = [living, bedroom];
  const after = (patch: Partial<KodiTv>) => [{ ...living, ...patch }, bedroom];
  assert.equal(firstTvChanged(tvs, [bedroom, living]), true, 'another first TV');
  for (const patch of [{ host: '192.168.0.21' }, { port: 8081 }, { user: 'me' }, { pass: 'pw' }, { pathPrefix: 'nfs://nas/MEDIA' }]) {
    assert.equal(firstTvChanged(tvs, after(patch)), true, JSON.stringify(patch));
  }
  assert.equal(firstTvChanged(tvs, after({ name: 'Lounge' })), false, 'a new name only');
  assert.equal(firstTvChanged(tvs, [living, { ...bedroom, host: '192.168.0.33' }]), false, 'another TV changed');
  assert.equal(firstTvChanged(tvs, []), false, 'none left: nothing to sync from');
  assert.equal(firstTvChanged([], [living]), true, 'the first TV ever');
});

test('editing a TV: the hidden password stays unless a new one is typed', () => {
  const tvs = [living, bedroom];
  assert.deepEqual(editTv(tvs, 'tv2', { name: 'Our room', pass: '••••' })[1], { ...bedroom, name: 'Our room' });
  assert.equal(editTv(tvs, 'tv2', { pass: 'new' })[1]!.pass, 'new');
  assert.equal(editTv(tvs, 'tv2', { pass: '' })[1]!.pass, '', 'cleared');
  assert.throws(() => editTv(tvs, 'tv9', { name: 'x' }), /not found/i);
  // Another address, the media path as it was: worked out again from that Kodi. One typed in stays.
  assert.equal(editTv(tvs, 'tv1', { host: '192.168.0.21', pathPrefix: living.pathPrefix })[0]!.pathPrefix, '');
  assert.equal(editTv(tvs, 'tv1', { host: '192.168.0.21', pathPrefix: 'nfs://nas/MEDIA' })[0]!.pathPrefix, 'nfs://nas/MEDIA');
  assert.equal(editTv(tvs, 'tv1', { name: 'Lounge', pathPrefix: living.pathPrefix })[0]!.pathPrefix, living.pathPrefix);
  assert.throws(() => editTv(tvs, 'tv2', { host: '192.168.0.20' }), /Living room/);
  assert.deepEqual(removeTv(tvs, 'tv1'), [bedroom]);
});

test('TVs sent to the app: passwords hidden', () => {
  assert.deepEqual(publicTvs([living, bedroom]).map((t) => t.pass), ['', '••••']);
});

test("this device's TV: the one it picked, else the first", () => {
  const tvs = [{ id: 'tv1', name: 'Living room' }, { id: 'tv2', name: 'Bedroom' }];
  assert.equal(chosenTv(tvs, 'tv2'), tvs[1]);
  assert.equal(chosenTv(tvs, null), tvs[0]);
  assert.equal(chosenTv(tvs, 'tv9'), tvs[0]);
  assert.equal(chosenTv([], 'tv1'), null);
});
