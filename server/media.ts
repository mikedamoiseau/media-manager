import type { DB } from './db.ts';
import { fromKodiPath } from './kodi.ts';

const TYPES: Record<string, string> = {
  mkv: 'video/x-matroska',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  webm: 'video/webm',
  wmv: 'video/x-ms-wmv',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
};

export function videoType(path: string): string {
  return TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * The byte range of a Range header (inclusive). null: send the whole file; 'invalid': answer 416.
 * Players seek with one range at a time, so only the first of several is honoured.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  const m = header && /^bytes=(\d*)-(\d*)/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  let start: number;
  let end: number;
  if (a === '') {
    if (b === '') return 'invalid';
    start = Math.max(0, size - Number(b));
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  return start >= size || start > end ? 'invalid' : { start, end };
}

/** Where VLC starts, in seconds, and the tracks it plays (VLC's numbers, from 0, in file order). */
export interface HandoffOptions {
  start: number;
  audio?: number;
  sub?: number | 'off';
}

/**
 * A one-entry playlist that makes VLC start the stream at a time, with these tracks: VLC for iOS takes
 * none of that in its links, but honours it in a playlist. It also remembers the tracks last used for
 * an address and those win, so each handoff streams from an address of its own (checked on an iPhone,
 * 2026-10-25).
 */
export function vlcPlaylist(url: string, title: string, o: HandoffOptions): string {
  const name = title.replace(/[\r\n]+/g, ' ');
  const opts = [`start-time=${Math.max(0, Math.floor(o.start))}`];
  if (o.audio !== undefined) opts.push(`audio-track=${o.audio}`);
  // Off on the TV: none in VLC either, though the film may flag one as default.
  if (o.sub === 'off') opts.push('sub-language=none');
  else if (o.sub !== undefined) opts.push(`sub-track=${o.sub}`);
  return ['#EXTM3U', `#EXTINF:-1,${name}`, ...opts.map((x) => `#EXTVLCOPT:${x}`), url, ''].join('\n');
}

/** "t445-a2-s1-k<key>" (or "soff"; tracks optional) from a handoff address. Null if malformed. */
export function parseHandoff(s: string): (HandoffOptions & { key: string }) | null {
  const m = /^t(\d+)(?:-a(\d+))?(?:-s(\d+|off))?-k([a-z0-9]+)$/.exec(s);
  if (!m) return null;
  return { start: Number(m[1]), audio: m[2] ? Number(m[2]) : undefined, sub: m[3] === undefined ? undefined : m[3] === 'off' ? 'off' : Number(m[3]), key: m[4]! };
}

/**
 * The file of the library Kodi is playing, as the media route serves it: a film file, or an episode.
 * Not a film in its own folder (nothing streams it). Paths are matched in both Unicode forms:
 * macOS lists names decomposed, Kodi sends them composed.
 */
export function kodiMedia(db: DB, prefix: string, file: string): { kind: 'item' | 'episode'; id: number; ext: string } | undefined {
  const rel = prefix ? fromKodiPath(prefix, file) : undefined;
  if (!rel) return undefined;
  const ext = /\.[^./]+$/.exec(rel)?.[0] ?? '';
  for (const p of new Set([rel, rel.normalize('NFD'), rel.normalize('NFC')])) {
    const it = db.prepare('SELECT id FROM items WHERE path = ? AND present = 1 AND is_dir = 0').get(p) as { id: number } | undefined;
    if (it) return { kind: 'item', id: it.id, ext };
    const ep = db.prepare('SELECT e.id FROM episodes e JOIN items i ON i.id = e.item_id WHERE e.path = ? AND e.present = 1 AND i.present = 1').get(p) as { id: number } | undefined;
    if (ep) return { kind: 'episode', id: ep.id, ext };
  }
  return undefined;
}
