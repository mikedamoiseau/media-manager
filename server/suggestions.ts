import type { DB } from './db.ts';
import { MAIN_PROFILE } from './profiles.ts';
import type { Tmdb } from './tmdb.ts';

export interface Suggestion {
  /** item to suggest */
  id: number;
  /** the watched or started item that led to it */
  because: number;
  /** next: the following film of a set you started; like: TMDB recommends it for `because` */
  kind: 'next' | 'like';
}

const SEEDS = 12;
const LIMIT = 24;
const MAX_AGE = 30 * 24 * 3600 * 1000;
// Interest halves every two weeks, so what you did lately leads.
const HALF_LIFE = 14 * 24 * 3600 * 1000;
// A play says more than a trailer, a trailer more than opening a page.
const WEIGHT = { play: 1, trailer: 0.6, open: 0.3 } as const;
// The same event again within this time is the same visit (VLC asks for the file many times while seeking).
const REPEAT = { play: 30, trailer: 10, open: 10 } as const;
// The next film of a set beats a first-ranked recommendation.
const NEXT = 1.5;
// A film you liked says more than a play and fades four times slower.
const LIKE = 1.5;
const LIKE_HALF_LIFE = 4 * HALF_LIFE;
// What TMDB recommends alongside a film you didn't like loses as much as a top recommendation gains.
const DISLIKE = 1;

export type ActivityKind = keyof typeof WEIGHT;

export function rate(db: DB, type: string, tmdbId: number, value: 1 | -1 | null, now = Date.now()): void {
  if (value) db.prepare('INSERT INTO ratings (profile_id, media_type, tmdb_id, value, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(profile_id, media_type, tmdb_id) DO UPDATE SET value = excluded.value, at = excluded.at').run(MAIN_PROFILE, type, tmdbId, value, now);
  else db.prepare('DELETE FROM ratings WHERE media_type = ? AND tmdb_id = ?').run(type, tmdbId);
}

export function ratingOf(db: DB, type: string, tmdbId: number): 1 | -1 | null {
  return ((db.prepare('SELECT value FROM ratings WHERE media_type = ? AND tmdb_id = ?').get(type, tmdbId) as { value: 1 | -1 } | undefined)?.value) ?? null;
}

/** Points off, by "type:id", for what TMDB recommends alongside the films you didn't like (the latest ones). */
export async function dislikePenalties(db: DB, tmdb: Tmdb | null, now = Date.now()): Promise<Map<string, number>> {
  const rows = db.prepare(`SELECT media_type type, tmdb_id tmdb FROM ratings WHERE value = -1 ORDER BY at DESC LIMIT ${SEEDS}`).all() as Array<{ type: string; tmdb: number }>;
  const lists = await Promise.all(rows.map((r) => recommended(db, tmdb, r.type, r.tmdb, now)));
  const off = new Map<string, number>();
  rows.forEach((r, i) =>
    lists[i]!.slice(0, 20).forEach((id, rank) => {
      const k = `${r.type}:${id}`;
      off.set(k, (off.get(k) ?? 0) + DISLIKE * (1 - rank / 20));
    }),
  );
  return off;
}

export function recordActivity(db: DB, itemId: number, kind: ActivityKind, now = Date.now()): void {
  const recent = db.prepare('SELECT 1 FROM activity WHERE item_id = ? AND kind = ? AND at > ? AND at <= ?').get(itemId, kind, now - REPEAT[kind] * 60_000, now);
  if (!recent) db.prepare('INSERT INTO activity (profile_id, item_id, kind, at) VALUES (?, ?, ?, ?)').run(MAIN_PROFILE, itemId, kind, now);
}

export interface Row {
  id: number;
  type: string;
  tmdb: number;
  collection: string | null;
  year: number | null;
}

const SELECT = `SELECT i.id, i.media_type type, i.tmdb_id tmdb, t.collection, t.year
  FROM items i LEFT JOIN titles t ON t.media_type = i.media_type AND t.tmdb_id = i.tmdb_id`;

// Watched, started, or played from the app.
export const SEEN = `(i.last_played IS NOT NULL OR COALESCE(i.playcount, 0) > 0 OR COALESCE(i.resume, 0) > 0.02
  OR i.id IN (SELECT item_id FROM activity WHERE kind = 'play'))`;

export async function recommended(db: DB, tmdb: Tmdb | null, type: string, id: number, now: number): Promise<number[]> {
  const row = db.prepare('SELECT ids, fetched_at FROM recommendations WHERE media_type = ? AND tmdb_id = ?').get(type, id) as
    | { ids: string; fetched_at: number }
    | undefined;
  const cached = row ? (JSON.parse(row.ids) as number[]) : [];
  if ((row && now - row.fetched_at < MAX_AGE) || !tmdb) return cached;
  try {
    const ids = await tmdb.recommendations(type as 'movie' | 'tv', id);
    db.prepare(`INSERT INTO recommendations (media_type, tmdb_id, ids, fetched_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(media_type, tmdb_id) DO UPDATE SET ids = excluded.ids, fetched_at = excluded.fetched_at`).run(type, id, JSON.stringify(ids), now);
    return ids;
  } catch {
    return cached;
  }
}

/**
 * What interests you lately, strongest first: Kodi's history, what you do in the app and the films
 * you liked, fading with time. Films you didn't like are left out. Weights 0..1.
 */
