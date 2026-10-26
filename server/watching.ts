import type { DB } from './db.ts';
import { MAIN_PROFILE } from './profiles.ts';

// Past this the end credits are rolling: watched (Kodi's own default is 90%).
export const FINISHED = 0.9;
export const STARTED = 0.02;
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
export const kodiTime = (s: string) => Date.parse(s.replace(' ', 'T')) || 0;

/** In order: seasons, then extras (season 0), then loose files. With this profile's progress on each. */
export function episodesOf(db: DB, itemId: number, profileId: number): EpisodeRow[] {
  return db.prepare(`SELECT e.id, e.path, e.kodi_id, e.season, e.episode, e.title, s.playcount, s.resume, s.last_played, s.streamed, s.streamed_at
    FROM episodes e LEFT JOIN episode_states s ON s.episode_id = e.id AND s.profile_id = ?
    WHERE e.item_id = ? ORDER BY e.season IS NULL, e.season = 0, e.season, e.episode IS NULL, e.episode, e.path`).all(profileId, itemId) as unknown as EpisodeRow[];
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
export function seriesState(eps: EpisodeRow[]) {
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

/** The episode Play (on the TV or in VLC) starts: where the series stands for this profile, else an extra not seen, else the first. */
export function nextEpisode(db: DB, itemId: number, profileId: number): EpisodeRow | undefined {
  const eps = episodesOf(db, itemId, profileId);
  return seriesState(eps).next ?? eps.find((e) => !watchedEpisode(e)) ?? eps[0];
}

/**
 * Where this profile's Play on TV starts: Kodi's own resume point (true) when it is theirs; else, as
 * Kodi's percentage, their latest progress (on a TV or in VLC) when started and not finished; else from
 * the start (false).
 */
export function startPoint(db: DB, profileId: number, target: { itemId: number } | { episodeId: number }): boolean | number {
  let latest: Progress | null;
  let claim: { profile_id: number; at: number; used_at: number | null } | undefined;
  if ('itemId' in target) {
    const r = db.prepare(`SELECT f.resume, f.last_played, w.fraction, w.played_at FROM items i
      LEFT JOIN film_states f ON f.item_id = i.id AND f.profile_id = ?1 LEFT JOIN watching w ON w.item_id = i.id AND w.profile_id = ?1
      WHERE i.id = ?2`).get(profileId, target.itemId) as { resume: number | null; last_played: string | null; fraction: number | null; played_at: number | null } | undefined;
    if (!r) return false;
    const tv: Progress | null = r.last_played || r.resume ? { fraction: r.resume ?? 0, where: 'tv', at: r.last_played ? kodiTime(r.last_played) : 0 } : null;
    const phone: Progress | null = r.played_at ? { fraction: r.fraction ?? 0, where: 'phone', at: r.played_at } : null;
    latest = tv && phone ? (phone.at > tv.at ? phone : tv) : (tv ?? phone);
    claim = db.prepare(`SELECT p.profile_id, p.at, p.used_at FROM items i JOIN tv_plays p ON p.kodi_type = 'movie' AND p.kodi_id = i.kodi_id
      WHERE i.id = ? AND i.kodi_type = 'movie'`).get(target.itemId) as typeof claim;
  } else {
    const e = db.prepare(`SELECT e.id, e.path, e.kodi_id, e.season, e.episode, e.title, s.playcount, s.resume, s.last_played, s.streamed, s.streamed_at
      FROM episodes e LEFT JOIN episode_states s ON s.episode_id = e.id AND s.profile_id = ? WHERE e.id = ?`).get(profileId, target.episodeId) as unknown as EpisodeRow | undefined;
    latest = e ? progressOf(e) : null;
    claim = db.prepare(`SELECT p.profile_id, p.at, p.used_at FROM episodes e JOIN tv_plays p ON p.kodi_type = 'episode' AND p.kodi_id = e.kodi_id
      WHERE e.id = ?`).get(target.episodeId) as typeof claim;
  }
  // Kodi's own point is live (ours waits for the next sync): theirs when they were the last to start it
  // on a TV and it isn't synced yet (nobody noted: the TV remote, the main profile), unless they went
  // further in VLC since.
  const kodiIsTheirs = claim ? claim.used_at === null && claim.profile_id === profileId : profileId === MAIN_PROFILE;
  if (kodiIsTheirs && !(latest?.where === 'phone' && latest.at > (claim?.at ?? 0))) return true;
  return inProgress(latest) ? Math.round(latest.fraction * 1000) / 10 : false;
}

/** How far VLC got into an episode, as for films (see noteStreamed). */
export function noteEpisodeStreamed(db: DB, profileId: number, episodeId: number, start: number, sent: number, size: number, now = Date.now()): void {
  if (sent < MIN_STREAM || !size) return;
  db.prepare(`INSERT INTO episode_states (profile_id, episode_id, streamed, streamed_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(profile_id, episode_id) DO UPDATE SET streamed = excluded.streamed, streamed_at = excluded.streamed_at`).run(profileId, episodeId, Math.min(1, (start + sent) / size), now);
}

/**
 * How far VLC got, from what the server sent it: VLC reads the file as it plays, so the end of the
 * last long read is about where playback stopped.
 */
export function noteStreamed(db: DB, profileId: number, itemId: number, start: number, sent: number, size: number, now = Date.now()): void {
  if (sent < MIN_STREAM || !size) return;
  db.prepare(`INSERT INTO watching (profile_id, item_id, fraction, played_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(profile_id, item_id) DO UPDATE SET fraction = excluded.fraction, played_at = excluded.played_at`).run(profileId, itemId, Math.min(1, (start + sent) / size), now);
}

/** Removed by hand from this profile's row; it comes back once played again. Kodi's own resume point is left alone. */
export function dismissWatching(db: DB, profileId: number, itemId: number, now = Date.now()): void {
  db.prepare(`INSERT INTO watching (profile_id, item_id, dismissed_at) VALUES (?, ?, ?)
    ON CONFLICT(profile_id, item_id) DO UPDATE SET dismissed_at = excluded.dismissed_at`).run(profileId, itemId, now);
}

/**
 * This profile's films started and not finished (on a TV or in VLC, whichever is newer), and its series
 * with episodes left after the latest one played. Latest first.
 */
export function continueWatching(db: DB, profileId: number, now = Date.now()): Watching[] {
  const rows = db.prepare(`SELECT i.id, i.media_type type, i.tmdb_id tmdb, f.resume, f.last_played, w.fraction, w.played_at, w.dismissed_at
    FROM items i LEFT JOIN film_states f ON f.item_id = i.id AND f.profile_id = ?1 LEFT JOIN watching w ON w.item_id = i.id AND w.profile_id = ?1
    WHERE i.present = 1 AND i.hidden = 0 AND i.is_dir = 0 AND (f.last_played IS NOT NULL OR w.played_at IS NOT NULL)`).all(profileId) as Array<{
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
  const shows = db.prepare(`SELECT i.id, i.media_type type, i.tmdb_id tmdb, w.dismissed_at FROM items i LEFT JOIN watching w ON w.item_id = i.id AND w.profile_id = ?1
    WHERE i.present = 1 AND i.hidden = 0 AND i.is_dir = 1
      AND EXISTS (SELECT 1 FROM episodes e JOIN episode_states s ON s.episode_id = e.id AND s.profile_id = ?1
        WHERE e.item_id = i.id AND (s.last_played IS NOT NULL OR s.streamed_at IS NOT NULL))`).all(profileId) as Array<{
    id: number; type: string | null; tmdb: number | null; dismissed_at: number | null;
  }>;
  for (const r of shows) {
    const s = seriesState(episodesOf(db, r.id, profileId));
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
