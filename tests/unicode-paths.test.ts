import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { scanMediaRoot, onDisk, composed } from '../server/scanner.ts';
import { reconcile } from '../server/library.ts';

// The same names in both Unicode forms: macOS lists a NAS's names decomposed (NFD), Linux as the NAS stores them.
const FILM = 'MOVIES/Le Fabuleux Destin d’Amélie Poulain (2001).mkv';
const SHOW = 'SERIES/Élite (2018) S01';
const EPISODE = `${SHOW}/Élite.S01E01.mkv`;
const nfd = (s: string) => s.normalize('NFD');

function nas(form: 'NFC' | 'NFD'): string {
  const root = mkdtempSync(join(tmpdir(), 'mm-nfc-'));
  for (const p of [FILM, EPISODE]) {
    const f = join(root, p.normalize(form));
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, Buffer.alloc(10));
  }
  return root;
}

test('a scan gives paths in one Unicode form (NFC), whatever form the disk lists names in', async () => {
  const items = await scanMediaRoot(nas('NFD'));
  const paths = items.flatMap((i) => [i.path, ...i.files.map((f) => f.path)]).sort();
  assert.deepEqual(paths, [FILM, SHOW, EPISODE].sort());
  for (const p of paths) assert.equal(p, p.normalize('NFC'));
  assert.ok(items.every((i) => !i.isDir || i.files.every((f) => f.size === 10)), 'sizes read through the names as listed');
});

test('a library brought from a Mac (NFD paths) keeps its titles when scanned where the NAS lists NFC', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mm-nfc-db-')), 'media.db');
  const root = nas('NFC');
  let db = openDb(file);
  reconcile(db, await scanMediaRoot(root), 1000);
  // As the Mac stored them, with what the library knows about them.
  db.exec(`UPDATE items SET match_state = 'matched'`);
  for (const t of ['items', 'episodes']) {
    for (const r of db.prepare(`SELECT id, path FROM ${t}`).all() as Array<{ id: number; path: string }>) {
      db.prepare(`UPDATE ${t} SET path = ? WHERE id = ?`).run(nfd(r.path), r.id);
    }
  }
  const sheetPath = nfd('sheet:Films:Amélie.mkv');
  db.prepare("INSERT INTO items (path, folder, category, present, source, added_at, updated_at) VALUES (?, '', 'movies', 0, 'sheet', 1, 1)").run(sheetPath);
  const before = db.prepare("SELECT id FROM items WHERE source = 'disk' ORDER BY id").all();
  db.close();

  db = openDb(file);
  const r = reconcile(db, await scanMediaRoot(root), 2000);
  assert.deepEqual([r.added.length, r.removed, r.moved], [0, 0, 0]);
  assert.deepEqual(db.prepare("SELECT id FROM items WHERE source = 'disk' ORDER BY id").all(), before);
  assert.deepEqual(
    (db.prepare("SELECT path, match_state, present FROM items WHERE source = 'disk' ORDER BY path").all() as Array<Record<string, unknown>>).map((x) => ({ ...x })),
    [
      { path: FILM, match_state: 'matched', present: 1 },
      { path: SHOW, match_state: 'matched', present: 1 },
    ],
  );
  assert.deepEqual(db.prepare('SELECT path FROM episodes').all().map((x) => ({ ...x })), [{ path: EPISODE }]);
  // Sheet-only entries are named after the sheet's own text: left as they are.
  assert.ok(db.prepare('SELECT 1 FROM items WHERE path = ?').get(sheetPath));
});

// Only possible where the disk keeps both forms apart (Linux): a Mac's disk holds one file for both names.
test('two names that differ only in Unicode form give one library entry, not a failed scan', () => {
  const ep = (path: string) => ({ path, size: 10 });
  const items = composed([
    { path: FILM, folder: 'MOVIES', category: 'movies', isDir: false, mediaType: 'movie', files: [] },
    { path: nfd(FILM), folder: 'MOVIES', category: 'movies', isDir: false, mediaType: 'movie', files: [] },
    { path: SHOW, folder: 'SERIES', category: 'series', isDir: true, mediaType: 'tv', files: [ep(EPISODE), ep(nfd(EPISODE))] },
    { path: nfd(SHOW), folder: 'SERIES', category: 'series', isDir: true, mediaType: 'tv', files: [ep(nfd(EPISODE))] },
  ]);
  assert.deepEqual(items.map((i) => [i.path, i.files.map((f) => f.path)]), [
    [FILM, []],
    [SHOW, [EPISODE]],
  ]);
});

// On a Mac (APFS) both forms open the same file; on Linux (the add-on, CI) only the stored one does.
test('a file the NAS stores with a decomposed name is still found from its NFC path', () => {
  const root = nas('NFD');
  assert.ok(existsSync(onDisk(root, FILM)));
  assert.ok(existsSync(onDisk(root, EPISODE)));
  // A composed folder holding a decomposed file.
  const mixed = mkdtempSync(join(tmpdir(), 'mm-nfc-'));
  mkdirSync(join(mixed, SHOW), { recursive: true });
  writeFileSync(join(mixed, SHOW, nfd('Élite.S01E01.mkv')), Buffer.alloc(10));
  assert.ok(existsSync(onDisk(mixed, EPISODE)));
  const nfcRoot = nas('NFC');
  assert.equal(onDisk(nfcRoot, FILM), join(nfcRoot, FILM));
  assert.equal(onDisk(nfcRoot, 'MOVIES/Gone.mkv'), join(nfcRoot, 'MOVIES/Gone.mkv'), 'not there: the plain path, for a 404');
});
