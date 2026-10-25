import { Hono, type Context } from 'hono';
import { compress } from 'hono/compress';
import { streamSSE } from 'hono/streaming';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform, pipeline } from 'node:stream';
import type { Service } from './service.ts';
import { libraryCards, libraryVersion, itemDetail, img } from './views.ts';
import { setParts, ownedSetKeys, staleSetKeys } from './sets.ts';
import { duplicateFilms, incompleteSets } from './reports.ts';
import { pool } from './scanner.ts';
import { parseRange, videoType, vlcPlaylist, kodiMedia, parseHandoff } from './media.ts';
import { suggestions, recordActivity, rate } from './suggestions.ts';
import { elsewhere, cinema, inCinemas, filmDetails, asFilm, getPick, setPick, wantedFilms } from './films.ts';
import { continueWatching, dismissWatching, noteStreamed, noteEpisodeStreamed, nextEpisode } from './watching.ts';
import { sheetIdFrom } from './sheet.ts';
import { cachedImage, isAllowedImage, storeUpload, videoThumb } from './images.ts';
import {
  KodiError, discoverKodi, nowPlaying, streams, remote, play, playTrailer, toKodiPath, powerOptions, power, sendText, type RemoteAction,
} from './kodi.ts';
import { Tmdb, type Candidate } from './tmdb.ts';
import { ensureTitle, slimCandidates } from './metadata.ts';
import type { Settings } from './db.ts';
import type { MediaType } from './scanner.ts';

function sendFile(file: string, maxAge = 31536000): Response {
  const st = statSync(file);
  const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(stream, {
    headers: {
      'content-type': 'image/jpeg',
      'content-length': String(st.size),
      'cache-control': `public, max-age=${maxAge}, immutable`,
    },
  });
}

function maskKey(k: string): string {
  return k ? `••••${k.slice(-4)}` : '';
}

function publicSettings(s: Settings) {
  return { ...s, tmdbKey: maskKey(s.tmdbKey), kodiPass: s.kodiPass ? '••••' : '' };
}

