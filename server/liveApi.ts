import type { Context, Hono } from 'hono';
import type { Service } from './service.ts';
import type { KodiConfig } from './kodi.ts';
import { LiveError, liveGuide, liveCatalog, guideChannels, hasGuideChannel, pickedChannels, channelHeaders } from './livetv.ts';
import { channelPlaylist, withoutBackups } from './iptv.ts';
import { startChannel, isPlaying } from './liveKodi.ts';
import { isBedtime, NOT_FOR_KIDS, type KidsProfile } from './kids.ts';

const HOUR = 3600_000;

/** Why a channel didn't start on a TV, as the owner reads it. */
const REFUSED = {
  kids_view: { status: 409, error: 'This TV is showing its kids view: only the channels for kids play there' },
  kids_unknown: { status: 503, error: "Couldn't check whether this TV is in its kids view" },
  not_loaded: { status: 409, error: "This TV hasn't loaded the new channel list yet" },
  no_live_tv: { status: 409, error: "This TV couldn't give its channels: is live TV set up on it?" },
} as const;

/**
 * Live TV: the guide, the owner's channels, and playing one on a TV or in VLC. Added after the kids guard: a
 * kids profile reaches only the guide, starting a channel and whether it plays, and these keep to the
 * channels made for kids. A live TV play is never a play of the library (no owner, no history).
 */
