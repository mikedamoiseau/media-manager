import type { DB } from './db.ts';
import { type KodiConfig, kodiCall } from './kodi.ts';
import { sleepOf, upNextEntries, type UpNextEntry } from './upnext.ts';

// Lumen's "Next episode" card starts the next episode once one ends, unless the app decides what follows on
// that TV: then the card only shows the label, and never plays. Lower case: Kodi keeps a skin's settings
// under lower-case names, and asks for them by that name. Lumen makes both; until a TV's skin has them, Kodi
// refuses to set them.
export const HOLD_NEXT = 'cinemathequeholdnext';
export const NEXT_LABEL = 'cinemathequenextlabel';

export type Named = { show: string; season: number | null; episode: number | null; title: string | null } | { film: string };

/** "Next: The Show, S2 E6 · The Return", as the phone's Remote says it; "Next: Film" for a film. */
export function nextLabel(n: Named): string {
  if ('film' in n) return `Next: ${n.film}`;
  const number = n.episode === null ? null : n.season === null ? `E${n.episode}` : `S${n.season} E${n.episode}`;
  return `Next: ${[[n.show, number].filter(Boolean).join(', '), n.title].filter(Boolean).join(' · ')}`;
}

/**
 * Whether the app decides what plays after this on the TV: Up next has entries, "stop after this" is set, or
 * a kid's bedtime passed while the TV is in the kids view (`kidsBedtime`). A timer in minutes doesn't: it
 * stops the TV when due, whatever plays. `first`: the entry that plays next.
 */
export function holdsNext(db: DB, tvId: string, now: number, kidsBedtime: boolean): { hold: boolean; first?: UpNextEntry } {
  const first = upNextEntries(db, tvId)[0];
  const sleep = sleepOf(db, tvId, now);
  return { hold: !!first || (!!sleep && 'afterThis' in sleep) || kidsBedtime, first };
}

/** The entry's name as the TV's library has it; the app's own when Kodi doesn't know it. */
export async function entryName(db: DB, cfg: KodiConfig, e: UpNextEntry): Promise<Named> {
  const r = db.prepare(`SELECT i.kodi_id, i.kodi_type, COALESCE(t.title_en, t.original_title, i.parsed_title, i.path) AS name, ep.kodi_id AS episode_kodi
    FROM items i LEFT JOIN titles t ON t.media_type = i.media_type AND t.tmdb_id = i.tmdb_id LEFT JOIN episodes ep ON ep.id = ?
    WHERE i.id = ?`).get(e.episodeId, e.itemId) as { kodi_id: number | null; kodi_type: string | null; name: string; episode_kodi: number | null };
  try {
    if (e.episodeId !== null && r.episode_kodi !== null) {
      const d = (await kodiCall<{ episodedetails: { showtitle: string; season: number; episode: number; title: string } }>(cfg, 'VideoLibrary.GetEpisodeDetails', {
        episodeid: r.episode_kodi,
        properties: ['showtitle', 'season', 'episode', 'title'],
      })).episodedetails;
      return { show: d.showtitle, season: d.season, episode: d.episode, title: d.title || null };
    }
    if (e.episodeId === null && r.kodi_type === 'movie' && r.kodi_id !== null) {
      return { film: (await kodiCall<{ moviedetails: { title: string } }>(cfg, 'VideoLibrary.GetMovieDetails', { movieid: r.kodi_id, properties: ['title'] })).moviedetails.title };
    }
  } catch {
    // Kodi doesn't know it (any more): the app's names below.
  }
  return e.episodeId === null ? { film: r.name } : { show: r.name, season: e.season, episode: e.episode, title: e.episodeTitle };
}

/** Tells the TV's skin; a refusal stops at the first setting. */
export async function tellSkin(cfg: KodiConfig, hold: boolean, label: string): Promise<void> {
  await kodiCall(cfg, 'Settings.SetSkinSettingValue', { setting: HOLD_NEXT, value: hold });
  await kodiCall(cfg, 'Settings.SetSkinSettingValue', { setting: NEXT_LABEL, value: label });
}
