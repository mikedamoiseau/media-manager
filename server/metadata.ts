import { type DB, tx } from './db.ts';
import { type KodiConfig, kodiCall, fromKodiPath, artUrl, youtubeId } from './kodi.ts';
import { type Tmdb, type TitleDetails, type Candidate, findMatch } from './tmdb.ts';
import { pool, type MediaType } from './scanner.ts';

// ---------- titles ----------

export function upsertTitle(db: DB, t: TitleDetails, source: 'kodi' | 'tmdb', now = Date.now()): void {
  if (source === 'kodi') {
    // Never let Kodi data overwrite a richer TMDB record.
    const existing = db.prepare('SELECT source, fetched_at FROM titles WHERE media_type = ? AND tmdb_id = ?').get(t.type, t.id) as
      | { source: string; fetched_at: number }
      | undefined;
    if (existing?.source === 'tmdb') return;
    // Kodi re-sends its whole library every sync: refresh at most daily so the library version stays put.
    if (existing && now - existing.fetched_at < 86_400_000) return;
  }
  db.prepare(`INSERT INTO titles (media_type, tmdb_id, title_en, title_fr, original_title, original_language, year, genres, overview_en,
      overview_fr, tagline, runtime, rating, votes, poster, backdrop, trailer, cast_json, directors, imdb_id, collection, seasons, source, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(media_type, tmdb_id) DO UPDATE SET
      title_en = excluded.title_en, title_fr = COALESCE(excluded.title_fr, titles.title_fr),
      original_title = excluded.original_title, original_language = COALESCE(excluded.original_language, titles.original_language),
      year = excluded.year, genres = excluded.genres, overview_en = excluded.overview_en,
      overview_fr = COALESCE(excluded.overview_fr, titles.overview_fr), tagline = excluded.tagline, runtime = excluded.runtime,
      rating = excluded.rating, votes = excluded.votes, poster = COALESCE(excluded.poster, titles.poster),
      backdrop = COALESCE(excluded.backdrop, titles.backdrop), trailer = COALESCE(excluded.trailer, titles.trailer),
      cast_json = excluded.cast_json, directors = excluded.directors, imdb_id = COALESCE(excluded.imdb_id, titles.imdb_id),
      collection = excluded.collection, seasons = excluded.seasons, source = excluded.source, fetched_at = excluded.fetched_at`).run(
    t.type, t.id, t.titleEn ?? null, t.titleFr ?? null, t.originalTitle ?? null, t.originalLanguage ?? null, t.year ?? null,
    JSON.stringify(t.genres), t.overviewEn ?? null, t.overviewFr ?? null, t.tagline ?? null, t.runtime ?? null, t.rating ?? null,
    t.votes ?? null, t.poster ?? null, t.backdrop ?? null, t.trailer ?? null, JSON.stringify(t.cast), JSON.stringify(t.directors),
    t.imdbId ?? null, t.collection ?? null, t.seasons ?? null, source, now,
  );
}

// ---------- Kodi library ----------

interface KodiVideo {
  movieid?: number;
  tvshowid?: number;
  file: string;
  title: string;
  originaltitle?: string;
  year?: number;
  genre?: string[];
  uniqueid?: Record<string, string>;
  playcount?: number;
  resume?: { position: number; total: number };
  lastplayed?: string;
  trailer?: string;
  plot?: string;
  tagline?: string;
  rating?: number;
  votes?: string | number;
  runtime?: number;
  art?: Record<string, string>;
  director?: string[];
  set?: string;
  season?: number;
  episode?: number;
  watchedepisodes?: number;
}

async function paged<T>(cfg: KodiConfig, method: string, key: string, params: Record<string, unknown>): Promise<T[]> {
  const out: T[] = [];
  for (let start = 0; ; start += 500) {
    const r = await kodiCall<Record<string, unknown> & { limits: { total: number } }>(
      cfg, method, { ...params, limits: { start, end: start + 500 } }, 30000,
    );
    out.push(...((r[key] as T[]) ?? []));
    if (start + 500 >= r.limits.total) break;
  }
  return out;
}