export function createApi(svc: Service): Hono {
  const api = new Hono();
  const db = svc.db;

  api.use('*', compress());

  api.onError((err, c) => {
    if (err instanceof KodiError) return c.json({ error: err.message, code: `kodi_${err.code}` }, 502);
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  // ---------- library ----------

  api.get('/library', (c) => {
    const version = libraryVersion(db);
    const etag = `"${version}"`;
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    c.header('etag', etag);
    c.header('cache-control', 'no-cache');
    return c.json({ version, items: libraryCards(db) });
  });

  api.get('/items/:id', (c) => {
    const d = itemDetail(db, Number(c.req.param('id')));
    return d ? c.json(d) : c.json({ error: 'Not found' }, 404);
  });

  api.patch('/items/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const body = (await c.req.json()) as { hidden?: boolean; watched?: boolean };
    if (body.hidden !== undefined) db.prepare('UPDATE items SET hidden = ?, updated_at = ? WHERE id = ?').run(body.hidden ? 1 : 0, Date.now(), id);
    svc.libraryChanged(true);
    return c.json(itemDetail(db, id));
  });

  /** Manual match: {type, tmdbId} | {none: true} (not on TMDB) | {reset: true} (match again automatically) */
  api.post('/items/:id/match', async (c) => {
    const id = Number(c.req.param('id'));
    const body = (await c.req.json()) as { type?: MediaType; tmdbId?: number; none?: boolean; reset?: boolean };
    const now = Date.now();
    if (body.none) {
      db.prepare("UPDATE items SET tmdb_id = NULL, match_state = 'none', match_source = 'manual', candidates = NULL, updated_at = ? WHERE id = ?").run(now, id);
    } else if (body.reset) {
      db.prepare("UPDATE items SET tmdb_id = NULL, match_state = 'pending', match_source = NULL, media_type = COALESCE(media_type, 'movie'), updated_at = ? WHERE id = ?").run(now, id);
      void svc.metadata();
    } else if (body.type && body.tmdbId) {
      const tmdb = svc.tmdb();
      if (!tmdb) return c.json({ error: 'Add a TMDB API key in Settings first' }, 400);
      await ensureTitle(db, tmdb, body.type, body.tmdbId, true);
      db.prepare("UPDATE items SET tmdb_id = ?, media_type = ?, match_state = 'manual', match_source = 'manual', candidates = NULL, updated_at = ? WHERE id = ?").run(body.tmdbId, body.type, now, id);
    } else return c.json({ error: 'Nothing to do' }, 400);
    svc.libraryChanged(true);
    return c.json(itemDetail(db, id));
  });

  /** TMDB search for the manual match dialog (movies and shows together). */
  api.get('/search', async (c) => {
    const tmdb = svc.tmdb();
    if (!tmdb) return c.json({ error: 'Add a TMDB API key in Settings first' }, 400);
    const q = c.req.query('q')?.trim();
    if (!q) return c.json({ results: [] });
    const year = Number(c.req.query('year')) || undefined;
    const [m, t] = await Promise.all([tmdb.search('movie', q, year), tmdb.search('tv', q, year)]);
    const all: Candidate[] = [...m, ...t].sort((a, b) => b.popularity - a.popularity);
    return c.json({ results: slimCandidates(all) });
  });

  // ---------- artwork ----------

  api.get('/img', async (c) => {
    const u = c.req.query('u') ?? '';
    const w = Math.max(92, Math.min(1280, Number(c.req.query('w')) || 342));
    if (!isAllowedImage(u)) return c.json({ error: 'Image host not allowed' }, 400);
    try {
      return sendFile(await cachedImage(svc.imagesDir('img'), u, w));
    } catch {
      return c.body(null, 404);
    }
  });

  api.get('/thumb/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const it = db.prepare("SELECT path, is_dir FROM items WHERE id = ? AND source = 'disk'").get(id) as { path: string; is_dir: number } | undefined;
    if (!it) return c.body(null, 404);
    let rel = it.path;
    if (it.is_dir) {
      const ep = db.prepare('SELECT path FROM episodes WHERE item_id = ? ORDER BY season IS NULL, season, episode IS NULL, episode, path LIMIT 1').get(id) as { path: string } | undefined;
      if (!ep) return c.body(null, 404);
      rel = ep.path;
    }
    const full = join(svc.settings().mediaRoot, rel);
    if (!existsSync(full)) return c.body(null, 404);
    try {
      return sendFile(await videoThumb(svc.imagesDir('thumbs'), `i${id}`, full), 86400 * 30);
    } catch {
      return c.body(null, 404);
    }
  });

  api.get('/poster/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const row = db.prepare('SELECT custom_poster FROM items WHERE id = ?').get(id) as { custom_poster: string | null } | undefined;
    const cp = row?.custom_poster;
    if (!cp) return c.body(null, 404);
    if (cp.startsWith('url:')) return sendFile(await cachedImage(svc.imagesDir('img'), cp.slice(4), 780));
    const f = join(svc.imagesDir('posters'), `${cp.slice(5)}.jpg`);
    return existsSync(f) ? sendFile(f) : c.body(null, 404);
  });

  /** Alternative posters for the artwork picker. */
  api.get('/items/:id/posters', async (c) => {
    const tmdb = svc.tmdb();
    const it = db.prepare('SELECT media_type, tmdb_id FROM items WHERE id = ?').get(Number(c.req.param('id'))) as { media_type: MediaType; tmdb_id: number | null } | undefined;
    if (!tmdb || !it?.tmdb_id) return c.json({ posters: [] });
    return c.json({ posters: (await tmdb.posters(it.media_type, it.tmdb_id)).slice(0, 40) });
  });

  /** Set the poster from a URL ({url}), an uploaded image (raw image/* body), or reset it ({reset: true}). */
  api.post('/items/:id/poster', async (c) => {
    const id = Number(c.req.param('id'));
    const type = c.req.header('content-type') ?? '';
    let value: string | null;
    if (type.startsWith('image/')) {
      if (Number(c.req.header('content-length') ?? 0) > 15 * 1024 * 1024) return c.json({ error: 'Image too large' }, 413);
      const buf = new Uint8Array(await c.req.arrayBuffer());
      if (buf.length > 15 * 1024 * 1024) return c.json({ error: 'Image too large' }, 413);
      const name = `${id}-${Date.now()}`;
      await storeUpload(svc.imagesDir('posters'), name, buf);
      value = `file:${name}`;
    } else {
      const body = (await c.req.json()) as { url?: string; reset?: boolean };
      if (body.reset) value = null;
      else if (body.url && isAllowedImage(body.url)) value = `url:${body.url}`;
      else return c.json({ error: 'Unsupported image URL' }, 400);
    }
    db.prepare('UPDATE items SET custom_poster = ?, updated_at = ? WHERE id = ?').run(value, Date.now(), id);
    svc.libraryChanged(true);
    return c.json(itemDetail(db, id));
  });

  // ---------- Kodi ----------

  function kodi() {
    const cfg = svc.kodiConfig();
    if (!cfg) throw new KodiError('unreachable', 'Kodi is not set up yet');
    return cfg;
  }

  type Episode = { path: string; kodi_id: number | null };

  /**
   * The original video file with byte ranges, so a player on the phone (VLC) can seek. kind "item": a film,
   * or the next episode of a series folder as Play on TV picks it; kind "episode": that episode.
   * The last segment is only a readable name for the player.
   */
  const media = (c: Context) => {
    const id = Number(c.req.param('id'));
    let rel: string | undefined;
    let itemId = id;
    // What the bytes VLC takes are counted against, for Continue watching.
    let progress: ((start: number, sent: number, size: number) => void) | undefined;
    if (c.req.param('kind') === 'episode') {
      const ep = db.prepare('SELECT e.path, e.item_id FROM episodes e JOIN items i ON i.id = e.item_id WHERE e.id = ? AND i.present = 1').get(id) as
        | { path: string; item_id: number }
        | undefined;
      rel = ep?.path;
      itemId = ep?.item_id ?? id;
      if (ep) progress = (start, sent, size) => noteEpisodeStreamed(db, id, start, sent, size);
    } else {
      const it = db.prepare('SELECT path, is_dir FROM items WHERE id = ? AND present = 1').get(id) as { path: string; is_dir: number } | undefined;
      const ep = it?.is_dir ? nextEpisode(db, id) : undefined;
      rel = it && (it.is_dir ? ep?.path : it.path);
      if (it && !it.is_dir) progress = (start, sent, size) => noteStreamed(db, id, start, sent, size);
      else if (ep) progress = (start, sent, size) => noteEpisodeStreamed(db, ep.id, start, sent, size);
    }
    if (!rel) return c.json({ error: 'File is not on the NAS' }, 404);
    const file = join(svc.settings().mediaRoot, rel);
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      /* gone since the last scan */
    }
    if (!size) return c.json({ error: 'File is not on the NAS' }, 404);
    const range = parseRange(c.req.header('range'), size);
    const base = { 'accept-ranges': 'bytes', 'content-type': videoType(rel), 'cache-control': 'no-store' };
    if (range === 'invalid') return c.body(null, 416, { ...base, 'content-range': `bytes */${size}` });
    const { start, end } = range ?? { start: 0, end: size - 1 };
    const headers = { ...base, 'content-length': String(end - start + 1), ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) };
    const status = range ? 206 : 200;
    if (c.req.method === 'HEAD') return c.body(null, status, headers);
    // VLC asks again on every seek; recordActivity counts one play per half hour.
    recordActivity(db, itemId, 'play');
    const source = createReadStream(file, { start, end });
    if (!progress) return c.body(Readable.toWeb(source) as ReadableStream, status, headers);
    // Count what VLC actually takes, for Continue watching. pipeline keeps the backpressure and
    // closes the file when VLC drops the connection (it does on every seek).
    let sent = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        sent += chunk.length;
        done(null, chunk);
      },
    });
    pipeline(source, counter, () => progress(start, sent, size));
    return c.body(Readable.toWeb(counter) as ReadableStream, status, headers);
  };
  api.get('/media/:kind/:id/:name', media);
  // The same, under an address of its own (the key is ignored): see vlcPlaylist.
  api.get('/media/:kind/:id/:key/:name', media);

  /** Stop the TV if it still plays this file: the phone took over. */
  const stopIfPlaying = async (kind: string, id: number) => {
    const cfg = svc.kodiConfig();
    if (!cfg) return;
    const np = await nowPlaying(cfg);
    const m = np.active && np.file ? kodiMedia(db, svc.settings().kodiPathPrefix, np.file) : undefined;
    if (m?.kind === kind && m.id === id) await remote(cfg, 'stop');
  };

  /**
   * The Remote's Continue on this device: a playlist that starts VLC where the TV is, with its tracks (see
   * vlcPlaylist). VLC loading it proves VLC opened, so the TV stops then, not on the tap; it may load
   * it more than once, and a second stop finds nothing playing.
   */
  api.get('/handoff/:kind/:id/:opts/:name', (c) => {
    const kind = c.req.param('kind');
    const id = Number(c.req.param('id'));
    const o = parseHandoff(c.req.param('opts'));
    const name = c.req.param('name').replace(/\.m3u$/, '');
    if ((kind !== 'item' && kind !== 'episode') || !Number.isInteger(id) || !o) return c.json({ error: 'Not found' }, 404);
    void stopIfPlaying(kind, id).catch((e: Error) => console.warn(`Handoff: could not stop the TV (${e.message})`));
    // On the address the phone used, as the media links.
    const url = new URL(`/api/media/${kind}/${id}/${o.key}/${encodeURIComponent(name)}`, c.req.url).href;
    return c.body(vlcPlaylist(url, name, o), 200, { 'content-type': 'audio/x-mpegurl', 'cache-control': 'no-store' });
  });

  api.post('/items/:id/play', async (c) => {
    const id = Number(c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as { episodeId?: number };
    const cfg = kodi();
    const prefix = svc.settings().kodiPathPrefix;
    const it = db.prepare('SELECT path, is_dir, present, kodi_id, kodi_type FROM items WHERE id = ?').get(id) as
      | { path: string; is_dir: number; present: number; kodi_id: number | null; kodi_type: string | null }
      | undefined;
    if (!it || !it.present) return c.json({ error: 'File is not on the NAS' }, 404);
    if (!prefix) return c.json({ error: 'Kodi path for the media folder is unknown: set it in Settings' }, 400);
    if (it.is_dir) {
      const ep = body.episodeId
        ? (db.prepare('SELECT path, kodi_id FROM episodes WHERE id = ? AND item_id = ?').get(body.episodeId, id) as Episode | undefined)
        : nextEpisode(db, id);
      if (!ep) return c.json({ error: 'No episode found' }, 404);
      await play(cfg, ep.kodi_id ? { episodeid: ep.kodi_id } : { file: toKodiPath(prefix, ep.path) });
    } else if (it.kodi_id && it.kodi_type === 'movie') {
      await play(cfg, { movieid: it.kodi_id });
    } else {
      await play(cfg, { file: toKodiPath(prefix, it.path) });
    }
    recordActivity(db, id, 'play');
    return c.json({ ok: true });
  });

  /** Pages opened and trailers watched in the app, for suggestions (plays are recorded where they happen). */
  api.post('/items/:id/activity', async (c) => {
    const id = Number(c.req.param('id'));
    const { kind } = (await c.req.json().catch(() => ({}))) as { kind?: string };
    if (kind !== 'open' && kind !== 'trailer') return c.json({ error: 'Unknown activity' }, 400);
    if (!db.prepare('SELECT 1 FROM items WHERE id = ?').get(id)) return c.json({ error: 'Not found' }, 404);
    recordActivity(db, id, kind);
    return c.json({ ok: true });
  });

  /** Like (1) or not (-1) a film you watched; null clears it. */
  api.put('/items/:id/rating', async (c) => {
    const d = itemDetail(db, Number(c.req.param('id')));
    if (!d) return c.json({ error: 'Not found' }, 404);
    const { value } = (await c.req.json().catch(() => ({}))) as { value?: unknown };
    if (value !== 1 && value !== -1 && value !== null) return c.json({ error: 'Unknown rating' }, 400);
    if (!d.canRate) return c.json({ error: 'Only films you watched can be rated' }, 409);
    rate(db, d.mediaType!, d.tmdbId!, value);
    return c.json({ rating: value });
  });

  api.post('/items/:id/trailer', async (c) => {
    const d = itemDetail(db, Number(c.req.param('id')));
    if (!d?.trailer) return c.json({ error: 'No trailer' }, 404);
    await playTrailer(kodi(), d.trailer);
    recordActivity(db, d.id, 'trailer');
    return c.json({ ok: true });
  });

  api.get('/continue', (c) => c.json({ items: continueWatching(db) }));

  api.post('/continue/:id/dismiss', (c) => {
    const id = Number(c.req.param('id'));
    if (!db.prepare('SELECT 1 FROM items WHERE id = ?').get(id)) return c.json({ error: 'Not found' }, 404);
    dismissWatching(db, id);
    return c.json({ ok: true });
  });

  api.get('/suggestions', async (c) => c.json({ suggestions: await suggestions(db, svc.tmdb() ?? null) }));

  // Films not on the NAS: picked from your tastes, in cinemas, and the page of each.
  api.get('/elsewhere', async (c) =>
    c.json({ films: (await elsewhere(db, svc.tmdb() ?? null)).map(({ film, because }) => ({ ...film, poster: img(film.poster, 342), because })) }),
  );

  api.get('/cinema', async (c) => {
    const country = svc.settings().cinemaCountry;
    return c.json({ country, films: (await cinema(db, svc.tmdb() ?? null, country)).map((f) => ({ ...f, poster: img(f.poster, 342) })) });
  });

  const cinemaHit = (id: number) => {
    const country = svc.settings().cinemaCountry;
    const hit = inCinemas(country, id);
    return hit ? { ...hit, country } : null;
  };

  api.get('/films/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Not found' }, 404);
    const d = await filmDetails(db, svc.tmdb() ?? null, id);
    if (!d) return c.json({ error: 'Add a TMDB key in Settings to see films that aren’t on the NAS' }, 404);
    const copy = db.prepare(`SELECT id FROM items WHERE media_type = 'movie' AND tmdb_id = ? AND present = 1 ORDER BY hidden, size DESC LIMIT 1`).get(id) as
      | { id: number }
      | undefined;
    return c.json({
      ...asFilm(d),
      poster: img(d.poster, 780),
      backdrop: img(d.backdrop, 1280),
      y: d.year ?? null,
      runtime: d.runtime ?? null,
      r: d.rating || null,
      votes: d.votes ?? null,
      ge: d.genres,
      overviewFr: d.overviewFr ?? null,
      overviewEn: d.overviewEn ?? null,
      tagline: d.tagline ?? null,
      trailer: d.trailer ?? null,
      cast: d.cast,
      directors: d.directors,
      imdbId: d.imdbId ?? null,
      originalLanguage: d.originalLanguage ?? null,
      pick: getPick(db, id),
      itemId: copy?.id ?? null,
      cinema: cinemaHit(id),
    });
  });

  api.put('/films/:id/pick', async (c) => {
    const id = Number(c.req.param('id'));
    const { pick } = (await c.req.json().catch(() => ({}))) as { pick?: unknown };
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Not found' }, 404);
    if (pick !== 'want' && pick !== 'skip' && pick !== null) return c.json({ error: 'Unknown choice' }, 400);
    setPick(db, id, pick);
    return c.json({ pick });
  });

  api.post('/films/:id/trailer', async (c) => {
    const d = await filmDetails(db, svc.tmdb() ?? null, Number(c.req.param('id')));
    if (!d?.trailer) return c.json({ error: 'No trailer' }, 404);
    await playTrailer(kodi(), d.trailer);
    return c.json({ ok: true });
  });

  let countries: Promise<Array<{ code: string; name: string }>> | null = null;
  api.get('/countries', async (c) => {
    const tmdb = svc.tmdb();
    if (!tmdb) return c.json({ countries: [] });
    countries ??= tmdb.countries().catch((e: Error) => {
      countries = null;
      throw e;
    });
    return c.json({ countries: await countries });
  });

  // Every film of a set, owned or not (empty without a TMDB key).
  api.get('/set', async (c) => {
    const key = c.req.query('name');
    if (!key) return c.json({ error: 'Missing set name' }, 400);
    const tmdb = svc.tmdb();
    const parts = tmdb ? await setParts(db, tmdb, key) : [];
    return c.json({ parts: parts.map((p) => ({ ...p, poster: img(p.poster, 342) })) });
  });

  // Lists opened from Settings: copies to clean up, sets to complete, films to get.
  api.get('/reports/duplicates', (c) => c.json({ films: duplicateFilms(db) }));

  api.get('/reports/wanted', async (c) => c.json({ films: (await wantedFilms(db, svc.tmdb() ?? null)).map((f) => ({ ...f, poster: img(f.poster, 342) })) }));

  let setFill: Promise<void> | null = null;
  api.get('/reports/sets', (c) => {
    const keys = ownedSetKeys(db);
    const stale = staleSetKeys(db, keys);
    const tmdb = svc.tmdb();
    // Film lists not fetched yet come in the background (about two minutes the first time); the page asks again until done.
    if (stale.length && tmdb && !setFill) {
      setFill = pool(stale, 4, async (k) => void (await setParts(db, tmdb, k).catch(() => []))).finally(() => {
        setFill = null;
      });
    }
    return c.json({ sets: incompleteSets(db), total: keys.length, checked: keys.length - stale.length, running: !!setFill, tmdb: !!tmdb });
  });

  api.get('/kodi/now', async (c) => {
    const np = await nowPlaying(kodi());
    // Which file of the library it is, so the phone can take over in VLC.
    const media = np.active && np.file ? kodiMedia(db, svc.settings().kodiPathPrefix, np.file) : undefined;
    return c.json(media ? { ...np, media } : np);
  });

  api.get('/kodi/streams', async (c) => c.json(await streams(kodi())));

  api.post('/kodi/remote', async (c) => {
    const body = (await c.req.json()) as { action: RemoteAction; value?: number };
    await remote(kodi(), body.action, body.value);
    return c.json({ ok: true });
  });

  api.post('/kodi/input', async (c) => {
    const { text } = (await c.req.json()) as { text?: unknown };
    if (typeof text !== 'string' || text.length > 1000) return c.json({ error: 'Text for Kodi is missing or too long' }, 400);
    await sendText(kodi(), text);
    return c.json({ ok: true });
  });

  api.get('/kodi/power', async (c) => c.json(await powerOptions(kodi())));

  api.post('/kodi/power', async (c) => {
    const { action } = (await c.req.json()) as { action?: string };
    if (action !== 'shutdown' && action !== 'reboot') return c.json({ error: 'Unknown power action' }, 400);
    if (!(await powerOptions(kodi()))[action]) {
      return c.json({ error: action === 'shutdown' ? 'This Kodi box cannot be shut down remotely' : 'This Kodi box cannot be restarted remotely' }, 409);
    }
    await power(kodi(), action);
    return c.json({ ok: true });
  });

  api.post('/kodi/discover', async (c) => c.json({ found: await discoverKodi() }));

  // ---------- settings & jobs ----------

  api.get('/status', (c) => c.json(svc.status));

  api.get('/settings', (c) => c.json(publicSettings(svc.settings())));

  api.put('/settings', async (c) => {
    const body = (await c.req.json()) as Partial<Settings>;
    const patch: Partial<Settings> = {};
    const keys: Array<keyof Settings> = ['mediaRoot', 'kodiHost', 'kodiPort', 'kodiUser', 'kodiPathPrefix', 'scanIntervalMin', 'sheetId'];
    for (const k of keys) if (body[k] !== undefined) (patch as Record<string, unknown>)[k] = body[k];
    if (body.cinemaCountry !== undefined) {
      if (!/^[A-Z]{2}$/.test(body.cinemaCountry)) return c.json({ error: 'Unknown country' }, 400);
      patch.cinemaCountry = body.cinemaCountry;
    }
    if (patch.sheetId !== undefined) patch.sheetId = sheetIdFrom(String(patch.sheetId));
    const newSheet = !!patch.sheetId && patch.sheetId !== svc.settings().sheetId;
    if (body.kodiPass !== undefined && body.kodiPass !== '••••') patch.kodiPass = body.kodiPass;
    let newKey = false;
    if (body.tmdbKey !== undefined && !body.tmdbKey.startsWith('••••')) {
      const key = body.tmdbKey.trim();
      if (key && !(await new Tmdb(key).validate())) return c.json({ error: 'TMDB rejected this key' }, 400);
      patch.tmdbKey = key;
      newKey = !!key;
    }
    const s = svc.updateSettings(patch);
    if (newKey) void svc.metadata();
    if (newSheet) void svc.importSheet();
    if (patch.kodiHost !== undefined || patch.kodiPathPrefix !== undefined) void svc.syncKodi();
    return c.json(publicSettings(s));
  });

  api.post('/scan', (c) => {
    void svc.scan();
    return c.json({ ok: true });
  });

  api.post('/sheet/import', (c) => {
    void svc.importSheet();
    return c.json({ ok: true });
  });

  /** Search TMDB again for every file that didn't get a confident match. */
  api.post('/match/retry', (c) => {
    const r = db.prepare("UPDATE items SET match_state = 'pending', candidates = NULL, updated_at = ? WHERE match_state = 'unmatched'").run(Date.now());
    svc.libraryChanged(true);
    void svc.metadata();
    return c.json({ ok: true, count: Number(r.changes) });
  });

  /** Pull to refresh: look for new files on the NAS, then ask Kodi what was watched. */
  api.post('/refresh', async (c) => {
    await svc.scan();
    await svc.syncKodi();
    return c.json({ ok: true });
  });

  api.post('/kodi/sync', (c) => {
    void svc.metadata();
    return c.json({ ok: true });
  });

  api.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      let open = true;
      const onStatus = (s: unknown) => void stream.writeSSE({ event: 'status', data: JSON.stringify(s) });
      const onLibrary = () => void stream.writeSSE({ event: 'library', data: libraryVersion(db) });
      svc.on('status', onStatus);
      svc.on('library', onLibrary);
      stream.onAbort(() => {
        open = false;
        svc.off('status', onStatus);
        svc.off('library', onLibrary);
      });
      await stream.writeSSE({ event: 'status', data: JSON.stringify(svc.status) });
      while (open) {
        await stream.sleep(25000);
        if (open) await stream.writeSSE({ event: 'ping', data: '' });
      }
    }),
  );

  return api;
}
