// Series tracker: which aired episodes of a followed show aren't on the NAS, from TMDB's seasons.
import type { DB } from './db.ts';
import type { ShowData, ShowEpisode, Tmdb } from './tmdb.ts';
import { parseName } from './parse.ts';
import { localDay } from './films.ts';

// New episodes air weekly and seasons get dated: a day old is fresh enough.
const MAX_AGE = 24 * 3600 * 1000;

// One fetch at a time per show, for each database (each keeps what it fetched).
const fetching = new WeakMap<DB, Map<number, Promise<ShowData>>>();

/** TMDB's seasons of a show, kept a day. What was kept when TMDB fails or there is no key; null when nothing was. */
export async function showData(db: DB, tmdb: Tmdb | null, id: number, now = Date.now()): Promise<ShowData | null> {
  const row = db.prepare('SELECT data, fetched_at FROM shows WHERE tmdb_id = ?').get(id) as { data: string; fetched_at: number } | undefined;
  if (row && (now - row.fetched_at < MAX_AGE || !tmdb)) return JSON.parse(row.data) as ShowData;
  if (!tmdb) return null;
  let inflight = fetching.get(db);
  if (!inflight) fetching.set(db, (inflight = new Map()));
  if (!inflight.has(id)) {
    inflight.set(
      id,
      tmdb
        .showSeasons(id)
        .then((d) => {
          db.prepare(`INSERT INTO shows (tmdb_id, data, fetched_at) VALUES (?, ?, ?)
            ON CONFLICT(tmdb_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`).run(id, JSON.stringify(d), now);
          return d;
        })
        .finally(() => inflight.delete(id)),
    );
  }
  try {
    return await inflight.get(id)!;
  } catch (e) {
    if (row) return JSON.parse(row.data) as ShowData;
    throw e;
  }
}

/** Of these shows, the ones never fetched from TMDB or over a day old. */
export function staleShows(db: DB, ids: number[], now = Date.now()): number[] {
  const fresh = new Set((db.prepare('SELECT tmdb_id id FROM shows WHERE fetched_at > ?').all(now - MAX_AGE) as Array<{ id: number }>).map((r) => r.id));
  return ids.filter((id) => !fresh.has(id));
}

// One file, several episodes (the scanner reads none of them): "S01E09-E11" or "S01E09-11" from 9 to 11,
// "S01E09E10" or "S01E09E11" each episode named.
const MULTI_RE = /\bs(\d{1,2})[ ._-]?e(\d{1,3})(-e?\d{1,3}|(?:[ ._]?e\d{1,3})+)(?!\d)/i;

/** The episodes a file holds, as [season, episode]: specials (season 0) and files without numbers hold none. */
export function fileEpisodes(path: string, season: number | null, episode: number | null): Array<[number, number]> {
  const m = MULTI_RE.exec(path.slice(path.lastIndexOf('/') + 1));
  if (m) {
    const s = Number(m[1]);
    const from = Number(m[2]);
    const marks = [...m[3]!.matchAll(/\d+/g)].map((x) => Number(x[0]));
    const list = m[3]!.startsWith('-') ? Array.from({ length: marks[0]! - from + 1 }, (_, i) => from + i) : [from, ...marks];
    // Numbers go up and stay close: "E01-E30" is more likely a typo or a pack than one file of 30 episodes.
    const ok = list.length > 1 && list.every((e, i) => !i || e > list[i - 1]!) && list.at(-1)! - from < 10;
    if (ok) return s ? list.map((e): [number, number] => [s, e]) : [];
  }
  return season && episode != null ? [[season, episode]] : [];
}

/**
 * Every show with a copy on the NAS, followed or not: by default a show is followed when a copy is in a
 * SERIES folder (anime and kids folders hold long shows kept in part); the owner's choice overrides it.
 */
