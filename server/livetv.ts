import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, posix, relative } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { type DB, tx } from './db.ts';
import { buildM3u, parseM3u, uniqueNames, type M3uEntry } from './iptv.ts';
import { guideCandidates, guideXml, matchGuide, readXmltv, type GuideChannel, type GuideIds, type Programme } from './epg.ts';
import { pool } from './scanner.ts';
import { EXTRA_CHANNELS } from './extraChannels.ts';

/** The channel lists the owner picks from, in this order: the first wins a channel both have. */
export const LIVE_LISTS = [
  { list: 'fr', url: 'https://iptv-org.github.io/iptv/countries/fr.m3u' },
  { list: 'be', url: 'https://iptv-org.github.io/iptv/countries/be.m3u' },
];

/** Each list's category, as the app and the TVs (a channel group in Kodi) name it; 'extra': EXTRA_CHANNELS. */
export const LIST_NAMES: Record<string, string> = { fr: 'France', be: 'Belgium', extra: 'Extra' };

/** A change to the live TV channels that can't be made as asked: the message says why. */
export class LiveError extends Error {}

export interface LiveChannel {
  key: string;
  number: number;
  name: string;
  logo: string;
  url: string;
  /** Its list: its category (LIST_NAMES) */
  list: string;
  /** Made for kids (the owner's call): the kids profiles' to watch */
  kids: boolean;
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
  /** The owner's own stream address for it; null: iptv-org's */
  stream: string | null;
  /** The owner's own logo for it (then `logo` too); null: iptv-org's */
  ownLogo: string | null;
  /** One of the owner's made for kids */
  kids: boolean;
}

type CatalogDbRow = { key: string; list: string; name: string; logo: string; grp: string; url: string; opts: string; seen_at: number; ok: number | null };

const entryOf = (r: CatalogDbRow): M3uEntry => ({ key: r.key, name: r.name, logo: r.logo, group: r.grp, opts: JSON.parse(r.opts) as string[], url: r.url });

/**
 * The entry the TVs and VLC get: at the owner's own address when they set one, then without iptv-org's request
 * headers; with the owner's own logo when they set one.
 */
const playedOf = (r: CatalogDbRow & { own: string | null; own_logo?: string | null }): M3uEntry => {
  const e = { ...entryOf(r), ...(r.own_logo ? { logo: r.own_logo } : {}) };
  return r.own ? { ...e, url: r.own, opts: [] } : e;
};

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

/** The owner's channels, in this order within each category. Their guide picks, own stream addresses and logos stay. */
export function setPicks(db: DB, picks: string[]): void {
  if (new Set(picks).size !== picks.length) throw new LiveError('A channel is in the list twice');
  const listOf = db.prepare('SELECT list FROM live_catalog WHERE key = ?');
  const lists = new Map<string, string>();
  for (const k of picks) {
    const r = listOf.get(k) as { list: string } | undefined;
    if (!r) throw new LiveError(`Unknown channel: ${k}`);
    lists.set(k, r.list);
  }
  // Numbered category by category, as Kodi groups them: each in the owner's order.
  const order = Object.keys(LIST_NAMES);
  const rank = (k: string) => (order.includes(lists.get(k)!) ? order.indexOf(lists.get(k)!) : order.length);
  const keys = [...picks].sort((a, b) => rank(a) - rank(b));
  const kept = new Map(
    (
      db.prepare('SELECT key, guide, url, kids, logo FROM live_channels').all() as Array<{ key: string; guide: string | null; url: string | null; kids: number; logo: string | null }>
    ).map((r) => [r.key, r]),
  );
  tx(db, () => {
    db.exec('DELETE FROM live_channels');
    const ins = db.prepare('INSERT INTO live_channels(key, position, guide, url, kids, logo) VALUES (?, ?, ?, ?, ?, ?)');
    keys.forEach((k, i) => ins.run(k, i + 1, kept.get(k)?.guide ?? null, kept.get(k)?.url ?? null, kept.get(k)?.kids ?? 0, kept.get(k)?.logo ?? null));
  });
}

