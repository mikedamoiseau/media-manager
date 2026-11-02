import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, saveSettings } from '../server/db.ts';
import { Service } from '../server/service.ts';
import { standInKodi } from './standInKodi.ts';

/**
 * Two TVs played by stand-ins, sharing one library as the real ones do, and a media folder with no files yet.
 * The NAS share is one this Mac doesn't have: nothing is written there.
 */
async function setup() {
  const tv1 = await standInKodi();
  const tv2 = await standInKodi();
  for (const k of [tv1, tv2]) k.server.unref();
  const root = mkdtempSync(join(tmpdir(), 'media-'));
  mkdirSync(join(root, 'MOVIES'));
  const db = openDb(':memory:');
  saveSettings(db, {
    mediaRoot: root,
    liveFile: '/nowhere/video/IPTV/channels.m3u',
    kodiTvs: [
      { id: 'tv1', name: 'Living room', host: '127.0.0.1', port: tv1.port, user: '', pass: '', pathPrefix: 'smb://nas/video/MEDIA' },
      { id: 'tv2', name: 'Bedroom', host: '127.0.0.1', port: tv2.port, user: '', pass: '', pathPrefix: 'smb://nas/video/MEDIA' },
    ],
  });
  const data = mkdtempSync(join(tmpdir(), 'data-'));
  const services: Service[] = [];
  /** The app (started again with `restart`). */
  const app = () => {
    services.push(new Service(db, data));
    return services.at(-1)!;
  };
  let n = 0;
  /** A film copied to the NAS. */
  const newFile = () => writeFileSync(join(root, 'MOVIES', `Film.${2000 + ++n}.mkv`), 'x');
  /** How many times each TV's Kodi was asked to scan its library. */
  const scans = () => [tv1, tv2].map((k) => k.calls.filter((c) => c.method === 'VideoLibrary.Scan').length);
  return {
    tv1, tv2, db, app, newFile, scans,
    [Symbol.dispose]: () => {
      for (const s of services) s.stop();
      for (const k of [tv1, tv2]) k.server.close();
    },
  };
}

test('new files on the NAS: the first TV is asked to scan them into Kodi\'s library', async () => {
  using s = await setup();
  const svc = s.app();
  s.newFile();
  await svc.scan();
  assert.deepEqual(s.scans(), [1, 0]);
  await svc.scan();
  assert.deepEqual(s.scans(), [1, 0], 'no new files: not asked again');
});

test('the first TV is off: the next one that answers is asked (the TVs share one library)', async () => {
  using s = await setup();
  const svc = s.app();
  s.tv1.down.now = true;
  s.newFile();
  await svc.scan();
  assert.deepEqual(s.scans(), [0, 1]);
});

test('no TV answers: the first TV to connect is asked, once', async () => {
  using s = await setup();
  const svc = s.app();
  s.tv1.down.now = true;
  s.tv2.down.now = true;
  s.newFile();
  await svc.scan();
  s.tv2.down.now = false;
  svc.kodiConnected('tv2');
  await svc.askKodiToScan([]); // once the round the connection started is over
  assert.deepEqual(s.scans(), [0, 1]);
  s.tv1.down.now = false;
  svc.kodiConnected('tv1');
  await svc.askKodiToScan([]);
  assert.deepEqual(s.scans(), [0, 1], 'Kodi has been asked: the other TV is not');
});

test('the request is kept when the app restarts before a TV answers', async () => {
  using s = await setup();
  s.tv1.down.now = true;
  s.tv2.down.now = true;
  s.newFile();
  await s.app().scan();
  s.app().stop();
  const svc = s.app();
  s.tv1.down.now = false;
  svc.kodiConnected('tv1');
  await svc.askKodiToScan([]);
  assert.deepEqual(s.scans(), [1, 0]);
});

test('two TVs connecting together: only one is asked, so they never scan the shared library at once', async () => {
  using s = await setup();
  const svc = s.app();
  s.tv1.down.now = true;
  s.tv2.down.now = true;
  s.newFile();
  await svc.scan();
  s.tv1.down.now = false;
  s.tv2.down.now = false;
  svc.kodiConnected('tv1');
  svc.kodiConnected('tv2');
  await svc.askKodiToScan([]);
  assert.deepEqual(s.scans(), [1, 0]);
});

test('more new files while Kodi is still answering the last request: it is asked again for them', async () => {
  using s = await setup();
  const svc = s.app();
  let answer = () => {};
  s.tv1.hold.until = new Promise<void>((r) => (answer = r));
  s.newFile();
  const first = svc.scan();
  while (s.scans()[0] === 0) await new Promise((r) => setTimeout(r, 5));
  s.newFile();
  const second = svc.scan();
  const films = () => (s.db.prepare('SELECT count(*) n FROM items').get() as { n: number }).n;
  while (films() < 2) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 5)); // the second scan found its file and waits its turn
  answer();
  await Promise.all([first, second]);
  await svc.askKodiToScan([]);
  assert.deepEqual(s.scans(), [2, 0]);
});

test('a TV that connects with nothing new on the NAS is not asked', async () => {
  using s = await setup();
  const svc = s.app();
  svc.kodiConnected('tv1');
  await svc.askKodiToScan([]);
  assert.deepEqual(s.scans(), [0, 0]);
});
