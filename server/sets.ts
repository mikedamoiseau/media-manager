import type { DB } from './db.ts';
import type { CollectionPart, Tmdb } from './tmdb.ts';

// New parts get announced and release dates move; a week is fresh enough.
const MAX_AGE = 7 * 24 * 3600 * 1000;

/**
 * Every film of a set (TMDB collection), owned or not. Titles only store the collection's name,
 * so the collection id comes from one member film the first time, then the list is cached.
 */
export async function setParts(db: DB, tmdb: Tmdb, key: string, now = Date.now()): Promise<CollectionPart[]> {
  const cached = db.prepare('SELECT tmdb_id, parts, fetched_at FROM collections WHERE key = ?').get(key) as
    | { tmdb_id: number | null; parts: string; fetched_at: number }
    | undefined;
  if (cached && now - cached.fetched_at < MAX_AGE) return JSON.parse(cached.parts) as CollectionPart[];
  try {
    let id = cached?.tmdb_id ?? undefined;
    if (!id) {
      const member = db.prepare(`SELECT tmdb_id FROM titles WHERE collection = ? AND media_type = 'movie' LIMIT 1`).get(key) as
        | { tmdb_id: number }
        | undefined;
      if (!member) return [];
      id = await tmdb.collectionOf(member.tmdb_id);
    }
    const parts = id ? await tmdb.collectionParts(id) : [];
    db.prepare(`INSERT INTO collections (key, tmdb_id, parts, fetched_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET tmdb_id = excluded.tmdb_id, parts = excluded.parts, fetched_at = excluded.fetched_at`).run(
      key, id ?? null, JSON.stringify(parts), now,
    );
    return parts;
  } catch (e) {
    if (cached) return JSON.parse(cached.parts) as CollectionPart[];
    throw e;
  }
}

/** Sets with a film on the NAS (hidden ones aside), by name. */
export function ownedSetKeys(db: DB): string[] {
  const rows = db.prepare(`SELECT DISTINCT t.collection AS k FROM items i JOIN titles t ON t.media_type = i.media_type AND t.tmdb_id = i.tmdb_id
    WHERE i.present = 1 AND i.hidden = 0 AND i.media_type = 'movie' AND t.collection IS NOT NULL ORDER BY t.collection`).all() as Array<{ k: string }>;
  return rows.map((r) => r.k);
}

/** Of these sets, the ones whose film list was never fetched from TMDB or is over a week old. */
export function staleSetKeys(db: DB, keys: string[], now = Date.now()): string[] {
  const fresh = db.prepare('SELECT key FROM collections WHERE fetched_at > ?').all(now - MAX_AGE) as Array<{ key: string }>;
  const known = new Set(fresh.map((r) => r.key));
  return keys.filter((k) => !known.has(k));
}
