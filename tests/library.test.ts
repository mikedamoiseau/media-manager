import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { scanMediaRoot, ruleFor } from '../server/scanner.ts';
import { reconcile, importSheetRows } from '../server/library.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mm-'));
  const mk = (p: string, bytes = 10) => {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), Buffer.alloc(bytes));
  };
  mk('MOVIES/Prometheus.2012.MULTi.1080p.mkv', 100);
  mk('MOVIES2/Antz.avi');
  mk('MOVIES2/Downloading.2024.mkv.part');
  mk('MOVIES2/.DS_Store');
  mk('SERIES/Fallout (2024) S01/Fallout.2024.S01E01.1080p.mkv');
  mk('SERIES/Fallout (2024) S01/Fallout.2024.S01E02.1080p.mkv');
  mk('SERIES/Fallout (2024) S01/Featurettes/Making Fallout.mkv');
  mk('SERIES/Fallout (2024) S01/notes.txt');
  mk('KIDS/Peppa Pig/Peppa Pig - Compilation 1.mp4');
  mk('FITNESS/Insanity/Disc 1.mp4');
  mk('Spectacle_Starmania_20190424.HD.mov');
  return root;
}

test('ruleFor maps numbered and temp folders to their base category', () => {
  assert.equal(ruleFor('MOVIES3').category, 'movies');
  assert.equal(ruleFor('ANIMES_TEMP').category, 'animes');
  assert.equal(ruleFor('SERIES').fileType, 'tv');
  assert.equal(ruleFor('FITNESS').dirType, null);
  assert.equal(ruleFor('').category, 'other');
});

test('scan builds file and folder items, skipping partial downloads and junk', async () => {
  const root = fixture();
  const items = await scanMediaRoot(root);
  const paths = items.map((i) => i.path).sort();
  assert.deepEqual(paths, [
    'FITNESS/Insanity',
    'KIDS/Peppa Pig',
    'MOVIES/Prometheus.2012.MULTi.1080p.mkv',
    'MOVIES2/Antz.avi',
    'SERIES/Fallout (2024) S01',
    'Spectacle_Starmania_20190424.HD.mov',
  ]);
  const fallout = items.find((i) => i.path.startsWith('SERIES'))!;
  assert.equal(fallout.mediaType, 'tv');
  assert.equal(fallout.files.length, 3);
  const extra = fallout.files.find((f) => f.path.includes('Featurettes'))!;
  assert.equal(extra.season, 0);
  const ep2 = fallout.files.find((f) => f.path.endsWith('E02.1080p.mkv'))!;
  assert.deepEqual([ep2.season, ep2.episode], [1, 2]);
  assert.equal(items.find((i) => i.path.startsWith('MOVIES/'))!.size, 100);
  rmSync(root, { recursive: true });
});

test('reconcile inserts, keeps metadata across moves, and flags removals', async () => {
  const root = fixture();
  const db = openDb(':memory:');
  const r1 = reconcile(db, await scanMediaRoot(root), 1000);
  assert.equal(r1.added.length, 6);
  const prom = db.prepare("SELECT * FROM items WHERE path LIKE 'MOVIES/Prom%'").get() as Record<string, unknown>;
  assert.equal(prom.parsed_title, 'Prometheus');
  assert.equal(prom.parsed_year, 2012);
  assert.equal(prom.match_state, 'pending');
  const fit = db.prepare("SELECT match_state FROM items WHERE path = 'FITNESS/Insanity'").get() as Record<string, unknown>;
  assert.equal(fit.match_state, 'none');

  // Pretend it got matched, then move it to another folder.
  db.prepare('UPDATE items SET tmdb_id = 70981, match_state = ? WHERE id = ?').run('matched', prom.id as number);
  mkdirSync(join(root, 'MOVIES3'));
  renameSync(join(root, 'MOVIES/Prometheus.2012.MULTi.1080p.mkv'), join(root, 'MOVIES3/Prometheus.2012.MULTi.1080p.mkv'));
  rmSync(join(root, 'MOVIES2/Antz.avi'));
  const r2 = reconcile(db, await scanMediaRoot(root), 2000);
  assert.deepEqual([r2.added.length, r2.moved, r2.removed], [0, 1, 1]);
  const moved = db.prepare('SELECT * FROM items WHERE id = ?').get(prom.id as number) as Record<string, unknown>;
  assert.equal(moved.path, 'MOVIES3/Prometheus.2012.MULTi.1080p.mkv');
  assert.equal(moved.tmdb_id, 70981);
  const antz = db.prepare("SELECT present FROM items WHERE path = 'MOVIES2/Antz.avi'").get() as Record<string, unknown>;
  assert.equal(antz.present, 0);

  // Rescan with no change is a no-op.
  const r3 = reconcile(db, await scanMediaRoot(root), 3000);
  assert.deepEqual([r3.added.length, r3.moved, r3.removed], [0, 0, 0]);
  rmSync(root, { recursive: true });
});

test('sheet import links hints and lists missing rows', async () => {
  const root = fixture();
  const db = openDb(':memory:');
  reconcile(db, await scanMediaRoot(root));
  const res = importSheetRows(db, [
    { tab: 'MOVIES', filename: 'Prometheus.2012.MULTi.1080p', titleEn: 'Prometheus', titleFr: 'Prometheus', year: 2012, folders: ['MOVIES'] },
    { tab: 'MOVIES', filename: '28.Days.Later.avi', titleEn: '28 Days Later', titleFr: '28 Jours plus tard', year: 2002, folders: [] },
    { tab: 'ANIMES', filename: 'Movie.srt', titleEn: 'X', folders: [] },
  ]);
  assert.deepEqual(res, { rows: 3, linked: 1, sheetOnly: 1 });
  const only = db.prepare("SELECT * FROM items WHERE source = 'sheet'").get() as Record<string, unknown>;
  assert.equal(only.sheet_fr, '28 Jours plus tard');
  assert.equal(only.present, 0);
  assert.equal(only.category, 'movies');
  // Re-import is idempotent.
  assert.equal(importSheetRows(db, [{ tab: 'MOVIES', filename: '28.Days.Later.avi', folders: [] }]).sheetOnly, 1);
  assert.equal((db.prepare("SELECT count(*) n FROM items WHERE source = 'sheet'").get() as { n: number }).n, 1);
  rmSync(root, { recursive: true });
});
