import { existsSync, readdirSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isVideo, extOf, PARTIAL_EXT, parseName, seasonFromDir } from './parse.ts';

export type MediaType = 'movie' | 'tv';

export interface CategoryRule {
  category: string;
  /** TMDB type for loose files in the folder (null = don't look up) */
  fileType: MediaType | null;
  /** TMDB type for sub-folders (shows, collections) */
  dirType: MediaType | null;
}

const RULES: Record<string, CategoryRule> = {
  MOVIES: { category: 'movies', fileType: 'movie', dirType: 'movie' },
  ANIMES: { category: 'animes', fileType: 'movie', dirType: 'tv' },
  KIDS: { category: 'kids', fileType: 'movie', dirType: 'tv' },
  SERIES: { category: 'series', fileType: 'tv', dirType: 'tv' },
  SHOWS: { category: 'shows', fileType: 'movie', dirType: 'tv' },
  FITNESS: { category: 'fitness', fileType: null, dirType: null },
  COURSES: { category: 'courses', fileType: null, dirType: null },
};

/** MOVIES2 / ANIMES_TEMP share the rule of their base folder. */
export function ruleFor(folder: string): CategoryRule {
  if (!folder) return { category: 'other', fileType: null, dirType: null };
  const base = folder.toUpperCase().replace(/[\s_-]*(\d+|TEMP|TMP|NEW)$/, '');
  return RULES[base] ?? { category: 'other', fileType: 'movie', dirType: 'tv' };
}

export interface ScannedFile {
  path: string;
  size?: number;
  mtime?: number;
  season?: number;
  episode?: number;
  title?: string;
}

export interface ScannedItem {
  path: string;
  folder: string;
  category: string;
  isDir: boolean;
  mediaType: MediaType | null;
  size?: number;
  mtime?: number;
  files: ScannedFile[];
}

const IGNORED_DIR = /^(\.|@eaDir$|#recycle$|#snapshot$|\$RECYCLE\.BIN$|System Volume Information$)/i;

function skipName(name: string): boolean {
  return name.startsWith('.') || name.startsWith('._') || PARTIAL_EXT.has(extOf(name));
}

async function statSafe(p: string): Promise<{ size: number; mtime: number } | undefined> {
  try {
    const s = await stat(p);
    return { size: s.size, mtime: Math.round(s.mtimeMs) };
  } catch {
    return undefined;
  }
}

/** Run async jobs with bounded concurrency (SMB stat calls are slow one by one). */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  });
  await Promise.all(workers);
}

const EXTRAS_DIR = /featurette|extras?\b|bonus|behind.the.scenes|making.of/i;

/** A folder that can't be listed (the NAS dropped mid-scan?) stops the scan: skipping it would count its files as gone. */
async function listDir(root: string, rel: string) {
  try {
    return await readdir(join(root, rel), { withFileTypes: true });
  } catch (e) {
    throw new Error(`Couldn't read ${rel}: ${(e as { code?: string }).code ?? (e as Error).message} (did the NAS disconnect?)`);
  }
}