/** The owner's own stream address for a channel of theirs, or back to iptv-org's (null). Not checked yet either way. */
export function setStream(db: DB, key: string, url: string | null): void {
  tx(db, () => {
    const r = db.prepare('UPDATE live_channels SET url = ? WHERE key = ?').run(url, key);
    if (!r.changes) throw new LiveError('Pick the channel first');
    db.prepare('UPDATE live_catalog SET ok = NULL, checked_at = NULL WHERE key = ?').run(key);
  });
}

/** One of the owner's channels made for kids, or not. */
export function setKids(db: DB, key: string, kids: boolean): void {
  const r = db.prepare('UPDATE live_channels SET kids = ? WHERE key = ?').run(kids ? 1 : 0, key);
  if (!r.changes) throw new LiveError('Pick the channel first');
}

/** The owner's own logo for a channel of theirs, or back to iptv-org's (null). */
export function setLogo(db: DB, key: string, url: string | null): void {
  const r = db.prepare('UPDATE live_channels SET logo = ? WHERE key = ?').run(url, key);
  if (!r.changes) throw new LiveError('Pick the channel first');
}

/** The owner's guide for a channel of theirs: another guide channel, none, or back to automatic (null). */
export function setGuidePick(db: DB, key: string, guide: { source: string; id: string } | 'none' | null): void {
  const value = guide === null ? null : guide === 'none' ? '' : `${guide.source}\t${guide.id}`;
  const r = db.prepare('UPDATE live_channels SET guide = ? WHERE key = ?').run(value, key);
  if (!r.changes) throw new LiveError('Pick the channel first');
}

/** The owner's channels as the TVs number and name them. */
export function pickedChannels(db: DB): Array<{ number: number; name: string; list: string; entry: M3uEntry; guide: string | null; listedUrl: string; kids: boolean }> {
  const rows = db.prepare(`SELECT c.*, p.guide, p.url AS own, p.logo AS own_logo, p.kids FROM live_channels p JOIN live_catalog c ON c.key = p.key ORDER BY p.position`).all() as Array<
    CatalogDbRow & { guide: string | null; own: string | null; own_logo: string | null; kids: number }
  >;
  const names = uniqueNames(rows.map((r) => r.name));
  // listedUrl: iptv-org's address, which a guide is matched on (a Pluto channel's id is in it).
  return rows.map((r, i) => ({ number: i + 1, name: names[i]!, list: r.list, entry: playedOf(r), guide: r.guide, listedUrl: r.url, kids: r.kids === 1 }));
}

/** The group of the TVs' list the kids channels are also in: Lumen's kids view plays from it. */
export const KIDS_GROUP = 'Kids';

// ParaTV's Dailymotion copies list a backup server's qualities the TVs' adaptive player mustn't take (see withoutBackups).
const viaApp = (url: string) => /-dm\.m3u8$/.test(url);

/**
 * The list both TVs read, each channel in its category's group. `app`: the app's address as they reach it, for the
 * channels they get through it (else directly). `guide`: where they read the guide file (Kodi's IPTV Simple takes
 * it from the list's first line when no guide is set on the TV).
 */
export function channelFileText(db: DB, app: string | null = null, guide: string | null = null): string {
  return buildM3u(pickedChannels(db).map((c) => ({
    entry: {
      ...c.entry,
      // A kids channel is also in the Kids group (IPTV Simple reads groups apart at ';').
      group: `${LIST_NAMES[c.list] ?? c.entry.group}${c.kids ? `;${KIDS_GROUP}` : ''}`,
      ...(app && viaApp(c.entry.url) ? { url: `${app}/api/livetv/${encodeURIComponent(c.entry.key)}/tv.m3u8` } : {}),
    },
    name: c.name,
  })), guide ?? undefined);
}

const DAY = 24 * 3600_000;

/** The guide both TVs read, next to the list: their channels over the days the TVs show (one back, four ahead). */
export function guideFileText(db: DB, sources: string[], now: number): string {
  return guideXml(liveGuide(db, sources, now - DAY, now + 4 * DAY));
}

