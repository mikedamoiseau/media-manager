import type { DB } from './db.ts';
import type { CollectionPart } from './tmdb.ts';
import { badges } from './views.ts';
import { ownedSetKeys } from './sets.ts';

/** Films with more than one copy on the NAS, biggest copy first. Hidden copies count: they still take space. */
export function duplicateFilms(db: DB) {
  const rows = db.prepare(`SELECT id, path, size, quality, hidden, playcount, tmdb_id FROM items
    WHERE present = 1 AND media_type = 'movie' AND tmdb_id IN (
      SELECT tmdb_id FROM items WHERE present = 1 AND media_type = 'movie' AND tmdb_id IS NOT NULL GROUP BY tmdb_id HAVING count(*) > 1)
    ORDER BY tmdb_id, size DESC`).all() as Array<{
    id: number; path: string; size: number | null; quality: string | null; hidden: number; playcount: number | null; tmdb_id: number;
  }>;
  const films = new Map<number, { tmdbId: number; copies: Array<{ id: number; path: string; size: number | null; quality: string[]; hidden: boolean; watched: boolean }> }>();
  for (const r of rows) {
    let film = films.get(r.tmdb_id);
    if (!film) films.set(r.tmdb_id, (film = { tmdbId: r.tmdb_id, copies: [] }));
    film.copies.push({ id: r.id, path: r.path, size: r.size, quality: badges(r.quality), hidden: !!r.hidden, watched: (r.playcount ?? 0) > 0 });
  }
  return [...films.values()];
}

/** Sets with a film on the NAS that lack a released film, judged from the film lists already fetched from TMDB. */
export function incompleteSets(db: DB, today = new Date().toISOString().slice(0, 10)) {
  const rows = db.prepare(`SELECT DISTINCT tmdb_id FROM items WHERE present = 1 AND hidden = 0 AND media_type = 'movie' AND tmdb_id IS NOT NULL`).all() as Array<{ tmdb_id: number }>;
  const owned = new Set(rows.map((r) => r.tmdb_id));
  const cached = db.prepare('SELECT parts FROM collections WHERE key = ?');
  const sets: Array<{ key: string; onNas: number; released: number; missing: Array<Omit<CollectionPart, 'poster'>> }> = [];
  for (const key of ownedSetKeys(db)) {
    const row = cached.get(key) as { parts: string } | undefined;
    if (!row) continue;
    const released = (JSON.parse(row.parts) as CollectionPart[]).filter((p) => p.date && p.date <= today);
    const missing = released.filter((p) => !owned.has(p.id));
    if (missing.length) {
      sets.push({ key, onNas: released.length - missing.length, released: released.length, missing: missing.map((p) => ({ id: p.id, fr: p.fr, en: p.en, o: p.o, date: p.date })) });
    }
  }
  return sets;
}
