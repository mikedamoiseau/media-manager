import type { DB } from './db.ts';
import { FINISHED } from './watching.ts';

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

/** It stopped: what played, at most the runtime. */
export function closePlay(db: DB, id: number, minutes: number, finished: boolean): void {
  const r = db.prepare('SELECT item_id, episode_id FROM plays WHERE id = ?').get(id) as { item_id: number; episode_id: number | null } | undefined;
  if (!r) return;
  const runtime = runtimeOf(db, r.item_id, r.episode_id);
  db.prepare('UPDATE plays SET minutes = ?, finished = ? WHERE id = ?').run(Math.max(0, Math.min(minutes, runtime ?? Infinity)), finished ? 1 : 0, id);
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

/** What a play counts for: the minutes measured, else its share of the runtime; never more than the runtime. */
export function playMinutes(r: { minutes: number | null; reached: number | null }, runtime: number | null, episode: boolean): number {
  const full = runtime ?? (episode ? EPISODE_MINUTES : 0);
  return r.minutes !== null ? Math.min(r.minutes, runtime ?? Infinity) : (r.reached ?? 0) * full;
}
