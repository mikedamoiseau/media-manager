import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { openDb, saveSettings, getSettings } from '../server/db.ts';
import { prefixFromFiles } from '../server/kodi.ts';
import { createApi } from '../server/api.ts';
import { Service } from '../server/service.ts';

test("the media path from Kodi's library files, when its sources say nothing", () => {
  const paths = ['MOVIES3/Shaun the Sheep.mkv', 'KIDS/Zootopia.mkv'];
  assert.equal(prefixFromFiles(['smb://nas/video/MEDIA/MOVIES3/Shaun the Sheep.mkv', 'smb://nas/video/MEDIA/KIDS/Zootopia.mkv', 'smb://other/Film.mkv'], paths), 'smb://nas/video/MEDIA');
  assert.equal(prefixFromFiles(['smb://nas/video/MEDIA/MOVIES3/Other.mkv'], paths), undefined, 'no file the app knows');
  assert.equal(prefixFromFiles([], paths), undefined);
  // Kodi writes names composed (NFC), the Mac's listing may be decomposed
  assert.equal(prefixFromFiles(['smb://nas/MEDIA/KIDS/Le Bêêête.mkv'.normalize('NFC')], ['KIDS/Le Bêêête.mkv'.normalize('NFD')]), 'smb://nas/MEDIA');
});

/** A stand-in Kodi without video sources (its library comes from a shared database), as the Mi Box. */
async function kodiWithoutSources() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const m = JSON.parse(body) as { id: number; method: string; params: Record<string, unknown> };
      calls.push({ method: m.method, params: m.params });
      const result =
        m.method === 'Files.GetSources' ? { sources: [] }
        : m.method === 'VideoLibrary.GetMovies' ? { movies: [{ movieid: 5, file: 'smb://nas/video/MEDIA/MOVIES3/Known.mkv' }], limits: { total: 1 } }
        : 'OK';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: m.id, jsonrpc: '2.0', result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { calls, server, port: (server.address() as AddressInfo).port };
}

test('Play on a TV whose media path is unknown: by Kodi id without it, by file once worked out', async () => {
  const kodi = await kodiWithoutSources();
  try {
    const db = openDb(':memory:');
    const root = mkdtempSync(join(tmpdir(), 'media-'));
    mkdirSync(join(root, 'MOVIES3'));
    saveSettings(db, { mediaRoot: root, kodiTvs: [{ id: 'tv1', name: 'Bedroom', host: '127.0.0.1', port: kodi.port, user: '', pass: '', pathPrefix: '' }] });
    const item = db.prepare(`INSERT INTO items (path, folder, category, is_dir, match_state, present, kodi_id, kodi_type, added_at, updated_at)
      VALUES (?, 'MOVIES3', 'movies', 0, 'unmatched', 1, ?, ?, 1, 1)`);
    const inKodi = Number(item.run('MOVIES3/Known.mkv', 5, 'movie').lastInsertRowid);
    const fileOnly = Number(item.run('MOVIES3/New.mkv', null, null).lastInsertRowid);
    const app = new Hono().route('/api', createApi(new Service(db, mkdtempSync(join(tmpdir(), 'data-')))));
    const playIt = (id: number) => app.request(`/api/items/${id}/play`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kodi-tv': 'tv1' }, body: '{}' });

    assert.equal((await playIt(inKodi)).status, 200, 'a film in Kodi plays by its id');
    assert.deepEqual(kodi.calls.find((c) => c.method === 'Player.Open')?.params.item, { movieid: 5 });

    assert.equal((await playIt(fileOnly)).status, 200, 'a file Kodi lacks: the media path is worked out first');
    assert.deepEqual(kodi.calls.filter((c) => c.method === 'Player.Open').at(-1)?.params.item, { file: 'smb://nas/video/MEDIA/MOVIES3/New.mkv' });
    assert.equal(getSettings(db).kodiTvs[0]!.pathPrefix, 'smb://nas/video/MEDIA', 'and kept');
  } finally {
    kodi.server.close();
  }
});
