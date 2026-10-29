import type { DB } from './db.ts';
import { type KodiConfig, kodiCall } from './kodi.ts';
import { paged } from './metadata.ts';

// The age rating the TVs show (Kodi's mpaa) is Germany's FSK, as the app has it from TMDB: Kodi's scrapers
// write the US one. Titles without a German rating keep what Kodi has.

const FSK = new Set(['0', '6', '12', '16', '18']);

/**
 * Kodi's titles (`movie:<id>`, `tvshow:<id>`) with the rating they get: "FSK 12", as Kodi's scraper writes it for
 * Germany. Only files on the NAS: a file gone keeps its old link, and Kodi may have given that id to another title.
 */
export function fskRatings(db: DB): Map<string, string> {
  const rows = db.prepare(`SELECT i.kodi_type, i.kodi_id, json_extract(t.certs, '$.DE') AS de FROM items i
    JOIN titles t ON t.media_type = i.media_type AND t.tmdb_id = i.tmdb_id
    WHERE i.present = 1 AND i.kodi_id IS NOT NULL AND i.kodi_type IS NOT NULL AND t.certs IS NOT NULL`).all() as Array<{ kodi_type: string; kodi_id: number; de: string | null }>;
  return new Map(rows.filter((r) => r.de !== null && FSK.has(r.de)).map((r) => [`${r.kodi_type}:${r.kodi_id}`, `FSK ${r.de}`]));
}

/** The titles whose rating in Kodi isn't the one they get, with that one. */
export function ratingChanges(kodi: Array<{ key: string; mpaa: string }>, want: Map<string, string>): Array<{ key: string; mpaa: string }> {
  return kodi.flatMap((t) => {
    const mpaa = want.get(t.key);
    return mpaa !== undefined && mpaa !== t.mpaa ? [{ key: t.key, mpaa }] : [];
  });
}

/** Writes Germany's rating on the titles of Kodi's library that differ, touching nothing else. One TV is enough: the TVs share one library. Answers how many changed. */
export async function syncAgeRatings(db: DB, cfg: KodiConfig): Promise<number> {
  const want = fskRatings(db);
  const [movies, shows] = await Promise.all([
    paged<{ movieid: number; mpaa?: string }>(cfg, 'VideoLibrary.GetMovies', 'movies', { properties: ['mpaa'] }),
    paged<{ tvshowid: number; mpaa?: string }>(cfg, 'VideoLibrary.GetTVShows', 'tvshows', { properties: ['mpaa'] }),
  ]);
  const changes = ratingChanges(
    [...movies.map((m) => ({ key: `movie:${m.movieid}`, mpaa: m.mpaa ?? '' })), ...shows.map((s) => ({ key: `tvshow:${s.tvshowid}`, mpaa: s.mpaa ?? '' }))],
    want,
  );
  for (const c of changes) {
    const [type, id] = c.key.split(':');
    if (type === 'movie') await kodiCall(cfg, 'VideoLibrary.SetMovieDetails', { movieid: Number(id), mpaa: c.mpaa });
    else await kodiCall(cfg, 'VideoLibrary.SetTVShowDetails', { tvshowid: Number(id), mpaa: c.mpaa });
  }
  return changes.length;
}
