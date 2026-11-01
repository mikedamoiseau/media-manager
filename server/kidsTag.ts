import { dirname, join } from 'node:path';
import type { DB } from './db.ts';
import { type KodiConfig, kodiCall, toKodiPath } from './kodi.ts';
import { allowedItems, kidsProfiles } from './kids.ts';
import { paged } from './metadata.ts';

/**
 * The tag the app keeps in Kodi's shared library on the titles every kid may watch: the TV's kids view is built
 * from it. Not "Kids": Kodi's tags are the scraper's TMDB keywords, and "kids" is one (on The Sixth Sense, say).
 */
export const KIDS_TAG = 'Cinematheque Kids';
// Kodi's database ignores case: the tag keeps the spelling it was first given.
const isKidsTag = (t: string) => t.toLowerCase() === KIDS_TAG.toLowerCase();

/** The skin setting Lumen keeps on while a TV shows its kids view (agreed with the Kodi skin session). */
export const KIDS_VIEW = 'CinemathequeKids';

/** Lumen's kids PIN, asked to leave the kids view with the TV remote: a skin string, digits. */
export const LUMEN_PIN = 'lumen.pin';

/**
 * Puts the parents' code as the TV's kids PIN, unless it is already: Kodi keeps a skin setting set this way only
 * until it saves them (a clean exit), so a TV may have lost it or another. True when written.
 */
export async function syncLumenPin(cfg: KodiConfig, code: string): Promise<boolean> {
  const label = `Skin.String(${LUMEN_PIN})`;
  const now = await kodiCall<Record<string, string>>(cfg, 'XBMC.GetInfoLabels', { labels: [label] });
  if (now[label] === code) return false;
  // A string: Kodi refuses a number for a skin string.
  await kodiCall(cfg, 'Settings.SetSkinSettingValue', { setting: LUMEN_PIN, value: code });
  return true;
}

/**
 * The kids profile watching on a TV in its kids view (the first one made, when there are several); none when
 * it isn't in it or doesn't answer. Kodi isn't asked without a kids profile.
 */
export async function kidsViewProfile(db: DB, cfg: KodiConfig): Promise<number | undefined> {
  const kid = kidsProfiles(db)[0];
  if (!kid) return undefined;
  const setting = `Skin.HasSetting(${KIDS_VIEW})`;
  try {
    const r = await kodiCall<Record<string, boolean>>(cfg, 'XBMC.GetInfoBooleans', { booleans: [setting] }, 3000);
    return r[setting] === true ? kid.id : undefined;
  } catch {
    return undefined;
  }
}

/** The titles every kids profile may watch; none without a kids profile. */
function allowedForAll(db: DB): (id: number) => boolean {
  const lists = kidsProfiles(db).map((k) => allowedItems(db, k.maxAge));
  return (id) => lists.length > 0 && lists.every((l) => l.has(id));
}

/** Kodi's titles (`movie:<id>`, `tvshow:<id>`) allowed for every kids profile; none without a kids profile. */
export function kidsTagKeys(db: DB): Set<string> {
  const allowed = allowedForAll(db);
  const rows = db.prepare('SELECT id, kodi_type, kodi_id FROM items WHERE kodi_id IS NOT NULL AND kodi_type IS NOT NULL').all() as Array<{
    id: number;
    kodi_type: string;
    kodi_id: number;
  }>;
  return new Set(rows.filter((r) => allowed(r.id)).map((r) => `${r.kodi_type}:${r.kodi_id}`));
}

/** Next to the channel list on the NAS: the kids' files Lumen lets play in its kids view though they carry no tag. */
export const kidsFile = (liveFile: string): string => join(dirname(liveFile), 'kids-files.txt');

/**
 * The files every kid may watch that Kodi's library doesn't have (its scraper missed them), so they can't carry the
 * Kids tag: the app plays them by path, and Lumen's kids view stops any untagged play not in this list (agreed with
 * the Kodi skin session). One line per file and per way a TV reaches the media folder, exactly as the app opens it.
 */
export function kidsFilesText(db: DB, prefixes: string[]): string {
  const allowed = allowedForAll(db);
  const rows = db.prepare(`SELECT i.id, i.path FROM items i WHERE i.present = 1 AND i.is_dir = 0 AND i.kodi_id IS NULL
    UNION ALL SELECT e.item_id, e.path FROM episodes e WHERE e.present = 1 AND e.kodi_id IS NULL`).all() as Array<{ id: number; path: string }>;
  const files = rows.filter((r) => allowed(r.id)).map((r) => r.path);
  const roots = [...new Set(prefixes.filter(Boolean).map((p) => toKodiPath(p, '')))];
  const lines = [...new Set(roots.flatMap((root) => files.map((f) => `${root}${f}`.normalize('NFC'))))].sort();
  return `# Cinematheque: files every kids profile may watch that Kodi's library doesn't have, one per line\n${lines.map((l) => `${l}\n`).join('')}`;
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
