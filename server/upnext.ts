import type { DB } from './db.ts';
import { episodesOf, nextEpisode } from './watching.ts';

// Up next: the films and episodes each TV plays one after another (the Service starts the next when
// one plays to its end), and each TV's sleep timer.

/** A list nobody added to or played from for this long is cleared: yesterday's list doesn't start after tonight's film. */
export const STALE = 6 * 3600_000;
/** An "after this" timer whose stop never came (the TV's events were down) lapses after this long. */
export const AFTER_THIS_LAPSE = 6 * 3600_000;
/** A timer the app missed by more than this (the Mac slept) stops nothing: whoever watches now didn't ask for it. */
export const SLEEP_GRACE = 10 * 60_000;

export interface UpNextRow {
  id: number;
  tvId: string;
  itemId: number;
  /** null: a film */
  episodeId: number | null;
  /** who added it: it plays from where they stopped, for them */
  profileId: number;
}

/** An entry as the devices show it. */
export interface UpNextEntry {
  id: number;
  itemId: number;
  episodeId: number | null;
  season: number | null;
  episode: number | null;
  episodeTitle: string | null;
}

export class UpNextError extends Error {
  code: 'duplicate';
  constructor(code: 'duplicate', message: string) {
    super(message);
    this.code = code;
  }
}

const ROW = 'id, tv_id AS tvId, item_id AS itemId, episode_id AS episodeId, profile_id AS profileId';

/** The TV's list, in order. */
export function upNext(db: DB, tvId: string): UpNextRow[] {
  return (db.prepare(`SELECT ${ROW} FROM up_next WHERE tv_id = ? ORDER BY id`).all(tvId) as unknown as UpNextRow[]).map((r) => ({ ...r }));
}

/** The TV's list as the devices show it. */
export function upNextEntries(db: DB, tvId: string): UpNextEntry[] {
  return (
    db.prepare(`SELECT u.id, u.item_id AS itemId, u.episode_id AS episodeId, e.season, e.episode, e.title AS episodeTitle
      FROM up_next u LEFT JOIN episodes e ON e.id = u.episode_id WHERE u.tv_id = ? ORDER BY u.id`).all(tvId) as unknown as UpNextEntry[]
  ).map((r) => ({ ...r }));
}

/** The list was added to or played from: fresh again. */
function touch(db: DB, tvId: string, now: number): void {
  db.prepare('UPDATE up_next SET at = ? WHERE tv_id = ?').run(now, tvId);
}

/** A film (no episode) or an episode at the end of the TV's list; refused when already in it. */
export function addToUpNext(db: DB, tvId: string, profileId: number, itemId: number, episodeId: number | null, now: number): UpNextRow {
  if (db.prepare('SELECT 1 FROM up_next WHERE tv_id = ? AND item_id = ? AND episode_id IS ?').get(tvId, itemId, episodeId)) {
    throw new UpNextError('duplicate', 'Already in Up next');
  }
  const id = Number(
    db.prepare('INSERT INTO up_next (tv_id, item_id, episode_id, profile_id, at) VALUES (?, ?, ?, ?, ?)').run(tvId, itemId, episodeId, profileId, now).lastInsertRowid,
  );
  touch(db, tvId, now);
  return { id, tvId, itemId, episodeId, profileId };
}

/** False when that entry isn't on the TV's list. */
export function removeFromUpNext(db: DB, tvId: string, id: number): boolean {
  return Number(db.prepare('DELETE FROM up_next WHERE id = ? AND tv_id = ?').run(id, tvId).changes) > 0;
}

export function clearUpNext(db: DB, tvId: string): void {
  db.prepare('DELETE FROM up_next WHERE tv_id = ?').run(tvId);
}

/** A TV removed: its list and its timer go. */
export function forgetTv(db: DB, tvId: string): void {
  clearUpNext(db, tvId);
  clearSleep(db, tvId);
}

