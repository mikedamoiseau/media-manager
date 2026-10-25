import { type DB, tx } from './db.ts';
import { parseName, SUB_EXT, PARTIAL_EXT, extOf } from './parse.ts';
import { type ScannedItem, ruleFor } from './scanner.ts';
import { type SheetRow, fileKey } from './sheet.ts';

export interface ReconcileResult {
  added: number[];
  removed: number;
  moved: number;
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

interface ExistingRow {
  id: number;
  path: string;
  present: number;
}

/** Merge a scan into the database. New items get parsed and queued for matching; vanished ones are flagged, not deleted. */
export function reconcile(db: DB, scanned: ScannedItem[], now = Date.now()): ReconcileResult {
  const existing = db.prepare("SELECT id, path, present FROM items WHERE source = 'disk'").all() as unknown as ExistingRow[];
  const byPath = new Map(existing.map((r) => [r.path, r]));
  const scannedPaths = new Set(scanned.map((s) => s.path));

  // Vanished items, keyed by file name, so a rename/move across folders keeps its metadata.
  const vanished = new Map<string, ExistingRow>();
  for (const r of existing) if (!scannedPaths.has(r.path)) vanished.set(basename(r.path).toLowerCase(), r);

  const insert = db.prepare(`INSERT INTO items (path, folder, category, is_dir, present, source, size, mtime, file_count,
      parsed_title, parsed_year, alt_titles, quality, media_type, match_state, added_at, updated_at)
    VALUES (?, ?, ?, ?, 1, 'disk', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const touch = db.prepare(`UPDATE items SET present = 1, file_count = ?, size = COALESCE(?, size), mtime = COALESCE(?, mtime),
      updated_at = CASE WHEN present = 0 THEN ? ELSE updated_at END WHERE id = ?`);
  // A move into another category can turn a "never match" item (FITNESS) into one to match (MOVIES) and back.
  const move = db.prepare(`UPDATE items SET path = ?1, folder = ?2, category = ?3, present = 1, updated_at = ?4,
      media_type = COALESCE(media_type, ?5),
      match_state = CASE
        WHEN match_source = 'manual' THEN match_state
        WHEN ?5 IS NULL AND tmdb_id IS NULL THEN 'none'
        WHEN match_state = 'none' AND ?5 IS NOT NULL THEN 'pending'
        ELSE match_state END
    WHERE id = ?6`);
  const dirSize = db.prepare('UPDATE items SET size = (SELECT sum(size) FROM episodes WHERE item_id = ?1) WHERE id = ?1');
  const markGone = db.prepare('UPDATE items SET present = 0, updated_at = ? WHERE id = ? AND present = 1');
  const epExisting = db.prepare('SELECT path FROM episodes WHERE item_id = ?');
  const epInsert = db.prepare('INSERT INTO episodes (item_id, path, size, season, episode, title) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET item_id = excluded.item_id, present = 1');
  const epDelete = db.prepare('DELETE FROM episodes WHERE path = ?');

  const result: ReconcileResult = { added: [], removed: 0, moved: 0 };

  tx(db, () => {
    for (const s of scanned) {
      // Folder sizes are summed from the episodes table below (the scan only stats new files).
      const totalSize = s.isDir ? undefined : s.size;
      // A folder counts as added when its newest file arrived.
      const mtime = s.isDir ? Math.max(0, ...s.files.map((f) => f.mtime ?? 0)) || undefined : s.mtime;
      const fileCount = s.isDir ? s.files.length : 1;
      let row = byPath.get(s.path);
      if (!row) {
        const prev = vanished.get(basename(s.path).toLowerCase());
        if (prev) {
          vanished.delete(basename(s.path).toLowerCase());
          move.run(s.path, s.folder, s.category, now, s.mediaType, prev.id);
          row = { ...prev, path: s.path, present: 1 };
          result.moved++;
        }
      }
      let id: number;
      if (row) {
        touch.run(fileCount, totalSize ?? null, mtime ?? null, now, row.id);
        id = row.id;
      } else {
        const p = parseName(basename(s.path), { isDir: s.isDir });
        const r = insert.run(
          s.path, s.folder, s.category, s.isDir ? 1 : 0, totalSize ?? null, mtime ?? null, fileCount,
          p.title, p.year ?? null, JSON.stringify(p.altTitles), JSON.stringify(p.quality),
          s.mediaType, s.mediaType ? 'pending' : 'none', mtime ?? now, now,
        );
        id = Number(r.lastInsertRowid);
        result.added.push(id);
      }
      if (s.isDir) {
        const have = new Set((epExisting.all(id) as Array<{ path: string }>).map((e) => e.path));
        for (const f of s.files) {
          if (have.has(f.path)) have.delete(f.path);
          else epInsert.run(id, f.path, f.size ?? null, f.season ?? null, f.episode ?? null, f.title ?? null);
        }
        for (const gone of have) epDelete.run(gone);
        dirSize.run(id);
      }
    }
    for (const r of vanished.values()) if (r.present && markGone.run(now, r.id).changes) result.removed++;
  });
  return result;
}

/** Store sheet rows, attach their titles to matching files, and list rows with no file as "not on disk" entries. */
export function importSheetRows(db: DB, rows: SheetRow[], now = Date.now()): { rows: number; linked: number; sheetOnly: number } {
  return tx(db, () => {
    db.exec('DELETE FROM sheet_rows');
    const ins = db.prepare('INSERT INTO sheet_rows (tab, filename, key, title_en, title_fr, year, folders) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const r of rows) ins.run(r.tab, r.filename, fileKey(r.filename), r.titleEn ?? null, r.titleFr ?? null, r.year ?? null, JSON.stringify(r.folders));
    const linked = applySheetHints(db);
    const sheetOnly = syncSheetOnlyItems(db, now);
    return { rows: rows.length, linked, sheetOnly };
  });
}

interface SheetHint {
  key: string;
  tab: string;
  filename: string;
  title_en: string | null;
  title_fr: string | null;
  year: number | null;
}

function sheetIndex(db: DB): Map<string, SheetHint> {
  const rows = db.prepare('SELECT key, tab, filename, title_en, title_fr, year FROM sheet_rows ORDER BY (title_en IS NULL), id').all() as unknown as SheetHint[];
  const map = new Map<string, SheetHint>();
  for (const r of rows) if (!map.has(r.key)) map.set(r.key, r);
  return map;
}

/** Copy sheet titles/year onto disk items with the same file name. Returns how many items got a hint. */
export function applySheetHints(db: DB): number {
  const idx = sheetIndex(db);
  if (!idx.size) return 0;
  const items = db.prepare("SELECT id, path FROM items WHERE source = 'disk'").all() as Array<{ id: number; path: string }>;
  const upd = db.prepare(`UPDATE items SET sheet_en = ?1, sheet_fr = ?2, sheet_year = ?3, updated_at = ?5
    WHERE id = ?4 AND (sheet_en IS NOT ?1 OR sheet_fr IS NOT ?2 OR sheet_year IS NOT ?3)`);
  const now = Date.now();
  let n = 0;
  for (const it of items) {
    const h = idx.get(fileKey(basename(it.path)));
    if (!h) continue;
    upd.run(h.title_en, h.title_fr, h.year, it.id, now);
    n++;
  }
  return n;
}

/** Sheet rows without a file on disk become hidden-by-default "not on disk" items. */
export function syncSheetOnlyItems(db: DB, now = Date.now()): number {
  const diskKeys = new Set(
    (db.prepare("SELECT path FROM items WHERE source = 'disk'").all() as Array<{ path: string }>).map((r) => fileKey(basename(r.path))),
  );
  const wanted = new Map<string, SheetHint>();
  for (const h of sheetIndex(db).values()) {
    const ext = extOf(h.filename);
    if (SUB_EXT.has(ext) || PARTIAL_EXT.has(ext) || diskKeys.has(h.key)) continue;
    wanted.set(`sheet:${h.tab}:${h.filename}`, h);
  }
  const total = wanted.size;
  const current = db.prepare("SELECT id, path FROM items WHERE source = 'sheet'").all() as Array<{ id: number; path: string }>;
  const del = db.prepare('DELETE FROM items WHERE id = ?');
  for (const c of current) {
    if (wanted.has(c.path)) wanted.delete(c.path);
    else del.run(c.id);
  }
  const ins = db.prepare(`INSERT INTO items (path, folder, category, is_dir, present, source, parsed_title, parsed_year, alt_titles, quality,
      sheet_en, sheet_fr, sheet_year, media_type, match_state, added_at, updated_at)
    VALUES (?, ?, ?, 0, 0, 'sheet', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [path, h] of wanted) {
    const rule = ruleFor(h.tab);
    const p = parseName(h.filename, { isDir: !/\.[a-z0-9]{2,4}$/i.test(h.filename) });
    const type = rule.fileType;
    ins.run(path, h.tab, rule.category, p.title, p.year ?? null, JSON.stringify(p.altTitles), JSON.stringify(p.quality),
      h.title_en, h.title_fr, h.year, type, type ? 'pending' : 'none', now, now);
  }
  return total;
}
