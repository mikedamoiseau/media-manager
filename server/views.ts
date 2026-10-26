import type { DB } from './db.ts';
import { normalize } from './parse.ts';
import { isLatin } from './tmdb.ts';
import { ratingOf } from './suggestions.ts';
import { FINISHED, STARTED, watchedEpisode, episodesOf } from './watching.ts';

interface Row {
  id: number;
  path: string;
  folder: string;
  category: string;
  is_dir: number;
  present: number;
  source: string;
  size: number | null;
  file_count: number | null;
  parsed_title: string | null;
  parsed_year: number | null;
  alt_titles: string | null;
  quality: string | null;
  sheet_en: string | null;
  sheet_fr: string | null;
  sheet_year: number | null;
  media_type: string | null;
  tmdb_id: number | null;
  match_state: string;
  match_source: string | null;
  kodi_id: number | null;
  playcount: number | null;
  resume: number | null;
  custom_poster: string | null;
  hidden: number;
  added_at: number;
  // titles
  title_en: string | null;
  title_fr: string | null;
  original_title: string | null;
  original_language: string | null;
  year: number | null;
  genres: string | null;
  rating: number | null;
  runtime: number | null;
  poster: string | null;
  backdrop: string | null;
  trailer: string | null;
  cast_json: string | null;
  directors: string | null;
  collection: string | null;
}

const SELECT = `SELECT i.*, t.title_en, t.title_fr, t.original_title, t.original_language, t.year, t.genres, t.rating, t.runtime,
  t.poster, t.backdrop, t.trailer, t.cast_json, t.directors, t.collection
  FROM items i LEFT JOIN titles t ON t.media_type = i.media_type AND t.tmdb_id = i.tmdb_id`;

export const img = (url: string | null | undefined, w: number) => (url ? `/api/img?w=${w}&u=${encodeURIComponent(url)}` : null);

function posterOf(r: Row, w = 342): string | null {
  if (r.custom_poster) return `/api/poster/${r.id}?v=${encodeURIComponent(r.custom_poster)}`;
  if (r.poster) return img(r.poster, w);
  if (r.source === 'disk' && r.match_state !== 'matched' && r.match_state !== 'manual') return `/api/thumb/${r.id}`;
  return null;
}

export function badges(q: string | null): string[] {
  if (!q) return [];
  const v = JSON.parse(q) as { res?: string; hdr?: boolean; langs?: string[] };
  return [v.res, v.hdr ? 'HDR' : undefined, ...(v.langs ?? [])].filter((x): x is string => !!x);
}

/** Compact card for the grid, the same for every profile (watched and in progress come from marks). Short keys keep the full-library payload small (~3k items). */
export interface Card {
  id: number;
  /** group key: items sharing a TMDB id are versions of the same title */
  g: string;
  fr: string;
  en: string;
  o: string;
  y: number | null;
  c: string;
  ge: string[];
  p: string | null;
  r: number | null;
  q: string[];
  t: string | null; // movie|tv
  d: boolean; // folder item
  n: number;
  m: string; // match state
  pr: boolean; // on disk
  h: boolean; // hidden
  a: number; // added
  s: string; // normalized search text
  k?: string; // TMDB collection (film set), omitted when none
}

