import type { DB } from './db.ts';
import { MAIN_PROFILE } from './profiles.ts';
import { kodiTime } from './watching.ts';

// Kodi keeps one shared library: its plays, resume points and last plays are everyone's. Each change
// it reports is given to the profile that started that play (see attributeKodiChanges).

/** Someone used the app on a TV this recently (Play, the Remote, typing): what starts there next is theirs. */
export const TOUCH_WINDOW = 3 * 60_000;
/** Kodi going on to the next episode this soon after one reached its end: still the same person watching. */
export const CHAIN_WINDOW = 2 * 60_000;
/** A play noted this long before the change Kodi reports didn't make it (a Play that never started). */
export const CLAIM_WINDOW = 12 * 3600_000;
// Kodi's clock and ours may differ a little.
const CLOCK_SLACK = 5 * 60_000;

/** Who is watching on each TV, from the app's use of it; the main profile when nobody used the app. */
export class TvOwners {
  private touched = new Map<string, { profile: number; at: number }>();
  private playing = new Map<string, number>();
  private ended = new Map<string, { profile: number; at: number }>();
  private byChain = new Map<string, boolean>();

  touch(tvId: string, profileId: number, now: number): void {
    this.touched.set(tvId, { profile: profileId, at: now });
  }

  /** Something started playing on the TV: whose it is. */
  start(tvId: string, now: number): number {
    const t = this.touched.get(tvId);
    const e = this.ended.get(tvId);
    const touched = !!t && now - t.at <= TOUCH_WINDOW;
    const chained = !touched && !!e && now - e.at <= CHAIN_WINDOW;
    const owner = touched ? t.profile : chained ? e.profile : MAIN_PROFILE;
    this.playing.set(tvId, owner);
    this.byChain.set(tvId, chained);
    return owner;
  }

  /** What last started on the TV is Kodi going on by itself (the next episode), not a Play or the TV remote. */
  chained(tvId: string): boolean {
    return this.byChain.get(tvId) ?? false;
  }

  /** A profile was removed: no TV is theirs any more. */
  forget(profileId: number): void {
    for (const [tv, t] of this.touched) if (t.profile === profileId) this.touched.delete(tv);
    for (const [tv, p] of this.playing) if (p === profileId) this.playing.delete(tv);
    for (const [tv, e] of this.ended) if (e.profile === profileId) this.ended.delete(tv);
  }

  /** It stopped: by hand, or at its end (then Kodi may go on with the next episode). */
  stop(tvId: string, ended: boolean, now: number): void {
    const owner = this.playing.get(tvId);
    this.playing.delete(tvId);
    if (ended && owner !== undefined) this.ended.set(tvId, { profile: owner, at: now });
    else this.ended.delete(tvId);
  }
}

/** A film or episode of Kodi's library started on a TV for this profile. Kept, so a restart loses nothing. */
export function notePlay(db: DB, kodiType: 'movie' | 'episode', kodiId: number, profileId: number, now: number): void {
  db.prepare(`INSERT INTO tv_plays (kodi_type, kodi_id, profile_id, at) VALUES (?, ?, ?, ?)
    ON CONFLICT(kodi_type, kodi_id) DO UPDATE SET profile_id = excluded.profile_id, at = excluded.at, used_at = NULL`).run(kodiType, kodiId, profileId, now);
}

interface State {
  kodiType: 'movie' | 'episode';
  kodiId: number;
  playcount: number | null;
  resume: number | null;
  lastPlayed: string | null;
}

/** Kodi's own view, as synced: films by item id, episodes by episode id. */
export interface KodiStates {
  films: Map<number, State>;
  episodes: Map<number, State>;
}

type Row = { id: number; kodi_id: number; playcount: number | null; resume: number | null; last_played: string | null };
const FILMS = "SELECT id, kodi_id, playcount, resume, last_played FROM items WHERE kodi_type = 'movie' AND kodi_id IS NOT NULL";
const EPISODES = 'SELECT id, kodi_id, playcount, resume, last_played FROM episodes WHERE kodi_id IS NOT NULL';

export function kodiStates(db: DB): KodiStates {
  const read = (sql: string, kodiType: State['kodiType']) =>
    new Map((db.prepare(sql).all() as unknown as Row[]).map((r) => [r.id, { kodiType, kodiId: r.kodi_id, playcount: r.playcount, resume: r.resume, lastPlayed: r.last_played }]));
  return { films: read(FILMS, 'movie'), episodes: read(EPISODES, 'episode') };
}

/**
 * After a sync: each film or episode whose state in Kodi changed gives the change to the profile that
 * started it on a TV (noted after its previous play, not long before this one, and not given yet: a noted
 * play is one play), else to the main profile. That profile gets
 * Kodi's new resume point and last play, and the plays added (or none, when Kodi's count went to 0).
 * How many changes were given.
 */
export function attributeKodiChanges(db: DB, before: KodiStates, now = Date.now()): number {
  const owner = db.prepare('SELECT profile_id, at, used_at FROM tv_plays WHERE kodi_type = ? AND kodi_id = ?');
  const used = db.prepare('UPDATE tv_plays SET used_at = ? WHERE kodi_type = ? AND kodi_id = ?');
  const tables = [
    { sql: FILMS, kind: 'movie' as const, prev: before.films, table: 'film_states', key: 'item_id' },
    { sql: EPISODES, kind: 'episode' as const, prev: before.episodes, table: 'episode_states', key: 'episode_id' },
  ];
  let given = 0;
  for (const t of tables) {
    const current = db.prepare(`SELECT playcount FROM ${t.table} WHERE profile_id = ? AND ${t.key} = ?`);
    const save = db.prepare(`INSERT INTO ${t.table} (profile_id, ${t.key}, playcount, resume, last_played) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(profile_id, ${t.key}) DO UPDATE SET playcount = excluded.playcount, resume = excluded.resume, last_played = excluded.last_played`);
    for (const r of db.prepare(t.sql).all() as unknown as Row[]) {
      const b = t.prev.get(r.id);
      if (b && b.playcount === r.playcount && b.resume === r.resume && b.lastPlayed === r.last_played) continue;
      if (!b && !r.playcount && r.resume === null && r.last_played === null) continue;
      const play = owner.get(t.kind, r.kodi_id) as { profile_id: number; at: number; used_at: number | null } | undefined;
      const since = b?.lastPlayed ? kodiTime(b.lastPlayed) - CLOCK_SLACK : -Infinity;
      const claimed = play && play.used_at === null && play.at >= since && (!r.last_played || kodiTime(r.last_played) - play.at <= CLAIM_WINDOW);
      const profile = claimed ? play.profile_id : MAIN_PROFILE;
      const had = ((current.get(profile, r.id) as { playcount: number | null } | undefined)?.playcount) ?? 0;
      const added = (r.playcount ?? 0) - (b?.playcount ?? 0);
      const playcount = (r.playcount ?? 0) === 0 ? 0 : had + Math.max(0, added);
      save.run(profile, r.id, playcount, r.resume, r.last_played);
      if (claimed) used.run(now, t.kind, r.kodi_id);
      given++;
    }
  }
  return given;
}