function kodiToTitle(v: KodiVideo, type: MediaType, id: number): TitleDetails {
  return {
    type,
    id,
    titleEn: v.title,
    originalTitle: v.originaltitle || v.title,
    year: v.year || undefined,
    genres: v.genre ?? [],
    overviewEn: v.plot || undefined,
    tagline: v.tagline || undefined,
    runtime: v.runtime ? Math.round(v.runtime / 60) : undefined,
    rating: v.rating || undefined,
    votes: Number(v.votes) || undefined,
    poster: artUrl(v.art?.poster),
    backdrop: artUrl(v.art?.fanart),
    trailer: youtubeId(v.trailer),
    cast: [],
    directors: v.director ?? [],
    imdbId: v.uniqueid?.imdb,
    collection: v.set || undefined,
    seasons: v.season || undefined,
  };
}

export interface KodiSyncResult {
  movies: number;
  shows: number;
  linked: number;
  episodes: number;
}

export interface KodiLibrary {
  movies: KodiVideo[];
  shows: KodiVideo[];
  episodes: Array<{ episodeid: number; file: string; playcount: number }>;
}

export async function fetchKodiLibrary(cfg: KodiConfig): Promise<KodiLibrary> {
  const movieProps = ['file', 'title', 'originaltitle', 'year', 'genre', 'uniqueid', 'playcount', 'resume', 'lastplayed', 'trailer',
    'plot', 'tagline', 'rating', 'votes', 'runtime', 'art', 'director', 'set'];
  const showProps = ['file', 'title', 'originaltitle', 'year', 'genre', 'uniqueid', 'playcount', 'lastplayed', 'plot', 'rating', 'votes',
    'art', 'season', 'episode', 'watchedepisodes'];
  const [movies, shows, episodes] = await Promise.all([
    paged<KodiVideo>(cfg, 'VideoLibrary.GetMovies', 'movies', { properties: movieProps }),
    paged<KodiVideo>(cfg, 'VideoLibrary.GetTVShows', 'tvshows', { properties: showProps }),
    paged<KodiLibrary['episodes'][number]>(cfg, 'VideoLibrary.GetEpisodes', 'episodes', { properties: ['file', 'playcount'] }),
  ]);
  return { movies, shows, episodes };
}

/** Path comparison key: macOS SMB lists names decomposed (NFD) while Kodi reports them composed (NFC). */
export const pathKey = (p: string) => p.normalize('NFC').toLowerCase();

/** Pull Kodi's library: links our items to Kodi ids, adopts Kodi's TMDB matches and imports watched state. */
export async function syncFromKodi(db: DB, cfg: KodiConfig, prefix: string, now = Date.now()): Promise<KodiSyncResult> {
  return applyKodiLibrary(db, prefix, await fetchKodiLibrary(cfg), now);
}

