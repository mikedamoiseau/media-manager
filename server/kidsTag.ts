import type { DB } from './db.ts';
import { type KodiConfig, kodiCall } from './kodi.ts';
import { allowedItems, kidsProfiles } from './kids.ts';
import { paged } from './metadata.ts';

/**
 * The tag the app keeps in Kodi's shared library on the titles every kid may watch: the TV's kids view is built
 * from it. Not "Kids": Kodi's tags are the scraper's TMDB keywords, and "kids" is one (on The Sixth Sense, say).
 */
export const KIDS_TAG = 'Cinematheque Kids';
// Kodi's database ignores case: the tag keeps the spelling it was first given.
const isKidsTag = (t: string) => t.toLowerCase() === KIDS_TAG.toLowerCase();

/** Kodi's titles (`movie:<id>`, `tvshow:<id>`) allowed for every kids profile; none without a kids profile. */
export function kidsTagKeys(db: DB): Set<string> {
  const kids = kidsProfiles(db);
  if (!kids.length) return new Set();
  const lists = kids.map((k) => allowedItems(db, k.maxAge));
  const rows = db.prepare('SELECT id, kodi_type, kodi_id FROM items WHERE kodi_id IS NOT NULL AND kodi_type IS NOT NULL').all() as Array<{
    id: number;
    kodi_type: string;
    kodi_id: number;
  }>;
  return new Set(rows.filter((r) => lists.every((l) => l.has(r.id))).map((r) => `${r.kodi_type}:${r.kodi_id}`));
}

/** The titles whose tags must change for the Kids tag to be on exactly `want`, each with its whole new list. */
export function tagChanges(kodi: Array<{ key: string; tags: string[] }>, want: Set<string>): Array<{ key: string; tags: string[] }> {
  const out: Array<{ key: string; tags: string[] }> = [];
  for (const t of kodi) {
    const has = t.tags.some(isKidsTag);
    if (want.has(t.key) === has) continue;
    out.push({ key: t.key, tags: has ? t.tags.filter((x) => !isKidsTag(x)) : [...t.tags, KIDS_TAG] });
  }
  return out;
}

/**
 * Puts the Kids tag on what every kid may watch, and takes it off the rest, touching no other tag. One TV is
 * enough: the TVs share one library. Without a kids profile Kodi is left alone. Answers how many titles changed.
 */
export async function syncKidsTag(db: DB, cfg: KodiConfig): Promise<number> {
  if (!kidsProfiles(db).length) return 0;
  const want = kidsTagKeys(db);
  const [movies, shows] = await Promise.all([
    paged<{ movieid: number; tag?: string[] }>(cfg, 'VideoLibrary.GetMovies', 'movies', { properties: ['tag'] }),
    paged<{ tvshowid: number; tag?: string[] }>(cfg, 'VideoLibrary.GetTVShows', 'tvshows', { properties: ['tag'] }),
  ]);
  const changes = tagChanges(
    [...movies.map((m) => ({ key: `movie:${m.movieid}`, tags: m.tag ?? [] })), ...shows.map((s) => ({ key: `tvshow:${s.tvshowid}`, tags: s.tag ?? [] }))],
    want,
  );
  for (const c of changes) {
    const [type, id] = c.key.split(':');
    if (type === 'movie') await kodiCall(cfg, 'VideoLibrary.SetMovieDetails', { movieid: Number(id), tag: c.tags });
    else await kodiCall(cfg, 'VideoLibrary.SetTVShowDetails', { tvshowid: Number(id), tag: c.tags });
  }
  return changes.length;
}
