import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { scanMediaRoot } from '../server/scanner.ts';
import { reconcile, importSheetRows } from '../server/library.ts';
import { applyKodiLibrary, matchPending } from '../server/metadata.ts';
import { toKodiPath } from '../server/kodi.ts';
import { libraryVersion } from '../server/views.ts';
import { Tmdb } from '../server/tmdb.ts';

const PREFIX = 'smb://192.168.0.24/video/MEDIA';
const NFD = 'MOVIES/Agents Très Spéciaux (2015).mkv';

function seed() {
  const db = openDb(':memory:');
  const ins = db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, match_state, added_at, updated_at)
    VALUES (?, 'MOVIES', 'movies', ?, 'movie', 'pending', 1, 1)`);
  const a = Number(ins.run(NFD, 0).lastInsertRowid);
  const b = Number(ins.run('MOVIES/Monsters (2010)', 1).lastInsertRowid);
  const s = Number(db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, match_state, added_at, updated_at)
    VALUES ('SERIES/Les Misérables', 'SERIES', 'series', 1, 'tv', 'pending', 1, 1)`).run().lastInsertRowid);
  db.prepare('INSERT INTO episodes (item_id, path, season, episode) VALUES (?, ?, 1, 1)').run(s, 'SERIES/Les Misérables/Épisode 1.mkv');
  return { db, a, b, s };
}

const movie = (file: string, extra: Record<string, unknown> = {}) => ({
  movieid: 7, file, title: 'X', uniqueid: { tmdb: '42' }, playcount: 0, ...extra,
});

test('Kodi (NFC) links to macOS (NFD) paths, folder films and episodes', () => {
  const { db, a, b, s } = seed();
  const r = applyKodiLibrary(db, PREFIX, {
    movies: [
      movie(`${PREFIX}/${NFD.normalize('NFC')}`, { playcount: 1 }),
      movie(`${PREFIX}/MOVIES/Monsters (2010)/Monsters.mkv`, { movieid: 8, uniqueid: { tmdb: '43' } }),
    ],
    shows: [],
    episodes: [{
      episodeid: 99, file: `${PREFIX}/SERIES/Les Misérables/Épisode 1.mkv`.normalize('NFC'), playcount: 2,
      resume: { position: 600, total: 2400 }, lastplayed: '2026-10-20 21:00:00',
    }],
  }, 1000);
  assert.deepEqual([r.linked, r.episodes], [2, 1]);
  const ia = db.prepare('SELECT kodi_id, playcount, tmdb_id, match_state FROM items WHERE id = ?').get(a) as Record<string, unknown>;
  assert.deepEqual({ ...ia }, { kodi_id: 7, playcount: 1, tmdb_id: 42, match_state: 'matched' });
  assert.equal((db.prepare('SELECT tmdb_id FROM items WHERE id = ?').get(b) as { tmdb_id: number }).tmdb_id, 43);
  assert.deepEqual({ ...(db.prepare('SELECT kodi_id, playcount, resume, last_played FROM episodes WHERE item_id = ?').get(s) as object) },
    { kodi_id: 99, playcount: 2, resume: 0.25, last_played: '2026-10-20 21:00:00' });
});

test('watched changes bump the library version; identical syncs do not', () => {
  const { db } = seed();
  const lib = (playcount: number) => ({ movies: [movie(`${PREFIX}/${NFD}`, { playcount })], shows: [], episodes: [] });
  applyKodiLibrary(db, PREFIX, lib(0), 1000);
  const v1 = libraryVersion(db);
  applyKodiLibrary(db, PREFIX, lib(0), 2000);
  assert.equal(libraryVersion(db), v1);
  applyKodiLibrary(db, PREFIX, lib(1), 3000);
  assert.notEqual(libraryVersion(db), v1);
});

test('paths sent to Kodi are NFC', () => {
  const p = toKodiPath(PREFIX, NFD);
  assert.equal(p, p.normalize('NFC'));
  assert.ok(p.endsWith('Agents Très Spéciaux (2015).mkv'));
});

test('a rescan keeps the full size of a show when only one episode is new', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mm-'));
  mkdirSync(join(root, 'SERIES/Show'), { recursive: true });
  writeFileSync(join(root, 'SERIES/Show/S01E01.mkv'), Buffer.alloc(2000));
  const db = openDb(':memory:');
  reconcile(db, await scanMediaRoot(root));
  writeFileSync(join(root, 'SERIES/Show/S01E02.mkv'), Buffer.alloc(7));
  const known = new Set((db.prepare('SELECT path FROM episodes').all() as Array<{ path: string }>).map((r) => r.path));
  reconcile(db, await scanMediaRoot(root, { known }));
  assert.equal((db.prepare("SELECT size FROM items WHERE path = 'SERIES/Show'").get() as { size: number }).size, 2007);
  rmSync(root, { recursive: true });
});

test('a match made while TMDB matching runs is not overwritten', async () => {
  const { db, a } = seed();
  db.prepare("UPDATE items SET match_state = 'none' WHERE id != ?").run(a);
  const fake = (async () => {
    // The user picks a title by hand while the search is in flight.
    db.prepare("UPDATE items SET tmdb_id = 555, match_state = 'manual', match_source = 'manual' WHERE id = ?").run(a);
    return new Response(JSON.stringify({ results: [{ id: 1005, title: 'X', original_title: 'X', release_date: '2015-01-01', popularity: 1 }] }));
  }) as typeof fetch;
  const tmdb = new Tmdb('k', fake, 0);
  tmdb.details = async () => { throw new Error('not needed'); };
  await matchPending(db, tmdb).catch(() => {});
  const r = db.prepare('SELECT tmdb_id, match_state FROM items WHERE id = ?').get(a) as Record<string, unknown>;
  assert.deepEqual({ ...r }, { tmdb_id: 555, match_state: 'manual' });
});

test('sheet hints bump the library version only when they change', () => {
  const { db } = seed();
  const rows = [{ tab: 'MOVIES', filename: 'Agents Très Spéciaux (2015).mkv', titleEn: 'The Man from U.N.C.L.E.', titleFr: 'Agents très spéciaux', year: 2015, folders: [] }];
  const v0 = libraryVersion(db);
  importSheetRows(db, rows, 5000);
  const v1 = libraryVersion(db);
  assert.notEqual(v1, v0);
});

test("a Kodi match sent back to review stays there: Kodi's next sync does not re-apply it", () => {
  const { db, a } = seed();
  db.prepare("UPDATE items SET match_state = 'unmatched', match_source = 'kodi-doubted' WHERE id = ?").run(a);
  applyKodiLibrary(db, PREFIX, { movies: [movie(`${PREFIX}/${NFD}`, { playcount: 1 })], shows: [], episodes: [] }, 1000);
  const ia = db.prepare('SELECT kodi_id, playcount, tmdb_id, match_state FROM items WHERE id = ?').get(a) as Record<string, unknown>;
  assert.deepEqual({ ...ia }, { kodi_id: 7, playcount: 1, tmdb_id: null, match_state: 'unmatched' }, 'watched state still syncs');
});
