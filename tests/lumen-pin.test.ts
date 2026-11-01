import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, saveSettings, getSettings } from '../server/db.ts';
import { Service } from '../server/service.ts';
import { createApi } from '../server/api.ts';
import { Hono } from 'hono';
import { KidsError, checkParentsCode, setParentsCode } from '../server/kids.ts';
import { LUMEN_PIN } from '../server/kidsTag.ts';
import { standInKodi } from './standInKodi.ts';

/** One TV played by the stand-in, connected; its Lumen PIN as `pin` says ('' : none set on the TV). */
async function setup(pin: string) {
  const kodi = await standInKodi();
  kodi.server.unref();
  kodi.answers['XBMC.GetInfoLabels'] = { [`Skin.String(${LUMEN_PIN})`]: pin };
  const db = openDb(':memory:');
  saveSettings(db, { kodiTvs: [{ id: 'tv1', name: 'Living room', host: '127.0.0.1', port: kodi.port, user: '', pass: '', pathPrefix: '' }] });
  const svc = new Service(db, mkdtempSync(join(tmpdir(), 'data-')));
  /** The PINs the app wrote on the TV, in order. */
  const written = () => kodi.calls.filter((c) => c.method === 'Settings.SetSkinSettingValue' && c.params.setting === LUMEN_PIN).map((c) => c.params.value);
  return { kodi, db, svc, written, [Symbol.dispose]: () => kodi.server.close() };
}

test("the parents' code is the TVs' kids PIN too: set in the app, written on each connected TV", async () => {
  using s = await setup('');
  s.svc.kodiConnected('tv1');
  await s.svc.setParentsCode('4821');
  assert.equal(s.written().at(-1), '4821', 'as a string: Kodi refuses a number');
  assert.ok(checkParentsCode(s.db, '4821'), 'still the code to leave kids mode in the app');
  assert.throws(() => s.svc.setParentsCode('12a4'), KidsError, 'digits only: the TV asks for it on a number pad');
});

test('a TV that connects with another PIN (off when it was set, Lumen reinstalled, Kodi killed) gets the code back', async () => {
  using s = await setup('2468');
  setParentsCode(s.db, '4821');
  s.svc.kodiConnected('tv1');
  await s.svc.syncLumenPins();
  assert.equal(s.written().at(-1), '4821');
  assert.deepEqual(s.kodi.calls.find((c) => c.method === 'XBMC.GetInfoLabels')?.params, { labels: [`Skin.String(${LUMEN_PIN})`] });
});

test('a TV that already has the code is left alone', async () => {
  using s = await setup('4821');
  setParentsCode(s.db, '4821');
  s.svc.kodiConnected('tv1');
  await s.svc.syncLumenPins();
  assert.deepEqual(s.written(), []);
});

test('each play on the TV checks it again: a skin reloaded meanwhile (a Lumen update) went back to the PIN it had saved', async () => {
  using s = await setup('4821');
  setParentsCode(s.db, '4821');
  s.svc.kodiConnected('tv1');
  await s.svc.syncLumenPins();
  s.kodi.answers['XBMC.GetInfoLabels'] = { [`Skin.String(${LUMEN_PIN})`]: '2468' };
  await s.svc.onPlayer('tv1', { kind: 'play' });
  await s.svc.syncLumenPins([]); // once the round the play started is over
  assert.deepEqual(s.written(), ['4821']);
});

test('no code yet, or one set before the TVs got it (the app kept only its hash): the TVs are left alone', async () => {
  using s = await setup('2468');
  s.svc.kodiConnected('tv1');
  await s.svc.syncLumenPins();
  s.db.prepare("INSERT INTO settings (key, value) VALUES ('parentsCode', ?)").run(JSON.stringify({ salt: 'x', hash: 'y' }));
  await s.svc.syncLumenPins();
  assert.deepEqual(s.written(), []);
  assert.ok(!s.kodi.calls.some((c) => c.method === 'XBMC.GetInfoLabels'), 'Kodi not even asked');
});

test("a code that can't be saved whole is not saved at all: the TVs would get the old one back", async () => {
  using s = await setup('');
  setParentsCode(s.db, '4821');
  s.db.exec("CREATE TRIGGER full BEFORE UPDATE ON settings WHEN NEW.key = 'lumenPin' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  assert.throws(() => setParentsCode(s.db, '1357'), /disk full/);
  assert.ok(checkParentsCode(s.db, '4821'), 'the old code still leaves kids mode');
  assert.ok(!checkParentsCode(s.db, '1357'));
});

test("a TV whose skin has no such PIN (not Lumen) refuses: nothing breaks, and the code is kept off the phones' settings", async () => {
  using s = await setup('');
  s.kodi.invalid.add('Settings.SetSkinSettingValue');
  s.svc.kodiConnected('tv1');
  await s.svc.setParentsCode('4821');
  assert.equal(JSON.stringify(getSettings(s.db)).includes('4821'), false);
});

test('a write that failed is tried again at the next look while the TV stays connected; a TV that has it is not asked again', async () => {
  using s = await setup('');
  s.kodi.invalid.add('Settings.SetSkinSettingValue');
  s.svc.kodiConnected('tv1');
  await s.svc.setParentsCode('4821');
  const tries = s.written().length;
  s.kodi.invalid.delete('Settings.SetSkinSettingValue');
  await s.svc.checkSleep();
  assert.equal(s.written().length, tries + 1);
  await s.svc.checkSleep();
  assert.equal(s.written().length, tries + 1, 'written: nothing more until it connects again');
});

test('the app says the code is saved once the connected TVs have it', async () => {
  using s = await setup('');
  s.svc.kodiConnected('tv1');
  const app = new Hono().route('/api', createApi(s.svc));
  const r = await app.request('/api/kids/code', { method: 'PUT', body: JSON.stringify({ code: '4821' }), headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 200);
  assert.equal(s.written().at(-1), '4821');
  assert.equal(((await r.json()) as { notOnTvs?: string[] }).notOnTvs, undefined);
  s.kodi.invalid.add('Settings.SetSkinSettingValue');
  const refused = await app.request('/api/kids/code', { method: 'PUT', body: JSON.stringify({ code: '1357' }), headers: { 'content-type': 'application/json' } });
  assert.equal(refused.status, 200, 'saved in the app all the same');
  assert.deepEqual(((await refused.json()) as { notOnTvs?: string[] }).notOnTvs, ['Living room'], 'and it says which TV keeps its old PIN for now');
  const bad = await app.request('/api/kids/code', { method: 'PUT', body: JSON.stringify({ code: '48' }), headers: { 'content-type': 'application/json' } });
  assert.equal(bad.status, 400);
});
