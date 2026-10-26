import type { DB } from './db.ts';
import { MAIN_PROFILE } from './profiles.ts';

// Past this the end credits are rolling: watched (Kodi's own default is 90%).
export const FINISHED = 0.9;
const STARTED = 0.02;
// Not resumed for this long: no longer "continue watching".
const STALE = 90 * 24 * 3600 * 1000;
// Shorter reads are VLC looking at the file (headers, the index at the end), not playing it.
const MIN_STREAM = 8 * 1024 * 1024;

export interface Watching {
  id: number;
  /** how far into the film, or into the episode in progress (0: the next one, not started) */
  fraction: number;
  /** where the latest progress was made: Kodi on the TV, or VLC on the phone */
  where: 'tv' | 'phone';
  at: number;
  /** a series: the episode to go on with, and how many of its episodes (extras aside) were watched */
  episode?: { id: number; season: number | null; episode: number | null; title: string | null };
  seen?: { watched: number; total: number };
}

export interface EpisodeRow {
  id: number;
  path: string;
  kodi_id: number | null;
  season: number | null;
  episode: number | null;
  title: string | null;
  playcount: number | null;
  resume: number | null;
  last_played: string | null;
  streamed: number | null;
  streamed_at: number | null;
}

type Progress = { fraction: number; where: 'tv' | 'phone'; at: number };

// Kodi's last_played is local time, "YYYY-MM-DD HH:MM:SS".
const kodiTime = (s: string) => Date.parse(s.replace(' ', 'T')) || 0;

/** In order: seasons, then extras (season 0), then loose files. */
export function episodesOf(db: DB, itemId: number): EpisodeRow[] {
  return db.prepare(`SELECT id, path, kodi_id, season, episode, title, playcount, resume, last_played, streamed, streamed_at
    FROM episodes WHERE item_id = ? ORDER BY season IS NULL, season = 0, season, episode IS NULL, episode, path`).all(itemId) as unknown as EpisodeRow[];
}

/** The latest progress on an episode: on Kodi (played to the end: a play and no resume point) or in VLC. */
function progressOf(e: EpisodeRow): Progress | null {
  const tvFraction = (e.resume ?? 0) > STARTED ? e.resume! : (e.playcount ?? 0) > 0 ? 1 : 0;
  const tv: Progress | null = e.last_played ? { fraction: tvFraction, where: 'tv', at: kodiTime(e.last_played) } : null;
  const phone: Progress | null = e.streamed_at ? { fraction: e.streamed ?? 0, where: 'phone', at: e.streamed_at } : null;
  return tv && phone ? (phone.at > tv.at ? phone : tv) : (tv ?? phone);
}

/** Played to the end once, on either device: on Kodi (a play, or stopped in the credits) or in VLC. */
export const watchedEpisode = (e: Pick<EpisodeRow, 'playcount' | 'resume' | 'streamed'>) =>
  (e.playcount ?? 0) > 0 || (e.resume ?? 0) >= FINISHED || (e.streamed ?? 0) >= FINISHED;
const inProgress = (p: Progress | null | undefined): p is Progress => !!p && p.fraction > STARTED && p.fraction < FINISHED;

/**
 * Where a series stands, extras (season 0) aside: the episode played last, the one to go on with, and
 * how many were watched. Going on: the episode played last when it isn't finished (started, or only
 * opened), else the first unwatched one after it; none after it: caught up. Nothing played: the first.
 */
function seriesState(eps: EpisodeRow[]) {
  const main = eps.filter((e) => e.season !== 0);
  let latest: { e: EpisodeRow; p: Progress } | undefined;
  for (const e of main) {
    const p = progressOf(e);
    if (p && (!latest || p.at > latest.p.at)) latest = { e, p };
  }
  const next = !latest
    ? main.find((e) => !watchedEpisode(e))
    : inProgress(latest.p) || !watchedEpisode(latest.e)
      ? latest.e
      : main.slice(main.indexOf(latest.e) + 1).find((e) => !watchedEpisode(e));
  return { latest, next, watched: main.filter(watchedEpisode).length, total: main.length };
}

/** The episode Play (on the TV or in VLC) starts: where the series stands, else an extra not seen, else the first. */
export function nextEpisode(db: DB, itemId: number): EpisodeRow | undefined {
  const eps = episodesOf(db, itemId);
  return seriesState(eps).next ?? eps.find((e) => !watchedEpisode(e)) ?? eps[0];
}

