import type { DB } from './db.ts';
import { FINISHED, STARTED, kodiTime } from './watching.ts';
import { CLAIM_WINDOW, CLOCK_SLACK, type KodiChange } from './owners.ts';

// The play log, for Your year in film: every film or episode played on a TV (from Kodi's events) or on the
// phone (from what the server streams), and estimates of plays the app only knows from how far they got.

/** A play shorter than this counts nowhere: a test, a mis-tap. */
export const MIN_PLAY_MINUTES = 5;
/** An episode's runtime when nobody knows it. */
export const EPISODE_MINUTES = 40;
/** Streams to the phone this close together are one sitting, one play. */
export const PHONE_SESSION = 4 * 3600_000;

/** The library's film or episode Kodi played: a film's copy on the NAS first. */
export function libraryTitle(db: DB, kodiType: 'movie' | 'episode', kodiId: number): { itemId: number; episodeId: number | null } | undefined {
  if (kodiType === 'episode') {
    const e = db.prepare('SELECT id, item_id FROM episodes WHERE kodi_id = ?').get(kodiId) as { id: number; item_id: number } | undefined;
    return e && { itemId: e.item_id, episodeId: e.id };
  }
  const i = db.prepare("SELECT id FROM items WHERE kodi_id = ? AND kodi_type = 'movie' ORDER BY present DESC, id LIMIT 1").get(kodiId) as { id: number } | undefined;
  return i && { itemId: i.id, episodeId: null };
}

/** Minutes: a film's from TMDB, an episode's from Kodi; null when not known. */
export function runtimeOf(db: DB, itemId: number, episodeId: number | null): number | null {
  const r = (
    episodeId === null
      ? db.prepare('SELECT t.runtime FROM items i JOIN titles t ON t.media_type = i.media_type AND t.tmdb_id = i.tmdb_id WHERE i.id = ?').get(itemId)
      : db.prepare('SELECT runtime FROM episodes WHERE id = ?').get(episodeId)
  ) as { runtime: number | null } | undefined;
  return r?.runtime || null;
}

/** It started on that device: open until closed. */
export function openPlay(db: DB, p: { profileId: number; itemId: number; episodeId: number | null; device: string; at: number }): number {
  return Number(
    db.prepare('INSERT INTO plays (profile_id, item_id, kind, episode_id, device, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.profileId, p.itemId, p.episodeId === null ? 'film' : 'episode', p.episodeId, p.device, p.at).lastInsertRowid,
  );
}

/** It stopped at `endedAt`: what played, at most the runtime. */
export function closePlay(db: DB, id: number, minutes: number, finished: boolean, endedAt: number): void {
  const r = db.prepare('SELECT item_id, episode_id FROM plays WHERE id = ?').get(id) as { item_id: number; episode_id: number | null } | undefined;
  if (!r) return;
  const runtime = runtimeOf(db, r.item_id, r.episode_id);
  db.prepare('UPDATE plays SET ended_at = ?, minutes = ?, finished = ? WHERE id = ?').run(endedAt, Math.max(0, Math.min(minutes, runtime ?? Infinity)), finished ? 1 : 0, id);
}

/** Plays still open when the app stopped: their end was missed, so they only count with what Kodi says later. */
export function closeLeftOpen(db: DB): number {
  return Number(db.prepare("UPDATE plays SET estimated = 1 WHERE minutes IS NULL AND estimated = 0 AND device IS NOT 'phone'").run().changes);
}

/** The server streamed a film or episode to the phone (the request began at `begunAt`; it got as far as `reached`). */
export function notePhonePlay(db: DB, profileId: number, itemId: number, episodeId: number | null, begunAt: number, reached: number, now: number): void {
  // The same sitting while its last stream (its start plus its minutes) is recent; the minutes are kept as they
  // ran (a break included), and count at most the runtime.
  const sitting = db.prepare(`SELECT id, at, reached FROM plays WHERE device = 'phone' AND profile_id = ? AND item_id = ? AND episode_id IS ?
    AND at + COALESCE(minutes, 0) * 60000 >= ? ORDER BY at DESC LIMIT 1`).get(profileId, itemId, episodeId, begunAt - PHONE_SESSION) as
    | { id: number; at: number; reached: number | null }
    | undefined;
  const at = Math.min(sitting?.at ?? begunAt, begunAt);
  const far = Math.max(sitting?.reached ?? 0, reached);
  const minutes = (now - at) / 60_000;
  if (sitting) {
    db.prepare('UPDATE plays SET at = ?, minutes = ?, reached = ?, finished = ? WHERE id = ?').run(at, minutes, far, far >= FINISHED ? 1 : 0, sitting.id);
  } else {
    db.prepare("INSERT INTO plays (profile_id, item_id, kind, episode_id, device, at, minutes, reached, finished) VALUES (?, ?, ?, ?, 'phone', ?, ?, ?, ?)")
      .run(profileId, itemId, episodeId === null ? 'film' : 'episode', episodeId, at, minutes, far, far >= FINISHED ? 1 : 0);
  }
}

// In the settings table but not among the app's settings: the fill below ran.
const FILLED_KEY = 'playsFilled';

/**
 * Once, when the log starts: each profile's last play of each film and episode on a TV (Kodi's) and on the phone
 * (the last stream), as an estimated play, when it was watched or got past the start. A title in both keeps the
 * one that got further. Titles only opened (no play count, no progress) are left out. How many were added.
 */
export function fillPlays(db: DB): number {
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(FILLED_KEY)) return 0;
  type Last = { profile: number; item: number; episode: number | null; at: number; reached: number; finished: boolean };
  const best = new Map<string, Last>();
  const keep = (l: Last) => {
    const k = `${l.profile}:${l.item}:${l.episode}`;
    const was = best.get(k);
    if (!was || l.reached > was.reached) best.set(k, l);
  };
  const fromKodi = (profile: number, item: number, episode: number | null, playcount: number | null, resume: number | null, lastPlayed: string | null) => {
    const at = lastPlayed ? kodiTime(lastPlayed) : 0;
    // Kodi's play count is for all time; a resume point says the last play stopped there (Kodi clears it at the end).
    const finished = resume ? resume >= FINISHED : (playcount ?? 0) > 0;
    if (at && (finished || (resume ?? 0) >= STARTED)) keep({ profile, item, episode, at, reached: finished ? 1 : resume!, finished });
  };
  const fromPhone = (profile: number, item: number, episode: number | null, fraction: number | null, at: number | null) => {
    if (at && (fraction ?? 0) >= STARTED) keep({ profile, item, episode, at, reached: fraction!, finished: fraction! >= FINISHED });
  };
  type FilmRow = { profile_id: number; item_id: number; playcount: number | null; resume: number | null; last_played: string | null };
  for (const r of db.prepare('SELECT profile_id, item_id, playcount, resume, last_played FROM film_states').all() as FilmRow[]) {
    fromKodi(r.profile_id, r.item_id, null, r.playcount, r.resume, r.last_played);
  }
  type PhoneRow = { profile_id: number; item_id: number; fraction: number | null; played_at: number | null };
  for (const r of db.prepare('SELECT profile_id, item_id, fraction, played_at FROM watching').all() as PhoneRow[]) {
    fromPhone(r.profile_id, r.item_id, null, r.fraction, r.played_at);
  }
  type EpisodeRow = FilmRow & { episode_id: number; streamed: number | null; streamed_at: number | null };
  for (const r of db.prepare(`SELECT s.profile_id, e.item_id, s.episode_id, s.playcount, s.resume, s.last_played, s.streamed, s.streamed_at
    FROM episode_states s JOIN episodes e ON e.id = s.episode_id`).all() as EpisodeRow[]) {
    fromKodi(r.profile_id, r.item_id, r.episode_id, r.playcount, r.resume, r.last_played);
    fromPhone(r.profile_id, r.item_id, r.episode_id, r.streamed, r.streamed_at);
  }
  // A title the log already has (it ran before the fill) isn't put in twice.
  const logged = db.prepare('SELECT 1 FROM plays WHERE profile_id = ? AND item_id = ? AND episode_id IS ?');
  const add = db.prepare(`INSERT INTO plays (profile_id, item_id, kind, episode_id, at, reached, finished, estimated) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`);
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const l of best.values()) {
      if (logged.get(l.profile, l.item, l.episode)) continue;
      add.run(l.profile, l.item, l.episode === null ? 'film' : 'episode', l.episode, l.at, l.reached, l.finished ? 1 : 0);
      added++;
    }
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(FILLED_KEY, String(Date.now()));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return added;
}