export function applyKodiLibrary(db: DB, prefix: string, lib: KodiLibrary, now = Date.now()): KodiSyncResult {
  const items = db.prepare('SELECT id, path, match_state FROM items').all() as Array<{ id: number; path: string; match_state: string }>;
  const byPath = new Map(items.map((i) => [pathKey(i.path), i]));
  const eps = db.prepare('SELECT id, item_id, path FROM episodes').all() as Array<{ id: number; item_id: number; path: string }>;
  const epByPath = new Map(eps.map((e) => [pathKey(e.path), e]));
  // Only write (and bump updated_at, which drives client refreshes) when something actually changed.
  const link = db.prepare(`UPDATE items SET kodi_id = ?1, kodi_type = ?2, playcount = ?3, resume = ?4, last_played = ?5, updated_at = ?6
    WHERE id = ?7 AND (kodi_id IS NOT ?1 OR kodi_type IS NOT ?2 OR playcount IS NOT ?3 OR resume IS NOT ?4 OR last_played IS NOT ?5)`);
  // 'kodi-doubted': Kodi's match for this file looked wrong and was sent to the review list instead.
  const adopt = db.prepare(`UPDATE items SET tmdb_id = ?, media_type = ?, match_state = 'matched', match_source = 'kodi', candidates = NULL, updated_at = ?
    WHERE id = ? AND match_state IN ('pending', 'unmatched') AND match_source IS NOT 'kodi-doubted'`);
  const epLink = db.prepare('UPDATE episodes SET kodi_id = ?1, playcount = ?2 WHERE id = ?3 AND (kodi_id IS NOT ?1 OR playcount IS NOT ?2)');
  const touch = db.prepare('UPDATE items SET updated_at = ? WHERE id = ?');
  let linked = 0;
  let epLinked = 0;

  tx(db, () => {
    const handle = (v: KodiVideo, kodiType: 'movie' | 'tvshow') => {
      const rel = fromKodiPath(prefix, v.file);
      if (!rel) return;
      // A film kept in its own folder is one folder item on our side; Kodi reports the video inside it.
      const item = byPath.get(pathKey(rel)) ?? (kodiType === 'movie' ? byPath.get(pathKey(rel.slice(0, rel.lastIndexOf('/')))) : undefined);
      if (!item) return;
      const resume = v.resume && v.resume.total > 0 ? v.resume.position / v.resume.total : null;
      const played = kodiType === 'tvshow' ? (v.episode && v.watchedepisodes === v.episode ? 1 : 0) : (v.playcount ?? 0);
      link.run((v.movieid ?? v.tvshowid)!, kodiType, played, resume, v.lastplayed || null, now, item.id);
      linked++;
      const type: MediaType = kodiType === 'movie' ? 'movie' : 'tv';
      const tmdbId = Number(v.uniqueid?.tmdb);
      if (!tmdbId) return;
      upsertTitle(db, kodiToTitle(v, type, tmdbId), 'kodi', now);
      adopt.run(tmdbId, type, now, item.id);
    };
    for (const m of lib.movies) handle(m, 'movie');
    for (const s of lib.shows) handle(s, 'tvshow');
    for (const e of lib.episodes) {
      const rel = fromKodiPath(prefix, e.file);
      const ep = rel ? epByPath.get(pathKey(rel)) : undefined;
      if (!ep) continue;
      epLinked++;
      if (epLink.run(e.episodeid, e.playcount, ep.id).changes) touch.run(now, ep.item_id);
    }
  });
  return { movies: lib.movies.length, shows: lib.shows.length, linked, episodes: epLinked };
}

// ---------- TMDB ----------

interface PendingItem {
  id: number;
  path: string;
  is_dir: number;
  media_type: MediaType;
  parsed_title: string | null;
  parsed_year: number | null;
  alt_titles: string | null;
  sheet_en: string | null;
  sheet_fr: string | null;
  sheet_year: number | null;
}

export function slimCandidates(cands: Candidate[]) {
  return cands.map((c) => ({ id: c.id, type: c.type, title: c.title, originalTitle: c.originalTitle, year: c.year, poster: c.poster, score: c.score && Math.round(c.score * 100) / 100 }));
}