export function card(r: Row): Card {
  const parsed = r.parsed_title ?? r.path;
  const en = r.title_en ?? r.sheet_en ?? parsed;
  const o = r.original_title ?? en;
  // No French title yet (Kodi only gives English): a Latin-script original such as
  // "Le Gendarme et les Gendarmettes" is a better guess than the English one.
  const latinOriginal = o !== en && isLatin(o);
  const fr = r.title_fr ?? r.sheet_fr ?? (latinOriginal ? o : en);
  const cast = r.cast_json ? (JSON.parse(r.cast_json) as Array<{ name: string }>).slice(0, 6).map((c) => c.name) : [];
  const dirs = r.directors ? (JSON.parse(r.directors) as string[]) : [];
  const alts = r.alt_titles ? (JSON.parse(r.alt_titles) as string[]) : [];
  const fileName = r.path.slice(r.path.lastIndexOf('/') + 1);
  const search = normalize([fr, en, o, r.sheet_en, r.sheet_fr, parsed, ...alts, r.collection, ...dirs, ...cast, fileName].filter(Boolean).join(' | '));
  return {
    id: r.id,
    g: r.tmdb_id ? `${r.media_type}:${r.tmdb_id}` : `i:${r.id}`,
    fr,
    en,
    o,
    y: r.year ?? r.sheet_year ?? r.parsed_year,
    c: r.category,
    ge: r.genres ? (JSON.parse(r.genres) as string[]) : [],
    p: posterOf(r),
    r: r.rating ? Math.round(r.rating * 10) / 10 : null,
    q: badges(r.quality),
    t: r.tmdb_id ? r.media_type : null,
    d: !!r.is_dir,
    n: r.file_count ?? 1,
    m: r.match_state,
    pr: !!r.present,
    h: !!r.hidden,
    a: r.added_at,
    s: search,
    k: r.collection ?? undefined,
  };
}

export function libraryCards(db: DB): Card[] {
  return (db.prepare(SELECT).all() as unknown as Row[]).map(card);
}

export function libraryVersion(db: DB): string {
  const r = db.prepare('SELECT max(updated_at) a, count(*) n, (SELECT max(fetched_at) FROM titles) t, (SELECT count(*) FROM titles) tn FROM items').get() as Record<string, number>;
  // The prefix names the card format: bump it when cards gain a field so cached libraries refresh.
  return `c3-${r.a}-${r.n}-${r.t}-${r.tn}`;
}

/**
 * What this profile watched (a film played to the end on a TV or most of the way in VLC; a series with
 * every episode watched, extras aside) and has in progress, as item ids. Small, so the library cards can
 * be the same for everyone.
 */
export function marks(db: DB, profileId: number): { w: number[]; rs: number[] } {
  const w = new Set<number>();
  const rs = new Set<number>();
  for (const r of db.prepare(`SELECT item_id id, playcount, resume, NULL fraction FROM film_states WHERE profile_id = ?1
      UNION ALL SELECT item_id, NULL, NULL, fraction FROM watching WHERE profile_id = ?1 AND fraction IS NOT NULL`).all(profileId) as Array<{
    id: number; playcount: number | null; resume: number | null; fraction: number | null;
  }>) {
    if ((r.playcount ?? 0) > 0 || (r.fraction ?? 0) >= FINISHED) w.add(r.id);
    if ((r.resume ?? 0) > STARTED || ((r.fraction ?? 0) > STARTED && (r.fraction ?? 0) < FINISHED)) rs.add(r.id);
  }
  const shows = db.prepare(`SELECT DISTINCT e.item_id id FROM episode_states s JOIN episodes e ON e.id = s.episode_id WHERE s.profile_id = ?`).all(profileId) as Array<{ id: number }>;
  for (const { id } of shows) {
    const eps = episodesOf(db, id, profileId).filter((e) => e.season !== 0);
    const watched = eps.filter(watchedEpisode).length;
    if (eps.length && watched === eps.length) w.add(id);
    else if (watched || eps.some((e) => (e.resume ?? 0) > STARTED || ((e.streamed ?? 0) > STARTED && (e.streamed ?? 0) < FINISHED))) rs.add(id);
  }
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
  return { w: sorted(w), rs: sorted(rs) };
}