/**
 * A file of the NAS as a TV reaches it, from where that TV reaches the media folder (its path prefix, as Kodi writes
 * it: smb://nas/video/MEDIA) and where this Mac does. Null while the TV's path isn't known.
 */
export function kodiPath(file: string, mediaRoot: string, prefix: string): string | null {
  if (!prefix) return null;
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)(\/.*)?$/i.exec(prefix);
  const [server, dir] = m ? [m[1]!, m[2] ?? '/'] : ['', prefix];
  return server + posix.join(dir, relative(mediaRoot, file));
}

/** Kodi's guide file: next to the list. */
export const guideFile = (liveFile: string): string => join(dirname(liveFile), 'guide.xml');

/** Where the TVs read the guide file, when every TV whose path is known reaches it at the same address. */
export function guideAddress(tvs: Array<{ pathPrefix: string }>, mediaRoot: string, liveFile: string): string | null {
  const file = guideFile(liveFile);
  const seen = new Set(tvs.map((t) => kodiPath(file, mediaRoot, t.pathPrefix)).filter((p) => p !== null));
  return seen.size === 1 ? [...seen][0]! : null;
}

type Nets = Record<string, Array<{ address: string; netmask: string; family: string; internal: boolean }> | undefined>;

const ipv4 = (s: string) => (/^\d{1,3}(\.\d{1,3}){3}$/.test(s) ? s.split('.').reduce((n, p) => n * 256 + Number(p), 0) : null);
const sameNet = (a: number, b: number, mask: number) => (a & mask) >>> 0 === (b & mask) >>> 0;

/** This Mac's address on the network of a device at `host` (an IPv4 address, by its netmask), or null when it has none there. */
export function addressToward(host: string, nets: Nets = networkInterfaces()): string | null {
  const h = ipv4(host);
  if (h === null) return null;
  for (const a of Object.values(nets).flat()) {
    if (!a || a.family !== 'IPv4' || a.internal) continue;
    const ip = ipv4(a.address), mask = ipv4(a.netmask);
    if (ip !== null && mask !== null && sameNet(ip, h, mask)) return a.address;
  }
  return null;
}

/** The app's address in the TVs' list: one every TV reaches, else null (they then get every channel directly). */
export function appAddress(hosts: string[], port: number, nets: Nets = networkInterfaces()): string | null {
  const ips = hosts.map((h) => addressToward(h, nets));
  return ips.length && ips[0] && ips.every((ip) => ip === ips[0]) ? `http://${ips[0]}:${port}` : null;
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
    const g = guide(c.entry.key, c.listedUrl, c.guide);
    const rows = g.source && g.id ? (q.all(g.source, g.id, from, to) as Array<Record<string, string | number | null>>) : [];
    const programmes = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) as Omit<Programme, 'channel'>);
    return { key: c.entry.key, number: c.number, name: c.name, logo: c.entry.logo, url: c.entry.url, list: c.list, kids: c.kids, vlc: c.entry.opts.length ? 'playlist' : 'direct', programmes };
  });
}

/** The owner's channel a TV names: as the list wrote it, else without case. */
const named = <T extends { name: string }>(all: T[], name: string): T | undefined =>
  all.find((x) => x.name === name) ?? all.find((x) => x.name.toLowerCase() === name.toLowerCase());

/** The owner's channel a TV plays, by the name it gives, with what's on and next. */
export function channelOnAir(db: DB, sources: string[], name: string, now: number): LiveChannel | null {
  const c = named(liveGuide(db, sources, now, now + 12 * 3600_000), name);
  return c ? { ...c, programmes: c.programmes.slice(0, 2) } : null;
}

/** Whether the channel a TV plays, by the name it gives, is one of the owner's made for kids. */
export function kidsChannelNamed(db: DB, name: string): boolean {
  return named(pickedChannels(db), name)?.kids === true;
}