export function tastes(db: DB, now = Date.now()): Array<{ row: Row; weight: number }> {
  const key = (r: { type: string; tmdb: number }) => `${r.type}:${r.tmdb}`;
  const interest = new Map<string, { row: Row; score: number }>();
  const note = (row: Row, weight: number, at: number, halfLife = HALF_LIFE) => {
    const points = weight * 0.5 ** (Math.max(0, now - at) / halfLife);
    const s = interest.get(key(row));
    if (s) s.score += points;
    else interest.set(key(row), { row, score: points });
  };
  // Kodi's last_played is local time, "YYYY-MM-DD HH:MM:SS".
  for (const r of db.prepare(`SELECT i.id, i.media_type type, i.tmdb_id tmdb, t.collection, t.year, i.last_played at
      FROM items i LEFT JOIN titles t ON t.media_type = i.media_type AND t.tmdb_id = i.tmdb_id
      WHERE i.last_played IS NOT NULL AND i.tmdb_id IS NOT NULL`).all() as unknown as Array<Row & { at: string }>) {
    note(r, WEIGHT.play, Date.parse(r.at.replace(' ', 'T')) || 0);
  }
  for (const r of db.prepare(`SELECT i.id, i.media_type type, i.tmdb_id tmdb, t.collection, t.year, a.kind, a.at
      FROM activity a JOIN items i ON i.id = a.item_id LEFT JOIN titles t ON t.media_type = i.media_type AND t.tmdb_id = i.tmdb_id
      WHERE i.tmdb_id IS NOT NULL`).all() as unknown as Array<Row & { kind: ActivityKind; at: number }>) {
    note(r, WEIGHT[r.kind] ?? 0, r.at);
  }
  for (const r of db.prepare(`SELECT min(i.id) id, r.media_type type, r.tmdb_id tmdb, t.collection, t.year, r.value, r.at
      FROM ratings r JOIN items i ON i.media_type = r.media_type AND i.tmdb_id = r.tmdb_id
      LEFT JOIN titles t ON t.media_type = r.media_type AND t.tmdb_id = r.tmdb_id
      GROUP BY r.media_type, r.tmdb_id`).all() as unknown as Array<Row & { value: number; at: number }>) {
    if (r.value > 0) note(r, LIKE, r.at, LIKE_HALF_LIFE);
    else interest.delete(key(r));
  }
  const top = [...interest.values()].sort((a, b) => b.score - a.score).slice(0, SEEDS);
  return top.map((s) => ({ row: s.row, weight: s.score / (top[0]?.score || 1) }));
}

/**
 * Titles on the NAS you haven't watched or started, from what interests you lately. For each of
 * those: the next film of its set, and what TMDB recommends for it.
 */
export async function suggestions(db: DB, tmdb: Tmdb | null, now = Date.now()): Promise<Suggestion[]> {
  const key = (r: { type: string; tmdb: number }) => `${r.type}:${r.tmdb}`;
  const top = tastes(db, now);
  const seeds = top.map((s) => s.row);
  const weights = top.map((s) => s.weight);

  // A title is out as soon as any copy of it was seen.
  const seen = new Set((db.prepare(`${SELECT} WHERE i.tmdb_id IS NOT NULL AND ${SEEN}`).all() as unknown as Row[]).map(key));
  const candidates = new Map<string, Row>();
  for (const r of db.prepare(`${SELECT} WHERE i.present = 1 AND i.hidden = 0 AND i.tmdb_id IS NOT NULL ORDER BY i.id`).all() as unknown as Row[]) {
    if (!seen.has(key(r)) && !candidates.has(key(r))) candidates.set(key(r), r);
  }

  // One film stands for each set, so a set never fills the row with every part (or the wrong one
  // first): the one after the latest you saw, else (you saw the last) the earliest you haven't seen.
  const lastSeen = new Map(
    (db.prepare(`SELECT t.collection, max(t.year) year FROM items i JOIN titles t ON t.media_type = i.media_type AND t.tmdb_id = i.tmdb_id
      WHERE t.collection IS NOT NULL AND ${SEEN} GROUP BY t.collection`).all() as Array<{ collection: string; year: number | null }>).map((r) => [r.collection, r.year ?? 0]),
  );
  const parts = new Map<string, Row[]>();
  for (const c of candidates.values()) {
    if (c.type !== 'movie' || !c.collection) continue;
    const list = parts.get(c.collection);
    if (list) list.push(c);
    else parts.set(c.collection, [c]);
  }
  const standIn = new Map<string, Row>();
  for (const [set, films] of parts) {
    films.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999));
    const after = lastSeen.get(set);
    standIn.set(set, (after !== undefined && films.find((f) => (f.year ?? 0) >= after)) || films[0]!);
  }
  const stand = (c: Row) => (c.type === 'movie' && c.collection && standIn.get(c.collection)) || c;

  const lists = await Promise.all(seeds.map((s) => recommended(db, tmdb, s.type, s.tmdb, now)));
  const scores = new Map<string, { score: number; best: number; because: number; kind: Suggestion['kind'] }>();
  const add = (k: string, points: number, because: number, kind: Suggestion['kind']) => {
    const s = scores.get(k) ?? { score: 0, best: -1, because, kind };
    s.score += points;
    if (points > s.best) Object.assign(s, { best: points, because, kind });
    scores.set(k, s);
  };
  seeds.forEach((seed, i) => {
    const w = weights[i]!;
    const next = seed.type === 'movie' && seed.collection ? standIn.get(seed.collection) : undefined;
    if (next) add(key(next), NEXT * w, seed.id, 'next');
    lists[i]!.slice(0, 20).forEach((id, rank) => {
      const c = candidates.get(key({ type: seed.type, tmdb: id }));
      if (c) add(key(stand(c)), w * (1 - rank / 20), seed.id, 'like');
    });
  });
  const off = await dislikePenalties(db, tmdb, now);
  for (const [k, s] of scores) s.score -= off.get(k) ?? 0;
  return [...scores.entries()]
    .filter(([, s]) => s.score > 0)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, LIMIT)
    .map(([k, s]) => ({ id: candidates.get(k)!.id, because: s.because, kind: s.kind }));
}
