import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { type DB, tx } from './db.ts';
import { buildM3u, parseM3u, uniqueNames, type M3uEntry } from './iptv.ts';
import { guideCandidates, matchGuide, readXmltv, type GuideChannel, type GuideIds, type Programme } from './epg.ts';
import { pool } from './scanner.ts';

/** The channel lists the owner picks from, in this order: the first wins a channel both have. */
export const LIVE_LISTS = [
  { list: 'fr', url: 'https://iptv-org.github.io/iptv/countries/fr.m3u' },
  { list: 'be', url: 'https://iptv-org.github.io/iptv/countries/be.m3u' },
];

/** A change to the live TV channels that can't be made as asked: the message says why. */
export class LiveError extends Error {}

export interface LiveChannel {
  key: string;
  number: number;
  name: string;
  logo: string;
  url: string;
  /** How VLC on the phone gets it: the stream itself, or the app's one-channel playlist (for request headers) */
  vlc: 'direct' | 'playlist';
  programmes: Array<Omit<Programme, 'channel'>>;
}

export interface CatalogRow {
  key: string;
  list: string;
  name: string;
  logo: string;
  group: string;
  ok: boolean | null;
  /** In the latest refresh of its list */
  listed: boolean;
  position: number | null;
  guide: { mode: 'auto' | 'manual' | 'none'; source?: string; id?: string; name?: string };
}

type CatalogDbRow = { key: string; list: string; name: string; logo: string; grp: string; url: string; opts: string; seen_at: number; ok: number | null };

const entryOf = (r: CatalogDbRow): M3uEntry => ({ key: r.key, name: r.name, logo: r.logo, group: r.grp, opts: JSON.parse(r.opts) as string[], url: r.url });

/** iptv-org's channels, list by list. A channel whose address changed is checked again before it counts as answering. */
export function saveCatalog(db: DB, lists: Array<{ list: string; entries: M3uEntry[] }>, now: number): void {
  const up = db.prepare(`INSERT INTO live_catalog(key, list, name, logo, grp, url, opts, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET list = excluded.list, name = excluded.name, logo = excluded.logo, grp = excluded.grp,
      ok = CASE WHEN live_catalog.url = excluded.url THEN live_catalog.ok END,
      checked_at = CASE WHEN live_catalog.url = excluded.url THEN live_catalog.checked_at END,
      url = excluded.url, opts = excluded.opts, seen_at = excluded.seen_at`);
  const read = db.prepare('INSERT INTO live_lists(list, refreshed_at) VALUES (?, ?) ON CONFLICT(list) DO UPDATE SET refreshed_at = excluded.refreshed_at');
  const seen = new Set<string>();
  tx(db, () => {
    for (const { list, entries } of lists) {
      read.run(list, now);
      for (const e of entries) {
        if (seen.has(e.key)) continue;
        seen.add(e.key);
        up.run(e.key, list, e.name, e.logo, e.group, e.url, JSON.stringify(e.opts), now);
      }
    }
  });
}

/** The owner's channels, in this order. Their guide picks stay. */
export function setPicks(db: DB, keys: string[]): void {
  if (new Set(keys).size !== keys.length) throw new LiveError('A channel is in the list twice');
  const known = db.prepare('SELECT 1 FROM live_catalog WHERE key = ?');
  for (const k of keys) if (!known.get(k)) throw new LiveError(`Unknown channel: ${k}`);
  const guides = new Map((db.prepare('SELECT key, guide FROM live_channels').all() as Array<{ key: string; guide: string | null }>).map((r) => [r.key, r.guide]));
  tx(db, () => {
    db.exec('DELETE FROM live_channels');
    const ins = db.prepare('INSERT INTO live_channels(key, position, guide) VALUES (?, ?, ?)');
    keys.forEach((k, i) => ins.run(k, i + 1, guides.get(k) ?? null));
  });
}

/** The owner's guide for a channel of theirs: another guide channel, none, or back to automatic (null). */
export function setGuidePick(db: DB, key: string, guide: { source: string; id: string } | 'none' | null): void {
  const value = guide === null ? null : guide === 'none' ? '' : `${guide.source}\t${guide.id}`;
  const r = db.prepare('UPDATE live_channels SET guide = ? WHERE key = ?').run(value, key);
  if (!r.changes) throw new LiveError('Pick the channel first');
}