export function followed(db: DB): Map<number, boolean> {
  const rows = db.prepare(`SELECT i.tmdb_id id, max(i.category = 'series') def, f.follow FROM items i
    LEFT JOIN follows f ON f.tmdb_id = i.tmdb_id
    WHERE i.media_type = 'tv' AND i.present = 1 AND i.tmdb_id IS NOT NULL GROUP BY i.tmdb_id`).all() as Array<{ id: number; def: number; follow: number | null }>;
  return new Map(rows.map((r) => [r.id, !!(r.follow ?? r.def)]));
}

/** Follow a show or not: kept only where it differs from the default. */
export function setFollow(db: DB, id: number, follow: boolean, now = Date.now()): void {
  const def = !!(db.prepare(`SELECT max(category = 'series') def FROM items WHERE media_type = 'tv' AND present = 1 AND tmdb_id = ?`).get(id) as { def: number | null }).def;
  if (follow === def) db.prepare('DELETE FROM follows WHERE tmdb_id = ?').run(id);
  else db.prepare('INSERT INTO follows (tmdb_id, follow, at) VALUES (?, ?, ?) ON CONFLICT(tmdb_id) DO UPDATE SET follow = excluded.follow, at = excluded.at').run(id, follow ? 1 : 0, now);
}

/** The aired episodes of a season that aren't on the NAS. */
export interface SeasonGap {
  season: number;
  /** episodes aired so far */
  aired: number;
  missing: number[];
}

export interface SeriesStatus {
  missing: SeasonGap[];
  /**
   * When the latest missing episode aired: exact when it is TMDB's last episode, else the start of its season
   * (TMDB gives no date per episode without a call per season).
   */
  latest: { date: string; season: number; exact: boolean } | null;
  /** the next episode of a season under way */
  nextEpisode: { season: number; episode: number; date: string | null } | null;
  /** the next season: dated, or announced (no date yet) */
  nextSeason: { season: number; date: string | null } | null;
  /** the show won't come back */
  ended: 'ended' | 'cancelled' | null;
  /** files of the show with no episode number: not counted */
  unnumbered: number;
}

/** The episodes of a show on the NAS, from every present copy (a show can be split over folders), and the files with no number. */
function episodesOnNas(db: DB, id: number): { have: Set<string>; unnumbered: number } {
  const have = new Set<string>();
  let unnumbered = 0;
  const count = (path: string, season: number | null, episode: number | null) => {
    const held = fileEpisodes(path, season, episode);
    for (const [s, e] of held) have.add(`${s}x${e}`);
    if (!held.length && season !== 0) unnumbered++;
  };
  const files = db.prepare(`SELECT e.path, e.season, e.episode FROM episodes e JOIN items i ON i.id = e.item_id
    WHERE i.media_type = 'tv' AND i.tmdb_id = ? AND i.present = 1 AND e.present = 1`).all(id) as Array<{ path: string; season: number | null; episode: number | null }>;
  for (const f of files) count(f.path, f.season, f.episode);
  // A loose file matched to the show is one episode, named like one.
  const loose = db.prepare(`SELECT path FROM items WHERE media_type = 'tv' AND tmdb_id = ? AND present = 1 AND is_dir = 0`).all(id) as Array<{ path: string }>;
  for (const { path } of loose) {
    const p = parseName(path.slice(path.lastIndexOf('/') + 1));
    count(path, p.season ?? null, p.episode ?? null);
  }
  return { have, unnumbered };
}

/**
 * The last regular episode aired. TMDB's last episode can be a special aired after the season: then what aired is
 * what comes before the next regular episode, or with none to come, every season dated by today in full.
 */
function lastAired(data: ShowData, today: string): ShowEpisode | null {
  if (!data.last || data.last.s > 0) return data.last;
  const next = data.next && data.next.s > 0 ? data.next : null;
  if (next && next.e > 1) return { s: next.s, e: next.e - 1, date: null };
  const aired = data.seasons.filter((s) => s.n > 0 && s.count > 0 && s.date && s.date <= today && (!next || s.n < next.s)).at(-1);
  return aired ? { s: aired.n, e: aired.count, date: null } : null;
}

