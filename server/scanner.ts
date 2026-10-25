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

async function walkVideos(root: string, rel: string, season: number | undefined, out: ScannedFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
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

/** Walk the media root. Throws if the root is missing (NAS not mounted). */
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
    let entries;
    try {
      entries = await readdir(join(root, folder), { withFileTypes: true });
    } catch {
      continue;
    }
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
      if (!opts.known?.has(item.path)) toStat.push({ item });
    } else for (const f of item.files) if (!opts.known?.has(f.path)) toStat.push({ item, file: f });
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
  return items;
}
