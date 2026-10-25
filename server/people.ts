import type { DB } from './db.ts';
import { normalize } from './parse.ts';

export interface Person {
  name: string;
  /** titles the library shows by default (on the NAS, not hidden) */
  n: number;
}

/**
 * Everyone in the titles of the library: the listed cast (up to 12 from TMDB) and the directors (a
 * series' creators). For each, the titles as library group keys ("movie:949"), with every status so the
 * filter works with them all, and how many the library shows by default.
 */
export function peopleIndex(db: DB): Map<string, { g: Set<string>; n: number; k: string }> {
  const rows = db
    .prepare(
      `SELECT i.media_type, i.tmdb_id, max(i.present = 1 AND i.hidden = 0) shown, t.cast_json, t.directors
       FROM items i JOIN titles t ON t.media_type = i.media_type AND t.tmdb_id = i.tmdb_id
       GROUP BY i.media_type, i.tmdb_id`,
    )
    .all() as Array<{ media_type: string; tmdb_id: number; shown: number; cast_json: string | null; directors: string | null }>;
  const index = new Map<string, { g: Set<string>; n: number; k: string }>();
  for (const r of rows) {
    const names = new Set([
      ...(r.cast_json ? (JSON.parse(r.cast_json) as Array<{ name: string }>).map((c) => c.name) : []),
      ...(r.directors ? (JSON.parse(r.directors) as string[]) : []),
    ]);
    for (const name of names) {
      let p = index.get(name);
      // k: the name as searched, normalized once
      if (!p) index.set(name, (p = { g: new Set(), n: 0, k: normalize(name) }));
      p.g.add(`${r.media_type}:${r.tmdb_id}`);
      if (r.shown) p.n++;
    }
  }
  return index;
}

/** People with a title the library shows, the most titles first; `q`: every word in the name, accents or not. */
export function findPeople(index: Map<string, { n: number; k: string }>, q: string, limit = 30): Person[] {
  const words = normalize(q).split(' ').filter(Boolean);
  const out: Person[] = [];
  for (const [name, p] of index) {
    if (!p.n) continue;
    if (words.length && !words.every((w) => p.k.includes(w))) continue;
    out.push({ name, n: p.n });
  }
  return out.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, limit);
}