/** Every channel the owner can pick, lists in their order, with where the owner put it and its guide. */
export function liveCatalog(db: DB, sources: string[]): CatalogRow[] {
  const guide = resolver(db, sources);
  const rows = db.prepare(`SELECT c.*, p.position, p.guide, p.url AS own, p.logo AS own_logo, p.kids, c.seen_at >= COALESCE(l.refreshed_at, 0) AS listed
    FROM live_catalog c LEFT JOIN live_channels p ON p.key = c.key LEFT JOIN live_lists l ON l.list = c.list`).all() as Array<
    CatalogDbRow & { position: number | null; guide: string | null; own: string | null; own_logo: string | null; listed: number; kids: number | null }
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
    logo: r.own_logo ?? r.logo,
    group: r.grp,
    ok: r.ok === null ? null : r.ok === 1,
    listed: r.listed === 1,
    position: r.position,
    guide: guide(r.key, r.url, r.guide),
    stream: r.own,
    ownLogo: r.own_logo,
    kids: r.kids === 1,
  }));
}

// ---------- refresh, stream checks, the file on the NAS ----------

/**
 * A file both TVs read (the list, the guide), on the NAS share. Not mounted (the share's folder is missing): nothing is written,
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

/** The request headers a channel asks for (its user agent and referrer). */
export function channelHeaders(entry: M3uEntry): Record<string, string> {
  const headers: Record<string, string> = {};
  const ua = vlcOpt(entry, 'http-user-agent');
  const referrer = vlcOpt(entry, 'http-referrer');
  if (ua) headers['user-agent'] = ua;
  if (referrer) headers.referer = referrer;
  return headers;
}

/**
 * The channel's stream answers: an HLS playlist, or a raw stream (France 3's relay sends MPEG-TS: typed as
 * video or binary, or starting with its sync byte), asked with the channel's own headers. An empty answer or a
 * text one (an error page) doesn't count. Only the first bytes are read: a raw stream never ends.
 */
export async function streamAnswers(entry: M3uEntry, fetchFn: typeof fetch = fetch, timeoutMs = 8000): Promise<boolean> {
  const ctrl = new AbortController();
  const headers = channelHeaders(entry);
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
  // The Extra channels aren't downloaded: they're there every time, after the lists.
  got.push({ list: 'extra', entries: EXTRA_CHANNELS.filter((e) => !kept.has(e.key)) });
  saveCatalog(db, got, now);
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
      const ended = await readXmltv(downloadText(res.body), {
        channel: (c) => void channels.push(c),
        programme: (p) => {
          if (want.has(p.channel.toLowerCase())) programmes.push(p);
        },
      });
      if (!channels.length) throw new Error('not a TV guide');
      // Cut short: what it had stays rather than half a guide.
      if (!ended) throw new Error('incomplete download');
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
  const q = db.prepare('SELECT c.*, p.url AS own FROM live_catalog c LEFT JOIN live_channels p ON p.key = c.key WHERE c.key = ?');
  // Only while the channel still has the address that was checked (the owner may have changed it meanwhile).
  const set = db.prepare(`UPDATE live_catalog SET ok = ?, checked_at = ? WHERE key = ?
    AND COALESCE((SELECT url FROM live_channels WHERE key = live_catalog.key), live_catalog.url) = ?`);
  type Row = CatalogDbRow & { own: string | null };
  const rows = keys.map((k) => q.get(k) as Row | undefined).filter((r): r is Row => !!r);
  await pool(rows, 6, async (r) => {
    const entry = playedOf(r);
    const ok = await streamAnswers(entry, fetchFn);
    set.run(ok ? 1 : 0, now, r.key, entry.url);
  });
}

/** Every channel of the guides, to pick a channel's guide by hand: sources in their order, then by name. */
export function guideChannels(db: DB, sources: string[]): Array<{ source: string; id: string; name: string }> {
  const q = db.prepare('SELECT source, id, name FROM epg_channels WHERE source = ?');
  return sources.flatMap((s) =>
    (q.all(s) as Array<{ source: string; id: string; name: string }>)
      .map((r) => ({ source: r.source, id: r.id, name: r.name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })),
  );
}

/** A channel of that guide, as last read. */
export function hasGuideChannel(db: DB, source: string, id: string): boolean {
  return !!db.prepare('SELECT 1 FROM epg_channels WHERE source = ? AND id = ?').get(source, id);
}
