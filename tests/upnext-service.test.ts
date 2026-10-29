import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, saveSettings } from '../server/db.ts';
import { Service } from '../server/service.ts';
import { PlayError, playItem } from '../server/playItem.ts';
import { MAIN_PROFILE, PROFILE_COLORS, addProfile } from '../server/profiles.ts';

/** A stand-in Kodi: answers what Play and Stop ask, and keeps every call. */
async function standInKodi() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const players: Array<{ playerid: number; type: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const m = JSON.parse(body) as { id: number; method: string; params: Record<string, unknown> };
      calls.push({ method: m.method, params: m.params });
      const result = m.method === 'Player.GetActivePlayers' ? players : 'OK';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: m.id, jsonrpc: '2.0', result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const opened = () => calls.filter((c) => c.method === 'Player.Open').map((c) => c.params.item);
  return { calls, players, server, port, opened };
}

/** A library with two films in Kodi, on one TV played by the stand-in. */
async function setup() {
  const kodi = await standInKodi();
  const db = openDb(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'media-'));
  mkdirSync(join(root, 'MOVIES'));
  saveSettings(db, { mediaRoot: root, kodiTvs: [{ id: 'tv1', name: 'Living room', host: '127.0.0.1', port: kodi.port, user: '', pass: '', pathPrefix: 'smb://nas/MEDIA' }] });
  const item = db.prepare(`INSERT INTO items (path, folder, category, is_dir, match_state, present, kodi_id, kodi_type, added_at, updated_at)
    VALUES (?, 'MOVIES', 'movies', 0, 'unmatched', ?, ?, 'movie', 1, 1)`);
  const a = Number(item.run('MOVIES/A.mkv', 1, 11).lastInsertRowid);
  const b = Number(item.run('MOVIES/B.mkv', 1, 12).lastInsertRowid);
  const gone = Number(item.run('MOVIES/Gone.mkv', 0, 13).lastInsertRowid);
  const anna = addProfile(db, { name: 'Anna', color: PROFILE_COLORS[1] }).id;
  const svc = new Service(db, mkdtempSync(join(tmpdir(), 'data-')));
  return { kodi, db, svc, a, b, gone, anna, [Symbol.dispose]: () => kodi.server.close() };
}

test('playItem plays a film by its Kodi id', async () => {
  using s = await setup();
  await playItem(s.svc, 'tv1', MAIN_PROFILE, s.a);
  assert.deepEqual(s.kodi.opened(), [{ movieid: 11 }]);
});

test('playItem refuses a film that left the NAS', async () => {
  using s = await setup();
  await assert.rejects(playItem(s.svc, 'tv1', s.anna, s.gone), (e: unknown) => e instanceof PlayError && e.status === 404 && e.message === 'File is not on the NAS');
  assert.deepEqual(s.kodi.opened(), []);
});