/** That entry, else the first, off the TV's list to be played; the rest is fresh again. */
export function takeFromUpNext(db: DB, tvId: string, now: number, id?: number): UpNextRow | undefined {
  const row = (
    id === undefined
      ? db.prepare(`SELECT ${ROW} FROM up_next WHERE tv_id = ? ORDER BY id LIMIT 1`).get(tvId)
      : db.prepare(`SELECT ${ROW} FROM up_next WHERE tv_id = ? AND id = ?`).get(tvId, id)
  ) as UpNextRow | undefined;
  if (!row) return undefined;
  db.prepare('DELETE FROM up_next WHERE id = ?').run(row.id);
  touch(db, tvId, now);
  return { ...row };
}

/** Lists untouched for longer than STALE are cleared; the TVs they were on. */
export function dropStale(db: DB, now: number): string[] {
  const tvs = (db.prepare('SELECT tv_id FROM up_next GROUP BY tv_id HAVING MAX(at) < ?').all(now - STALE) as Array<{ tv_id: string }>).map((r) => r.tv_id);
  for (const tv of tvs) clearUpNext(db, tv);
  return tvs;
}

/**
 * The episode of a series to add to the TV's list, extras aside: the first not queued after the last one
 * in the list; none there, after the one playing on that TV; else where the series stands for this profile
 * (what Play starts). None left, or already queued: undefined.
 */
export function episodeToQueue(db: DB, tvId: string, itemId: number, profileId: number, playingEpisode?: number): number | undefined {
  const main = episodesOf(db, itemId, profileId).filter((e) => e.season !== 0);
  const list = upNext(db, tvId);
  const queued = new Set(list.map((r) => r.episodeId));
  const lastQueued = list
    .filter((r) => r.itemId === itemId)
    .map((r) => main.findIndex((e) => e.id === r.episodeId))
    .filter((i) => i >= 0)
    .at(-1);
  const playing = playingEpisode === undefined ? -1 : main.findIndex((e) => e.id === playingEpisode);
  const base = lastQueued ?? (playing >= 0 ? playing : undefined);
  const pick = base !== undefined ? main.slice(base + 1).find((e) => !queued.has(e.id)) : nextEpisode(db, itemId, profileId);
  return pick && !queued.has(pick.id) ? pick.id : undefined;
}

// ---------- the sleep timer ----------

/** Stop at that time, or once what plays now ends. */
export type Sleep = { at: number } | { afterThis: true } | null;

export function sleepOf(db: DB, tvId: string, now: number): Sleep {
  const r = db.prepare('SELECT at, until FROM tv_sleep WHERE tv_id = ?').get(tvId) as { at: number | null; until: number } | undefined;
  if (!r) return null;
  if (r.at !== null) return { at: r.at };
  return now <= r.until ? { afterThis: true } : null;
}

/** A new timer replaces the TV's last one. */
export function setSleep(db: DB, tvId: string, s: { minutes: number } | { afterThis: true }, now: number): void {
  const at = 'minutes' in s ? now + s.minutes * 60_000 : null;
  db.prepare(`INSERT INTO tv_sleep (tv_id, at, until) VALUES (?, ?, ?)
    ON CONFLICT(tv_id) DO UPDATE SET at = excluded.at, until = excluded.until`).run(tvId, at, at ?? now + AFTER_THIS_LAPSE);
}

export function clearSleep(db: DB, tvId: string): void {
  db.prepare('DELETE FROM tv_sleep WHERE tv_id = ?').run(tvId);
}

/** The TVs to stop now, and the timers that lapsed (missed, or "after this" left behind); both are removed. */
export function dueSleeps(db: DB, now: number): { stop: string[]; lapsed: string[] } {
  const ids = (sql: string) => (db.prepare(sql).all({ now, late: now - SLEEP_GRACE }) as Array<{ tv_id: string }>).map((r) => r.tv_id);
  const stop = ids('SELECT tv_id FROM tv_sleep WHERE at <= :now AND at >= :late ORDER BY tv_id');
  const lapsed = ids('SELECT tv_id FROM tv_sleep WHERE at < :late OR (at IS NULL AND until < :now) ORDER BY tv_id');
  for (const tv of [...stop, ...lapsed]) clearSleep(db, tv);
  return { stop, lapsed };
}