/** How far VLC got into an episode, as for films (see noteStreamed). */
export function noteEpisodeStreamed(db: DB, episodeId: number, start: number, sent: number, size: number, now = Date.now()): void {
  if (sent < MIN_STREAM || !size) return;
  db.prepare('UPDATE episodes SET streamed = ?, streamed_at = ? WHERE id = ?').run(Math.min(1, (start + sent) / size), now, episodeId);
}

/**
 * How far VLC got, from what the server sent it: VLC reads the file as it plays, so the end of the
 * last long read is about where playback stopped.
 */
export function noteStreamed(db: DB, itemId: number, start: number, sent: number, size: number, now = Date.now()): void {
  if (sent < MIN_STREAM || !size) return;
  db.prepare(`INSERT INTO watching (profile_id, item_id, fraction, played_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(profile_id, item_id) DO UPDATE SET fraction = excluded.fraction, played_at = excluded.played_at`).run(MAIN_PROFILE, itemId, Math.min(1, (start + sent) / size), now);
}

/** Removed by hand; it comes back once played again. Kodi's own resume point is left alone. */
export function dismissWatching(db: DB, itemId: number, now = Date.now()): void {
  db.prepare(`INSERT INTO watching (profile_id, item_id, dismissed_at) VALUES (?, ?, ?)
    ON CONFLICT(profile_id, item_id) DO UPDATE SET dismissed_at = excluded.dismissed_at`).run(MAIN_PROFILE, itemId, now);
}

/**
 * Films started and not finished (Kodi's resume point or VLC's progress, whichever is newer), and series
 * with episodes left after the latest one played. Latest first.
 */
export function continueWatching(db: DB, now = Date.now()): Watching[] {
  const rows = db.prepare(`SELECT i.id, i.media_type type, i.tmdb_id tmdb, i.resume, i.last_played, w.fraction, w.played_at, w.dismissed_at
    FROM items i LEFT JOIN watching w ON w.item_id = i.id
    WHERE i.present = 1 AND i.hidden = 0 AND i.is_dir = 0 AND (i.last_played IS NOT NULL OR w.played_at IS NOT NULL)`).all() as Array<{
    id: number; type: string | null; tmdb: number | null; resume: number | null; last_played: string | null;
    fraction: number | null; played_at: number | null; dismissed_at: number | null;
  }>;
  const best = new Map<string, Watching>();
  for (const r of rows) {
    const tv: Watching | null = r.last_played ? { id: r.id, fraction: r.resume ?? 0, where: 'tv', at: kodiTime(r.last_played) } : null;
    const phone: Watching | null = r.played_at ? { id: r.id, fraction: r.fraction ?? 0, where: 'phone', at: r.played_at } : null;
    const latest = tv && phone ? (phone.at > tv.at ? phone : tv) : (tv ?? phone);
    if (!latest || latest.fraction <= STARTED || latest.fraction >= FINISHED) continue;
    if (r.dismissed_at && r.dismissed_at >= latest.at) continue;
    if (now - latest.at > STALE) continue;
    // Several copies of a film: the one watched last.
    const key = r.tmdb ? `${r.type}:${r.tmdb}` : `i:${r.id}`;
    if ((best.get(key)?.at ?? -1) < latest.at) best.set(key, latest);
  }
  const shows = db.prepare(`SELECT i.id, i.media_type type, i.tmdb_id tmdb, w.dismissed_at FROM items i LEFT JOIN watching w ON w.item_id = i.id
    WHERE i.present = 1 AND i.hidden = 0 AND i.is_dir = 1
      AND EXISTS (SELECT 1 FROM episodes e WHERE e.item_id = i.id AND (e.last_played IS NOT NULL OR e.streamed_at IS NOT NULL))`).all() as Array<{
    id: number; type: string | null; tmdb: number | null; dismissed_at: number | null;
  }>;
  for (const r of shows) {
    const s = seriesState(episodesOf(db, r.id));
    // Like a film barely started: only opened, nothing watched, isn't "continue watching".
    if (!s.latest || !s.next || (s.watched === 0 && !inProgress(s.latest.p))) continue;
    const { p } = s.latest;
    if ((r.dismissed_at && r.dismissed_at >= p.at) || now - p.at > STALE) continue;
    const n = s.next;
    const w: Watching = {
      id: r.id,
      fraction: n === s.latest.e && inProgress(p) ? p.fraction : 0,
      where: p.where,
      at: p.at,
      episode: { id: n.id, season: n.season, episode: n.episode, title: n.title },
      seen: { watched: s.watched, total: s.total },
    };
    const key = r.tmdb ? `${r.type}:${r.tmdb}` : `i:${r.id}`;
    if ((best.get(key)?.at ?? -1) < w.at) best.set(key, w);
  }
  return [...best.values()].sort((a, b) => b.at - a.at);
}