/** The owner's channels as the TVs number and name them. */
export function pickedChannels(db: DB): Array<{ number: number; name: string; entry: M3uEntry; guide: string | null }> {
  const rows = db.prepare(`SELECT c.*, p.guide FROM live_channels p JOIN live_catalog c ON c.key = p.key ORDER BY p.position`).all() as Array<
    CatalogDbRow & { guide: string | null }
  >;
  const names = uniqueNames(rows.map((r) => r.name));
  return rows.map((r, i) => ({ number: i + 1, name: names[i]!, entry: entryOf(r), guide: r.guide }));
}

/** The list both TVs read. */
export function channelFileText(db: DB): string {
  return buildM3u(pickedChannels(db).map((c) => ({ entry: c.entry, name: c.name })));
}

/** Each source's guide channels, by lower-case id, in the sources' order. */
export function guideIds(db: DB, sources: string[]): GuideIds[] {
  const q = db.prepare('SELECT id FROM epg_channels WHERE source = ?');
  return sources.map((source) => ({ source, ids: new Map((q.all(source) as Array<{ id: string }>).map((r) => [r.id.toLowerCase(), r.id])) }));
}

type Resolver = (key: string, url: string, guide: string | null) => CatalogRow['guide'];

/** Works out guides for many channels with the sources' ids read once. */
function resolver(db: DB, sources: string[]): Resolver {
  const ids = guideIds(db, sources);
  const nameQ = db.prepare('SELECT name FROM epg_channels WHERE source = ? AND id = ?');
  const named = (source: string, id: string) => (nameQ.get(source, id) as { name: string } | undefined)?.name ?? id;
  return (key, url, guide) => {
    if (guide === '') return { mode: 'none' };
    if (guide) {
      const [source, id] = guide.split('\t') as [string, string];
      return { mode: 'manual', source, id, name: named(source, id) };
    }
    const m = matchGuide({ key, url }, ids);
    return m ? { mode: 'auto', source: m.source, id: m.id, name: named(m.source, m.id) } : { mode: 'auto' };
  };
}

/** The guide channel of one of the owner's channels; none when it has none. */
export function guideOf(db: DB, key: string, sources: string[]): { source: string; id: string; name: string } | null {
  const r = db.prepare('SELECT c.url, p.guide FROM live_catalog c LEFT JOIN live_channels p ON p.key = c.key WHERE c.key = ?').get(key) as
    | { url: string; guide: string | null }
    | undefined;
  if (!r) return null;
  const g = resolver(db, sources)(key, r.url, r.guide);
  return g.source && g.id ? { source: g.source, id: g.id, name: g.name ?? g.id } : null;
}