/** A title's page, with the likes and progress of this profile. */
export function itemDetail(db: DB, id: number, profileId: number) {
  const r = db.prepare(`${SELECT} WHERE i.id = ?`).get(id) as unknown as Row | undefined;
  if (!r) return undefined;
  const t = r.tmdb_id
    ? (db.prepare('SELECT * FROM titles WHERE media_type = ? AND tmdb_id = ?').get(r.media_type, r.tmdb_id) as Record<string, unknown> | undefined)
    : undefined;
  // Versions: every item matched to the same title (e.g. a 1080p and a 4K copy).
  const siblings = r.tmdb_id
    ? (db.prepare(`${SELECT} WHERE i.media_type = ? AND i.tmdb_id = ? ORDER BY i.present DESC, i.size DESC`).all(r.media_type, r.tmdb_id) as unknown as Row[])
    : [r];
  const film = db.prepare('SELECT playcount, resume FROM film_states WHERE profile_id = ? AND item_id = ?');
  const own = (itemId: number) => (film.get(profileId, itemId) as { playcount: number | null; resume: number | null } | undefined) ?? { playcount: null, resume: null };
  const versions = siblings.map((s) => ({
    id: s.id,
    path: s.path,
    folder: s.folder,
    present: !!s.present,
    source: s.source,
    isDir: !!s.is_dir,
    size: s.size,
    fileCount: s.file_count,
    quality: badges(s.quality),
    kodiId: s.kodi_id,
    watched: (own(s.id).playcount ?? 0) > 0,
    resume: own(s.id).resume,
    matchState: s.match_state,
    matchSource: s.match_source,
  }));
  const episodes = r.is_dir
    ? (db.prepare(`SELECT e.id, e.path, e.size, e.season, e.episode, e.title, s.playcount, s.resume, s.streamed
        FROM episodes e LEFT JOIN episode_states s ON s.episode_id = e.id AND s.profile_id = ?
        WHERE e.item_id = ? ORDER BY e.season IS NULL, e.season, e.episode IS NULL, e.episode, e.path`).all(profileId, r.id) as Array<Record<string, unknown>>).map((e) => ({
        id: e.id as number,
        name: (e.path as string).slice((e.path as string).lastIndexOf('/') + 1),
        dir: (e.path as string).slice(r.path.length + 1, (e.path as string).lastIndexOf('/')) || null,
        size: e.size,
        season: e.season,
        episode: e.episode,
        title: e.title,
        watched: watchedEpisode(e as { playcount: number | null; resume: number | null; streamed: number | null }),
      }))
    : [];
  // Only a film this profile watched can be liked or not: played to the end on a TV, or most of the way in VLC.
  const watchedFilm =
    r.media_type === 'movie' && !!r.tmdb_id &&
    (siblings.some((s) => (own(s.id).playcount ?? 0) > 0) ||
      !!db.prepare('SELECT 1 FROM watching w JOIN items i ON i.id = w.item_id WHERE w.profile_id = ? AND i.media_type = ? AND i.tmdb_id = ? AND w.fraction >= ?').get(profileId, r.media_type, r.tmdb_id, FINISHED));
  const c = card(r);
  return {
    ...c,
    path: r.path,
    folder: r.folder,
    source: r.source,
    poster: posterOf(r, 780),
    backdrop: img(r.backdrop, 1280),
    trailer: r.trailer,
    runtime: r.runtime,
    overviewEn: (t?.overview_en as string) ?? null,
    overviewFr: (t?.overview_fr as string) ?? null,
    tagline: (t?.tagline as string) ?? null,
    cast: t?.cast_json ? JSON.parse(t.cast_json as string) : [],
    directors: t?.directors ? JSON.parse(t.directors as string) : [],
    collection: r.collection,
    imdbId: (t?.imdb_id as string) ?? null,
    originalLanguage: r.original_language,
    votes: (t?.votes as number) ?? null,
    metaSource: (t?.source as string) ?? null,
    tmdbId: r.tmdb_id,
    mediaType: r.media_type,
    sheet: r.sheet_en || r.sheet_fr ? { en: r.sheet_en, fr: r.sheet_fr, year: r.sheet_year } : null,
    parsed: { title: r.parsed_title, year: r.parsed_year },
    candidates: r.match_state === 'unmatched' ? JSON.parse((db.prepare('SELECT candidates FROM items WHERE id = ?').get(r.id) as { candidates: string | null }).candidates ?? '[]') : [],
    versions,
    episodes,
    canRate: watchedFilm,
    rating: r.tmdb_id && r.media_type ? ratingOf(db, profileId, r.media_type, r.tmdb_id) : null,
  };
}