/** Match every pending item against TMDB. Unsure matches go to the review list with their candidates. */
export async function matchPending(
  db: DB, tmdb: Tmdb, opts: { onProgress?: (done: number, total: number) => void; shouldStop?: () => boolean } = {},
): Promise<{ matched: number; unmatched: number }> {
  const rows = db.prepare(`SELECT id, path, is_dir, media_type, parsed_title, parsed_year, alt_titles, sheet_en, sheet_fr, sheet_year
    FROM items WHERE match_state = 'pending' AND media_type IS NOT NULL ORDER BY source = 'sheet', added_at DESC`).all() as unknown as PendingItem[];
  // "AND match_state = 'pending'": the user (or Kodi) may have matched the item while this run was going.
  const setMatch = db.prepare("UPDATE items SET tmdb_id = ?, media_type = ?, match_state = 'matched', match_source = 'tmdb', match_score = ?, candidates = NULL, updated_at = ? WHERE id = ? AND match_state = 'pending'");
  const setUnmatched = db.prepare("UPDATE items SET match_state = 'unmatched', match_score = ?, candidates = ?, updated_at = ? WHERE id = ? AND match_state = 'pending'");
  const cache = new Map<string, Promise<Awaited<ReturnType<typeof findMatch>>>>();
  let done = 0;
  let matched = 0;
  let unmatched = 0;
  await pool(rows, 4, async (it) => {
    if (opts.shouldStop?.()) return;
    const titles = [it.sheet_fr, it.parsed_title, ...(JSON.parse(it.alt_titles ?? '[]') as string[])].filter((t): t is string => !!t);
    const year = it.sheet_year ?? it.parsed_year ?? undefined;
    const key = JSON.stringify([it.media_type, titles, it.sheet_en, year]);
    try {
      if (!cache.has(key)) cache.set(key, findMatch(tmdb, { type: it.media_type, titles, englishTitle: it.sheet_en ?? undefined, year }));
      const r = await cache.get(key)!;
      if (r.best && r.confident) {
        await ensureTitle(db, tmdb, r.best.type, r.best.id);
        if (setMatch.run(r.best.id, r.best.type, r.best.score ?? null, Date.now(), it.id).changes) matched++;
      } else if (setUnmatched.run(r.best?.score ?? null, JSON.stringify(slimCandidates(r.candidates)), Date.now(), it.id).changes) {
        unmatched++;
      }
    } catch (e) {
      // Leave the item pending: transient network/API errors get retried on the next run.
      console.warn(`match failed for ${it.path}: ${(e as Error).message}`);
    }
    opts.onProgress?.(++done, rows.length);
  });
  return { matched, unmatched };
}

const inflight = new Map<string, Promise<void>>();

/** Make sure we hold full TMDB details (French title, overview, cast, trailer) for a title. */
export function ensureTitle(db: DB, tmdb: Tmdb, type: MediaType, id: number, force = false): Promise<void> {
  const row = db.prepare('SELECT source FROM titles WHERE media_type = ? AND tmdb_id = ?').get(type, id) as { source: string } | undefined;
  if (row?.source === 'tmdb' && !force) return Promise.resolve();
  const k = `${type}:${id}`;
  if (!inflight.has(k)) {
    inflight.set(
      k,
      tmdb
        .details(type, id)
        .then((d) => upsertTitle(db, d, 'tmdb'))
        .finally(() => inflight.delete(k)),
    );
  }
  return inflight.get(k)!;
}

/** Upgrade titles known only from Kodi (or matched but never fetched) to full TMDB records. */
export async function enrichTitles(
  db: DB, tmdb: Tmdb, opts: { onProgress?: (done: number, total: number) => void; shouldStop?: () => boolean } = {},
): Promise<number> {
  const rows = db.prepare(`
    SELECT DISTINCT i.media_type AS type, i.tmdb_id AS id FROM items i
    LEFT JOIN titles t ON t.media_type = i.media_type AND t.tmdb_id = i.tmdb_id
    WHERE i.tmdb_id IS NOT NULL AND (t.tmdb_id IS NULL OR t.source = 'kodi')`).all() as Array<{ type: MediaType; id: number }>;
  let done = 0;
  await pool(rows, 4, async (r) => {
    if (opts.shouldStop?.()) return;
    try {
      await ensureTitle(db, tmdb, r.type, r.id);
    } catch (e) {
      console.warn(`details failed for ${r.type}/${r.id}: ${(e as Error).message}`);
    }
    opts.onProgress?.(++done, rows.length);
  });
  return done;
}