async function walkVideos(root: string, rel: string, season: number | undefined, out: ScannedFile[]): Promise<void> {
  const entries = await listDir(root, rel);
  for (const e of entries) {
    if (skipName(e.name)) continue;
    const childRel = `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (IGNORED_DIR.test(e.name)) continue;
      const s = EXTRAS_DIR.test(e.name) ? 0 : (seasonFromDir(e.name) ?? season);
      await walkVideos(root, childRel, s, out);
    } else if (isVideo(e.name)) {
      const p = parseName(e.name);
      out.push({ path: childRel, season: p.season ?? season, episode: p.episode, title: p.episodeTitle });
    }
  }
}

export interface ScanOptions {
  /** Paths whose size is already known: skip the (slow) stat call for them. */
  known?: Set<string>;
  onProgress?: (msg: string) => void;
}

/** Walk the media root. Throws if the root or a folder in it can't be read (NAS not mounted, or gone mid-scan). */
export async function scanMediaRoot(root: string, opts: ScanOptions = {}): Promise<ScannedItem[]> {
  const top = await readdir(root, { withFileTypes: true });
  const items: ScannedItem[] = [];
  for (const e of top) {
    if (skipName(e.name)) continue;
    if (e.isFile() && isVideo(e.name)) {
      const rule = ruleFor('');
      items.push({ path: e.name, folder: '', category: rule.category, isDir: false, mediaType: rule.fileType, files: [] });
      continue;
    }
    if (!e.isDirectory() || IGNORED_DIR.test(e.name)) continue;
    const folder = e.name;
    const rule = ruleFor(folder);
    opts.onProgress?.(`Scanning ${folder}`);
    const entries = await listDir(root, folder);
    for (const c of entries) {
      if (skipName(c.name)) continue;
      const rel = `${folder}/${c.name}`;
      if (c.isDirectory()) {
        if (IGNORED_DIR.test(c.name)) continue;
        const files: ScannedFile[] = [];
        await walkVideos(root, rel, seasonFromDir(c.name), files);
        if (!files.length) continue;
        items.push({ path: rel, folder, category: rule.category, isDir: true, mediaType: rule.dirType, files });
      } else if (isVideo(c.name)) {
        items.push({ path: rel, folder, category: rule.category, isDir: false, mediaType: rule.fileType, files: [] });
      }
    }
  }

  // Sizes: only for paths not seen before.
  const toStat: Array<{ item: ScannedItem; file?: ScannedFile }> = [];
  for (const item of items) {
    if (!item.isDir) {
      if (!opts.known?.has(nfc(item.path))) toStat.push({ item });
    } else for (const f of item.files) if (!opts.known?.has(nfc(f.path))) toStat.push({ item, file: f });
  }
  if (toStat.length) opts.onProgress?.(`Reading ${toStat.length} new files`);
  await pool(toStat, 16, async ({ item, file }) => {
    const s = await statSafe(join(root, file?.path ?? item.path));
    if (!s) return;
    if (file) {
      file.size = s.size;
      file.mtime = s.mtime;
    } else {
      item.size = s.size;
      item.mtime = s.mtime;
    }
  });
  // Read through the names as listed; known by one form of them.
  return composed(items);
}

/**
 * Scanned items with their paths in one form (see nfc). Two names that differ only in form (a disk that keeps
 * both) are one entry: the first listed, so a scan never fails on them. Two such folders aren't merged: the
 * second's files are left out (they couldn't be opened from the shared path either).
 */
export function composed(items: ScannedItem[]): ScannedItem[] {
  const seen = new Set<string>();
  const out: ScannedItem[] = [];
  for (const item of items) {
    item.path = nfc(item.path);
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    item.folder = nfc(item.folder);
    item.files = item.files.filter((f) => {
      f.path = nfc(f.path);
      if (seen.has(f.path)) return false;
      seen.add(f.path);
      return true;
    });
    out.push(item);
  }
  return out;
}

/**
 * Paths are kept composed (NFC): macOS lists a NAS's names decomposed, Linux (the Home Assistant add-on) as the
 * NAS stores them, mostly composed. One form, so a library moved between them still knows its files.
 */
export const nfc = (p: string): string => p.normalize('NFC');

/**
 * A file of the library on disk, from its (NFC) path: as the NAS stores it, for one stored decomposed (each
 * folder and file name in either form). Not there: the plain path.
 */
export function onDisk(root: string, rel: string): string {
  const full = join(root, rel);
  if (existsSync(full)) return full;
  let at = root;
  for (const name of rel.split('/')) {
    if (existsSync(join(at, name))) {
      at = join(at, name);
      continue;
    }
    let listed: string | undefined;
    try {
      listed = readdirSync(at).find((n) => nfc(n) === nfc(name));
    } catch {
      /* not a folder, or gone */
    }
    if (listed === undefined) return full;
    at = join(at, listed);
  }
  return at;
}