/**
 * After a Kodi sync, the changes given to profiles: a play the log has (started not long before Kodi's new last
 * play) learns how it ended; a play the app missed (it wasn't running) comes in as an estimate, when it was
 * watched or got past the start. How many were added.
 */
export function logKodiChanges(db: DB, changes: KodiChange[]): number {
  // Kodi stamps a play's last play when it stops. The play it reports: a TV's that stopped then; one whose stop
  // the app missed, started not long before; one Kodi told of before, for that same last play. Never the phone's.
  const near = (col: string) => `${col} BETWEEN ?4 - ${CLOCK_SLACK} AND ?4 + ${CLOCK_SLACK}`;
  const covering = db.prepare(`SELECT id FROM plays WHERE profile_id = ?1 AND item_id = ?2 AND episode_id IS ?3 AND device IS NOT 'phone'
    AND (ended_at IS NOT NULL AND ${near('ended_at')}
      OR device IS NOT NULL AND ended_at IS NULL AND at BETWEEN ?4 - ${CLAIM_WINDOW} AND ?4 + ${CLOCK_SLACK}
      OR device IS NULL AND ${near('at')})
    ORDER BY at DESC LIMIT 1`);
  const learn = db.prepare(`UPDATE plays SET finished = MAX(finished, ?1),
    reached = CASE WHEN ?1 THEN 1 WHEN ?2 IS NOT NULL THEN MAX(COALESCE(reached, 0), ?2) ELSE reached END WHERE id = ?3`);
  const add = db.prepare('INSERT INTO plays (profile_id, item_id, kind, episode_id, at, reached, finished, estimated) VALUES (?, ?, ?, ?, ?, ?, ?, 1)');
  let added = 0;
  for (const c of changes) {
    if (!c.lastPlayed) continue;
    const at = kodiTime(c.lastPlayed);
    const finished = c.watched || (c.resume ?? 0) >= FINISHED;
    const known = covering.get(c.profileId, c.itemId, c.episodeId, at) as { id: number } | undefined;
    if (known) learn.run(finished ? 1 : 0, c.resume, known.id);
    else if (finished || (c.resume ?? 0) >= STARTED) {
      add.run(c.profileId, c.itemId, c.episodeId === null ? 'film' : 'episode', c.episodeId, at, finished ? 1 : c.resume, finished ? 1 : 0);
      added++;
    }
  }
  return added;
}

/** What a play counts for: the minutes measured, else its share of the runtime; never more than the runtime. */
export function playMinutes(r: { minutes: number | null; reached: number | null }, runtime: number | null, episode: boolean): number {
  const full = runtime ?? (episode ? EPISODE_MINUTES : 0);
  return r.minutes !== null ? Math.min(r.minutes, runtime ?? Infinity) : (r.reached ?? 0) * full;
}