/** A show compared with TMDB: the aired episodes not on the NAS per season, what's next, whether it ended. */
export function seriesStatus(db: DB, id: number, data: ShowData, today: string): SeriesStatus {
  const { have, unnumbered } = episodesOnNas(db, id);
  const last = lastAired(data, today);
  const missing: SeasonGap[] = [];
  for (const s of data.seasons) {
    // Specials never count; a season after the last aired episode hasn't aired.
    if (!s.n || !last || s.n > last.s) continue;
    const aired = s.n < last.s ? s.count : last.e;
    const gone = Array.from({ length: aired }, (_, i) => i + 1).filter((e) => !have.has(`${s.n}x${e}`));
    if (gone.length) missing.push({ season: s.n, aired, missing: gone });
  }
  const gap = missing.at(-1);
  let latest: SeriesStatus['latest'] = null;
  if (gap && last?.date && gap.season === last.s && gap.missing.includes(last.e)) latest = { date: last.date, season: gap.season, exact: true };
  else if (gap) {
    const start = data.seasons.find((s) => s.n === gap.season)?.date;
    if (start) latest = { date: start, season: gap.season, exact: false };
  }
  return { missing, latest, ...upcoming(data, last, today), ended: data.status === 'Canceled' ? 'cancelled' : data.status === 'Ended' ? 'ended' : null, unnumbered };
}

/** The next episode of a season under way, and the season after it (or after the last aired one): dated, or announced. */
function upcoming(data: ShowData, last: ShowEpisode | null, today: string): Pick<SeriesStatus, 'nextEpisode' | 'nextSeason'> {
  const next = data.next && data.next.s > 0 ? data.next : null;
  // A season's first episode: the season itself is what comes.
  if (next && next.e === 1) return { nextEpisode: null, nextSeason: { season: next.s, date: next.date } };
  const after = next?.s ?? last?.s ?? 0;
  const later = data.seasons.find((s) => s.n > after);
  return {
    nextEpisode: next && { season: next.s, episode: next.e, date: next.date },
    // A later season dated by today but not aired yet for TMDB: its date is behind, call it announced.
    nextSeason: later ? { season: later.n, date: later.date && later.date > today ? later.date : null } : null,
  };
}

/** TMDB's seasons of a show as kept, never fetched. */
export function keptShow(db: DB, id: number): ShowData | null {
  const row = db.prepare('SELECT data FROM shows WHERE tmdb_id = ?').get(id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as ShowData) : null;
}

/** The library item that stands for a show: its copy on the NAS with the most files. */
export function seriesItem(db: DB, id: number): number | undefined {
  const row = db.prepare(`SELECT id FROM items WHERE media_type = 'tv' AND tmdb_id = ? AND present = 1 ORDER BY hidden, file_count DESC, id LIMIT 1`).get(id) as { id: number } | undefined;
  return row?.id;
}

/** Followed shows missing aired episodes, the one whose latest missing episode aired last first. From TMDB data kept, never fetched. */
export function episodesToGet(db: DB, now = Date.now()): Array<{ tmdbId: number; itemId: number; status: SeriesStatus }> {
  const today = localDay(now);
  const out: Array<{ tmdbId: number; itemId: number; status: SeriesStatus }> = [];
  for (const [id, on] of followed(db)) {
    const data = on ? keptShow(db, id) : null;
    if (!data) continue;
    const status = seriesStatus(db, id, data, today);
    if (status.missing.length) out.push({ tmdbId: id, itemId: seriesItem(db, id)!, status });
  }
  return out.sort((a, b) => (b.status.latest?.date ?? '').localeCompare(a.status.latest?.date ?? '') || a.itemId - b.itemId);
}