export function liveTvRoutes(
  api: Hono,
  svc: Service,
  tvOf: (c: Context) => { cfg: KodiConfig; tv: string },
  kidOf: (c: Context) => KidsProfile | null,
): void {
  const db = svc.db;
  const sources = () => svc.settings().liveGuides;
  const picked = (key: string) => pickedChannels(db).find((c) => c.entry.key === key);

  api.get('/livetv/guide', (c) => {
    const now = Date.now();
    const from = Number(c.req.query('from')) || now - 2 * HOUR;
    const to = Math.min(Number(c.req.query('to')) || now + 24 * HOUR, from + 72 * HOUR);
    const channels = liveGuide(db, sources(), from, to);
    return c.json({ channels: kidOf(c) ? channels.filter((ch) => ch.kids) : channels, refreshedAt: svc.settings().liveRefreshedAt });
  });

  api.get('/livetv/catalog', (c) => c.json({ rows: liveCatalog(db, sources()), file: svc.status.live.file }));

  api.get('/livetv/guide-channels', (c) => c.json({ channels: guideChannels(db, sources()) }));

  api.put('/livetv/channels', async (c) => {
    const { keys } = (await c.req.json().catch(() => ({}))) as { keys?: unknown };
    if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string')) return c.json({ error: 'A list of channels is expected' }, 400);
    try {
      return c.json({ file: svc.saveLivePicks(keys) });
    } catch (e) {
      if (e instanceof LiveError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  api.put('/livetv/channels/:key/guide', async (c) => {
    const { guide } = (await c.req.json().catch(() => ({}))) as { guide?: unknown };
    const manual = typeof guide === 'object' && guide !== null && typeof (guide as { source?: unknown }).source === 'string' && typeof (guide as { id?: unknown }).id === 'string';
    if (!(guide === null || guide === 'none' || manual)) return c.json({ error: 'A guide channel, "none" or null is expected' }, 400);
    if (manual) {
      const g = guide as { source: string; id: string };
      if (!sources().includes(g.source) || !hasGuideChannel(db, g.source, g.id)) return c.json({ error: 'No such channel in the guides' }, 400);
    }
    try {
      svc.setLiveGuide(c.req.param('key'), manual ? { source: (guide as { source: string }).source, id: (guide as { id: string }).id } : (guide as 'none' | null));
    } catch (e) {
      if (e instanceof LiveError) return c.json({ error: e.message }, 400);
      throw e;
    }
    return c.json({ ok: true });
  });

  /** One of the owner's channels made for kids, or not. */
  api.put('/livetv/channels/:key/kids', async (c) => {
    const { kids } = (await c.req.json().catch(() => ({}))) as { kids?: unknown };
    if (typeof kids !== 'boolean') return c.json({ error: 'kids is true or false' }, 400);
    try {
      return c.json({ file: svc.setLiveKids(c.req.param('key'), kids) });
    } catch (e) {
      if (e instanceof LiveError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  /** The owner's own logo for a channel of theirs (null: back to iptv-org's), for one whose listed logo doesn't load. */
  api.put('/livetv/channels/:key/logo', async (c) => {
    const { url } = (await c.req.json().catch(() => ({}))) as { url?: unknown };
    if (url !== null && !(typeof url === 'string' && /^https?:\/\/[^\s]+$/i.test(url.trim()))) return c.json({ error: 'A logo address starts with http:// or https://' }, 400);
    try {
      return c.json({ file: svc.setLiveLogo(c.req.param('key'), url === null ? null : url.trim()) });
    } catch (e) {
      if (e instanceof LiveError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  /** The owner's own stream address for a channel of theirs (null: back to iptv-org's). */
  api.put('/livetv/channels/:key/stream', async (c) => {
    const { url } = (await c.req.json().catch(() => ({}))) as { url?: unknown };
    if (url !== null && !(typeof url === 'string' && /^https?:\/\/[^\s]+$/i.test(url.trim()))) return c.json({ error: 'A stream address starts with http:// or https://' }, 400);
    try {
      return c.json(await svc.setLiveStream(c.req.param('key'), url === null ? null : url.trim()));
    } catch (e) {
      if (e instanceof LiveError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  api.post('/livetv/refresh', (c) => {
    void svc.refreshLive();
    return c.json({ started: true });
  });

  api.post('/livetv/check', (c) => {
    void svc.checkLiveStreams();
    return c.json({ started: true });
  });

  api.post('/livetv/:key/play', async (c) => {
    const ch = picked(c.req.param('key'));
    if (!ch) return c.json({ error: 'Not one of your channels' }, 404);
    const kid = kidOf(c);
    if (kid && !ch.kids) return c.json(NOT_FOR_KIDS, 403);
    // A kid's bedtime: nothing new starts until the morning, as for their titles.
    if (kid && isBedtime(kid.bedtime, new Date())) return c.json({ error: "It's bedtime", code: 'bedtime' }, 403);
    const r = await startChannel(tvOf(c).cfg, { name: ch.name, number: ch.number, kids: ch.kids }, !!kid);
    if (r === 'started') return c.json({ ok: true });
    const why = REFUSED[r];
    return c.json({ error: why.error, code: r }, why.status);
  });

  /** Whether the TV really plays that channel, still opens it, or not (asked a few seconds after Play). */
  api.get('/livetv/:key/playing', async (c) => {
    const ch = picked(c.req.param('key'));
    if (!ch) return c.json({ error: 'Not one of your channels' }, 404);
    if (kidOf(c) && !ch.kids) return c.json(NOT_FOR_KIDS, 403);
    return c.json({ state: await isPlaying(tvOf(c).cfg, ch.name) });
  });

  /** For VLC on the phone: the channel with the request headers a bare link can't carry. No video goes through here. */
  api.get('/livetv/:key/vlc.m3u', (c) => {
    const ch = picked(c.req.param('key'));
    if (!ch) return c.json({ error: 'Not one of your channels' }, 404);
    return c.body(channelPlaylist(ch.name, ch.entry), 200, { 'content-type': 'audio/x-mpegurl', 'cache-control': 'no-store' });
  });

  /** For the TVs: the channel's qualities without its backup server's (see withoutBackups). No video goes through here. */
  api.get('/livetv/:key/tv.m3u8', async (c) => {
    const ch = picked(c.req.param('key'));
    if (!ch) return c.json({ error: 'Not one of your channels' }, 404);
    const r = await fetch(ch.entry.url, { headers: channelHeaders(ch.entry), signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!r?.ok) return c.json({ error: "The channel's address didn't answer" }, 502);
    return c.body(withoutBackups(await r.text(), r.url || ch.entry.url), 200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' });
  });
}
