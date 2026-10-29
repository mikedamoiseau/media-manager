import type { Service } from './service.ts';
import { KodiError, play, toKodiPath } from './kodi.ts';
import { kidsProfile, isBedtime } from './kids.ts';
import { nextEpisode, startPoint } from './watching.ts';
import { notePlay } from './owners.ts';
import { recordActivity } from './suggestions.ts';

/** Why a Play can't start, as the app says it. */
export class PlayError extends Error {
  status: 400 | 403 | 404;
  code?: string;
  constructor(status: 400 | 403 | 404, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Play a film, or an episode of a series folder (that one, else the one to go on with), on a TV for a
 * profile: from where they stopped, and what Kodi then changes is theirs. Play on TV and Up next.
 */
export async function playItem(svc: Service, tvId: string, profileId: number, itemId: number, episodeId?: number): Promise<void> {
  const db = svc.db;
  const tv = svc.tv(tvId);
  if (!tv) throw new KodiError('unreachable', 'Kodi is not set up yet');
  // A kid's bedtime: nothing new starts until the morning.
  if (isBedtime(kidsProfile(db, profileId)?.bedtime ?? null, new Date())) throw new PlayError(403, "It's bedtime", 'bedtime');
  const it = db.prepare('SELECT path, is_dir, present, kodi_id, kodi_type FROM items WHERE id = ?').get(itemId) as
    | { path: string; is_dir: number; present: number; kodi_id: number | null; kodi_type: string | null }
    | undefined;
  if (!it || !it.present) throw new PlayError(404, 'File is not on the NAS');
  const ep = it.is_dir
    ? episodeId
      ? (db.prepare('SELECT id, path, kodi_id FROM episodes WHERE id = ? AND item_id = ?').get(episodeId, itemId) as
          | { id: number; path: string; kodi_id: number | null }
          | undefined)
      : nextEpisode(db, itemId, profileId)
    : undefined;
  if (it.is_dir && !ep) throw new PlayError(404, 'No episode found');
  // Kodi plays what it has by its id; any other file through Kodi's path to the media folder, worked out now if not yet.
  const movie = !ep && it.kodi_id && it.kodi_type === 'movie' ? it.kodi_id : null;
  const file = ep ? (ep.kodi_id ? null : ep.path) : movie ? null : it.path;
  const pre = file === null ? tv.pathPrefix : tv.pathPrefix || (await svc.findPathPrefix(tv.id));
  const target = file === null ? (ep ? { episodeid: ep.kodi_id! } : { movieid: movie! }) : pre ? { file: toKodiPath(pre, file) } : null;
  if (!target) throw new PlayError(400, 'Kodi path for the media folder is unknown: set it in Settings');
  // Played from the app: Kodi's next changes to it are this profile's, even if the TV's events don't come through.
  const now = Date.now();
  svc.owners.touch(tv.id, profileId, now, true);
  // Where this profile stopped, not where someone else did. Noted once Kodi started it: a Play that failed claims nothing.
  await play(svc.kodiConfig(tv.id)!, target, startPoint(db, profileId, ep ? { episodeId: ep.id } : { itemId }));
  if (ep?.kodi_id) notePlay(db, 'episode', ep.kodi_id, profileId, now);
  else if (movie) notePlay(db, 'movie', movie, profileId, now);
  recordActivity(db, profileId, itemId, 'play');
}