/** One source's guide, in place of what it had. Programmes that ended over a day ago are not kept. */
export function storeGuide(db: DB, source: string, channels: GuideChannel[], programmes: Programme[], now: number): void {
  const keepFrom = now - 24 * 3600_000;
  tx(db, () => {
    db.prepare('DELETE FROM epg_channels WHERE source = ?').run(source);
    db.prepare('DELETE FROM epg_programmes WHERE source = ?').run(source);
    const ch = db.prepare('INSERT OR REPLACE INTO epg_channels(source, id, name) VALUES (?, ?, ?)');
    for (const c of channels) ch.run(source, c.id, c.name);
    const pr = db.prepare(`INSERT OR REPLACE INTO epg_programmes(source, channel, start, stop, title, sub, category, descr, icon)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of programmes) {
      if (p.stop > keepFrom) pr.run(source, p.channel, p.start, p.stop, p.title, p.sub ?? null, p.category ?? null, p.descr ?? null, p.icon ?? null);
    }
  });
}

/** The owner's channels with their programmes between `from` and `to`. */
export function liveGuide(db: DB, sources: string[], from: number, to: number): LiveChannel[] {
  const guide = resolver(db, sources);
  const q = db.prepare(`SELECT start, stop, title, sub, category, descr, icon FROM epg_programmes
    WHERE source = ? AND channel = ? AND stop > ? AND start < ? ORDER BY start`);
  return pickedChannels(db).map((c) => {
    const g = guide(c.entry.key, c.entry.url, c.guide);
    const rows = g.source && g.id ? (q.all(g.source, g.id, from, to) as Array<Record<string, string | number | null>>) : [];
    const programmes = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) as Omit<Programme, 'channel'>);
    return { key: c.entry.key, number: c.number, name: c.name, logo: c.entry.logo, url: c.entry.url, vlc: c.entry.opts.length ? 'playlist' : 'direct', programmes };
  });
}

/** Every channel the owner can pick, lists in their order, with where the owner put it and its guide. */
export function liveCatalog(db: DB, sources: string[]): CatalogRow[] {
  const guide = resolver(db, sources);
  const rows = db.prepare(`SELECT c.*, p.position, p.guide, c.seen_at >= COALESCE(l.refreshed_at, 0) AS listed
    FROM live_catalog c LEFT JOIN live_channels p ON p.key = c.key LEFT JOIN live_lists l ON l.list = c.list`).all() as Array<
    CatalogDbRow & { position: number | null; guide: string | null; listed: number }
  >;
  const order = (list: string) => {
    const i = LIVE_LISTS.findIndex((l) => l.list === list);
    return i < 0 ? LIVE_LISTS.length : i;
  };
  rows.sort((a, b) => order(a.list) - order(b.list) || a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
  return rows.map((r) => ({
    key: r.key,
    list: r.list,
    name: r.name,
    logo: r.logo,
    group: r.grp,
    ok: r.ok === null ? null : r.ok === 1,
    listed: r.listed === 1,
    position: r.position,
    guide: guide(r.key, r.url, r.guide),
  }));
}

// ---------- refresh, stream checks, the file on the NAS ----------

/**
 * The list both TVs read, on the NAS share. Not mounted (the share's folder is missing): nothing is written,
 * not even a folder, which would sit on the Mac's own disk in the share's place. Written whole (a temporary
 * file renamed), so Kodi never reads half of it; not again when unchanged.
 */
export function writeChannelFile(file: string, text: string): 'written' | 'same' | 'not_mounted' {
  const dir = dirname(file);
  if (!existsSync(dirname(dir))) return 'not_mounted';
  if (!existsSync(dir)) mkdirSync(dir);
  // Kodi doesn't scan a folder holding .nomedia: the list is never taken for a title.
  if (!existsSync(join(dir, '.nomedia'))) writeFileSync(join(dir, '.nomedia'), '');
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return 'same';
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
  return 'written';
}

/** A #EXTVLCOPT value of a channel (http-user-agent, http-referrer). */
function vlcOpt(entry: M3uEntry, name: string): string | undefined {
  for (const l of entry.opts) {
    const m = /^#EXTVLCOPT:([\w-]+)=(.*)$/.exec(l);
    if (m?.[1] === name) return m[2];
  }
  return undefined;
}

/**
 * The channel's stream answers: an HLS playlist, or a raw stream (France 3's relay sends MPEG-TS: typed as
 * video or binary, or starting with its sync byte), asked with the channel's own headers. An empty answer or a
 * text one (an error page) doesn't count. Only the first bytes are read: a raw stream never ends.
 */
export async function streamAnswers(entry: M3uEntry, fetchFn: typeof fetch = fetch, timeoutMs = 8000): Promise<boolean> {
  const ctrl = new AbortController();
  const headers: Record<string, string> = {};
  const ua = vlcOpt(entry, 'http-user-agent');
  const referrer = vlcOpt(entry, 'http-referrer');
  if (ua) headers['user-agent'] = ua;
  if (referrer) headers.referer = referrer;
  const check = async () => {
    const res = await fetchFn(entry.url, { headers, signal: ctrl.signal });
    if (!res.ok || !res.body) return false;
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    while (size < 4096) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      size += value.length;
    }
    void reader.cancel().catch(() => {});
    if (!size) return false;
    const head = Buffer.concat(parts);
    const type = res.headers.get('content-type') ?? '';
    return head.toString('latin1').includes('#EXTM3U') || /^(video|audio)\/|octet-stream|mp2t/.test(type) || head[0] === 0x47;
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([check(), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), timeoutMs)))]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

/**
 * iptv-org's lists again. A list that fails, or comes back empty, leaves its channels as they were, and keeps
 * the channels it owns: the next list can't take them over.
 */
export async function refreshCatalog(db: DB, fetchFn: typeof fetch, now: number): Promise<Array<{ list: string; error?: string }>> {
  const got: Array<{ list: string; entries: M3uEntry[] }> = [];
  const out: Array<{ list: string; error?: string }> = [];
  const owned = db.prepare('SELECT key FROM live_catalog WHERE list = ?');
  const kept = new Set<string>();
  for (const { list, url } of LIVE_LISTS) {
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const entries = parseM3u(await res.text());
      if (!entries.length) throw new Error('no channel in the list');
      got.push({ list, entries: entries.filter((e) => !kept.has(e.key)) });
      out.push({ list });
    } catch (e) {
      for (const r of owned.all(list) as Array<{ key: string }>) kept.add(r.key);
      out.push({ list, error: (e as Error).message });
    }
  }
  if (got.length) saveCatalog(db, got, now);
  return out;
}

/** A download as text, unpacked when it is gzip (the guides come as .xml.gz). */
async function* downloadText(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const src = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  const it = src[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  // Gzip is told by its first two bytes, which the network may hand over in two pieces.
  let head = Buffer.alloc(0);
  let n = await it.next();
  while (!n.done) {
    head = Buffer.concat([head, n.value]);
    if (head.length >= 2) break;
    n = await it.next();
  }
  if (!head.length) return;
  const gzip = head[0] === 0x1f && head[1] === 0x8b;
  const raw = Readable.from((async function* () {
    yield head;
    if (n.done) return;
    for (let m = await it.next(); !m.done; m = await it.next()) yield m.value;
  })());
  const out = gzip ? raw.pipe(createGunzip()) : raw;
  out.setEncoding('utf8');
  for await (const chunk of out) yield chunk as string;
}

/**
 * The guide ids (lower case) a channel of the catalog could match in `source`, and the owner's picks there:
 * known before the guide is read, so the order of its elements doesn't matter.
 */
function wantedIds(db: DB, source: string): Set<string> {
  const want = new Set<string>();
  for (const r of db.prepare('SELECT key, url FROM live_catalog').all() as Array<{ key: string; url: string }>) {
    for (const id of guideCandidates(r)) want.add(id);
  }
  for (const r of db.prepare("SELECT guide FROM live_channels WHERE guide LIKE ? || char(9) || '%'").all(source) as Array<{ guide: string }>) {
    want.add(r.guide.slice(source.length + 1).toLowerCase());
  }
  return want;
}

/**
 * Each guide again, in its place. Only the programmes of guide channels in use are kept (the big one has
 * 210,000). A source that fails, or sends something else than a guide, keeps what it had.
 */
export async function refreshGuides(db: DB, sources: string[], fetchFn: typeof fetch, now: number): Promise<Array<{ source: string; error?: string }>> {
  const out: Array<{ source: string; error?: string }> = [];
  for (const source of sources) {
    try {
      const res = await fetchFn(source, { signal: AbortSignal.timeout(180_000) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const channels: GuideChannel[] = [];
      const programmes: Programme[] = [];
      const want = wantedIds(db, source);
      await readXmltv(downloadText(res.body), {
        channel: (c) => void channels.push(c),
        programme: (p) => {
          if (want.has(p.channel.toLowerCase())) programmes.push(p);
        },
      });
      if (!channels.length) throw new Error('not a TV guide');
      storeGuide(db, source, channels, programmes, now);
      out.push({ source });
    } catch (e) {
      out.push({ source, error: (e as Error).message });
    }
  }
  return out;
}

/** Whether each channel's stream answers, a few at a time. */
export async function checkStreams(db: DB, keys: string[], fetchFn: typeof fetch, now: number): Promise<void> {
  const q = db.prepare('SELECT * FROM live_catalog WHERE key = ?');
  const set = db.prepare('UPDATE live_catalog SET ok = ?, checked_at = ? WHERE key = ?');
  const rows = keys.map((k) => q.get(k) as CatalogDbRow | undefined).filter((r): r is CatalogDbRow => !!r);
  await pool(rows, 6, async (r) => {
    const ok = await streamAnswers(entryOf(r), fetchFn);
    set.run(ok ? 1 : 0, now, r.key);
  });
}
