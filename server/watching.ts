import type { DB } from './db.ts';

// Past this the end credits are rolling: watched (Kodi's own default is 90%).
export const FINISHED = 0.9;
const STARTED = 0.02;
// Not resumed for this long: no longer "continue watching".
const STALE = 90 * 24 * 3600 * 1000;
// Shorter reads are VLC looking at the file (headers, the index at the end), not playing it.
const MIN_STREAM = 8 * 1024 * 1024;

export interface Watching {
  id: number;
  fraction: number;
  /** where the latest progress was made: Kodi on the TV, or VLC on the phone */
  where: 'tv' | 'phone';
  at: number;
}

/**
 * How far VLC got, from what the server sent it: VLC reads the file as it plays, so the end of the
 * last long read is about where playback stopped.
 */
export function noteStreamed(db: DB, itemId: number, start: number, sent: number, size: number, now = Date.now()): void {
  if (sent < MIN_STREAM || !size) return;
  db.prepare(`INSERT INTO watching (item_id, fraction, played_at) VALUES (?, ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET fraction = excluded.fraction, played_at = excluded.played_at`).run(itemId, Math.min(1, (start + sent) / size), now);
}

/** Removed by hand; it comes back once played again. Kodi's own resume point is left alone. */
export function dismissWatching(db: DB, itemId: number, now = Date.now()): void {
  db.prepare(`INSERT INTO watching (item_id, dismissed_at) VALUES (?, ?)
    ON CONFLICT(item_id) DO UPDATE SET dismissed_at = excluded.dismissed_at`).run(itemId, now);
}

/** Films started and not finished, latest first: Kodi's resume point or VLC's progress, whichever is newer. */
export function continueWatching(db: DB, now = Date.now()): Watching[] {
  const rows = db.prepare(`SELECT i.id, i.media_type type, i.tmdb_id tmdb, i.resume, i.last_played, w.fraction, w.played_at, w.dismissed_at
    FROM items i LEFT JOIN watching w ON w.item_id = i.id
    WHERE i.present = 1 AND i.hidden = 0 AND i.is_dir = 0 AND (i.last_played IS NOT NULL OR w.played_at IS NOT NULL)`).all() as Array<{
    id: number; type: string | null; tmdb: number | null; resume: number | null; last_played: string | null;
    fraction: number | null; played_at: number | null; dismissed_at: number | null;
  }>;
  const best = new Map<string, Watching>();
  for (const r of rows) {
    // Kodi's last_played is local time, "YYYY-MM-DD HH:MM:SS".
    const tv: Watching | null = r.last_played ? { id: r.id, fraction: r.resume ?? 0, where: 'tv', at: Date.parse(r.last_played.replace(' ', 'T')) || 0 } : null;
    const phone: Watching | null = r.played_at ? { id: r.id, fraction: r.fraction ?? 0, where: 'phone', at: r.played_at } : null;
    const latest = tv && phone ? (phone.at > tv.at ? phone : tv) : (tv ?? phone);
    if (!latest || latest.fraction <= STARTED || latest.fraction >= FINISHED) continue;
    if (r.dismissed_at && r.dismissed_at >= latest.at) continue;
    if (now - latest.at > STALE) continue;
    // Several copies of a film: the one watched last.
    const key = r.tmdb ? `${r.type}:${r.tmdb}` : `i:${r.id}`;
    if ((best.get(key)?.at ?? -1) < latest.at) best.set(key, latest);
  }
  return [...best.values()].sort((a, b) => b.at - a.at);
}
