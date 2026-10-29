import type { Context, Hono } from 'hono';
import type { Service } from './service.ts';
import { kodiCall, nowPlaying, type KodiConfig } from './kodi.ts';
import { kodiMedia } from './media.ts';
import { PlayError } from './playItem.ts';
import { UpNextError, addToUpNext, clearUpNext, episodeToQueue, removeFromUpNext, upNext, upNextEntries, setSleep, clearSleep, sleepOf } from './upnext.ts';

const isWhole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

/** Up next and the sleep timer of the device's TV. Not among the kids' routes: refused in kids mode. */
export function upNextRoutes(api: Hono, svc: Service, tvOf: (c: Context) => { cfg: KodiConfig; prefix: string; tv: string }, who: (c: Context) => number): void {
  const db = svc.db;
  /**
   * The episode of the library playing on the TV: from its events, else asked of Kodi by its file (one Kodi
   * has no id for, or one started before the app). None, or Kodi not answering: undefined.
   */
  const playingEpisode = async ({ cfg, prefix, tv }: { cfg: KodiConfig; prefix: string; tv: string }): Promise<number | undefined> => {
    const p = svc.playingOn(tv);
    if (p?.type === 'movie') return undefined;
    const known = p && (db.prepare('SELECT id FROM episodes WHERE kodi_id = ?').get(p.id) as { id: number } | undefined);
    if (known) return known.id;
    const np = await nowPlaying(cfg).catch(() => undefined);
    const m = np?.active && np.file ? kodiMedia(db, prefix, np.file) : undefined;
    return m?.kind === 'episode' ? m.id : undefined;
  };
  /** Every device hears the change; this one gets the TV's list. */
  const changed = (c: Context, tv: string, more: Record<string, unknown> = {}) => {
    svc.upNextChanged();
    return c.json({ upNext: upNextEntries(db, tv), ...more });
  };

  /** A film, an episode, or for a series without one the episode that comes next on that TV. */
  api.post('/upnext', async (c) => {
    const { itemId, episodeId } = (await c.req.json().catch(() => ({}))) as { itemId?: unknown; episodeId?: unknown };
    if (!isWhole(itemId) || (episodeId !== undefined && !isWhole(episodeId))) return c.json({ error: 'Pick a film or an episode' }, 400);
    const k = tvOf(c);
    const { tv } = k;
    const p = who(c);
    const it = db.prepare('SELECT is_dir, present FROM items WHERE id = ?').get(itemId) as { is_dir: number; present: number } | undefined;
    if (!it || !it.present) return c.json({ error: 'File is not on the NAS' }, 404);
    let ep: number | null = null;
    if (it.is_dir) {
      ep = episodeId ?? episodeToQueue(db, tv, itemId, p, await playingEpisode(k)) ?? null;
      if (ep === null) return c.json({ error: 'No episode left to add', code: 'none_left' }, 404);
    }
    const added = ep === null ? undefined : (db.prepare('SELECT season, episode FROM episodes WHERE id = ? AND item_id = ?').get(ep, itemId) as { season: number | null; episode: number | null } | undefined);
    if (episodeId !== undefined && !added) return c.json({ error: 'No episode found' }, 404);
    try {
      addToUpNext(db, tv, p, itemId, ep, Date.now());
    } catch (e) {
      if (e instanceof UpNextError) return c.json({ error: e.message, code: e.code }, 409);
      throw e;
    }
    return changed(c, tv, { added: added ? { season: added.season, episode: added.episode } : null });
  });

  api.delete('/upnext/:id', (c) => {
    const { tv } = tvOf(c);
    if (!removeFromUpNext(db, tv, Number(c.req.param('id')))) return c.json({ error: 'Not in Up next' }, 404);
    return changed(c, tv);
  });

  api.delete('/upnext', (c) => {
    const { tv } = tvOf(c);
    clearUpNext(db, tv);
    return changed(c, tv);
  });

  /** That entry now, for the profile that added it; it leaves the list. */
  api.post('/upnext/:id/play', async (c) => {
    const { tv } = tvOf(c);
    const id = Number(c.req.param('id'));
    if (!upNext(db, tv).some((r) => r.id === id)) return c.json({ error: 'Not in Up next' }, 404);
    try {
      await svc.playNext(tv, id);
    } catch (e) {
      if (e instanceof PlayError) return c.json(e.code ? { error: e.message, code: e.code } : { error: e.message }, e.status);
      throw e;
    }
    return changed(c, tv);
  });

  /** Stop in so many minutes (1 to 240), or once what plays now ends. */
  api.put('/kodi/sleep', async (c) => {
    const { minutes, afterThis } = (await c.req.json().catch(() => ({}))) as { minutes?: unknown; afterThis?: unknown };
    const { cfg, tv } = tvOf(c);
    if (afterThis === true) {
      if (!(await kodiCall<unknown[]>(cfg, 'Player.GetActivePlayers')).length) return c.json({ error: 'Nothing is playing' }, 409);
      setSleep(db, tv, { afterThis: true }, Date.now());
    } else if (isWhole(minutes) && minutes >= 1 && minutes <= 240) {
      setSleep(db, tv, { minutes }, Date.now());
    } else {
      return c.json({ error: 'Pick when to stop' }, 400);
    }
    svc.upNextChanged();
    return c.json({ sleep: sleepOf(db, tv, Date.now()) });
  });

  api.delete('/kodi/sleep', (c) => {
    clearSleep(db, tvOf(c).tv);
    svc.upNextChanged();
    return c.json({ sleep: null });
  });
}
