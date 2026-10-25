import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const ALLOWED_HOSTS = new Set(['image.tmdb.org', 'assets.fanart.tv', 'img.youtube.com', 'i.ytimg.com', 'artworks.thetvdb.com', 'www.thetvdb.com', 'thetvdb.com']);
const TMDB_POSTER = [92, 154, 185, 342, 500, 780];
const TMDB_BACKDROP = [300, 780, 1280];

export function isAllowedImage(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && ALLOWED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** Pick the smallest TMDB size >= width, so TMDB does the resizing for us. */
export function tmdbSized(url: string, width: number): string | undefined {
  const m = /^(https:\/\/image\.tmdb\.org\/t\/p\/)(w\d+|original)(\/.+)$/.exec(url);
  if (!m) return undefined;
  const isBackdrop = /w(300|1280)$/.test(m[2]!) || width > 780;
  const sizes = isBackdrop ? TMDB_BACKDROP : TMDB_POSTER;
  const pick = sizes.find((s) => s >= width) ?? sizes[sizes.length - 1]!;
  return `${m[1]}w${pick}${m[3]}`;
}

let active = 0;
const waiting: Array<() => void> = [];
async function limit<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 6) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

const inflight = new Map<string, Promise<string>>();

/** Return a local cached JPEG for a remote image, resized to `width` px. */
export function cachedImage(dir: string, url: string, width: number): Promise<string> {
  const file = join(dir, createHash('sha1').update(`${url}|${width}`).digest('hex') + '.jpg');
  if (existsSync(file)) return Promise.resolve(file);
  if (inflight.has(file)) return inflight.get(file)!;
  const p = limit(async () => {
    mkdirSync(dir, { recursive: true });
    const sized = tmdbSized(url, width);
    const res = await fetch(sized ?? url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`image HTTP ${res.status}`);
    if (res.redirected && !isAllowedImage(res.url)) throw new Error('image redirected to a host that is not allowed');
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
    if (sized) await rename(tmp, file);
    else {
      // Non-TMDB art (fanart.tv posters are ~1000px): downscale with macOS sips.
      try {
        await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '--resampleWidth', String(width), tmp, '--out', file], { timeout: 30000 });
      } finally {
        await unlink(tmp).catch(() => {});
      }
    }
    return file;
  }).finally(() => inflight.delete(file));
  inflight.set(file, p);
  return p;
}

/** Store an uploaded image as a poster (normalized to JPEG, max 780px wide). */
export async function storeUpload(dir: string, name: string, data: Uint8Array): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${name}.upload`);
  const out = join(dir, `${name}.jpg`);
  await writeFile(tmp, data);
  try {
    await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', '-Z', '1170', tmp, '--out', out], { timeout: 30000 });
  } finally {
    await unlink(tmp).catch(() => {});
  }
  return out;
}

const ffmpegBin = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(existsSync) ?? 'ffmpeg';
const ffprobeBin = ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe'].find(existsSync) ?? 'ffprobe';

/** Grab a frame ~15% into a video as a thumbnail (Kodi-style "thumb" for files with no artwork). */
export function videoThumb(dir: string, key: string, videoPath: string): Promise<string> {
  const file = join(dir, `${key}.jpg`);
  if (existsSync(file)) return Promise.resolve(file);
  if (inflight.has(file)) return inflight.get(file)!;
  const p = limit(async () => {
    mkdirSync(dir, { recursive: true });
    let at = 60;
    try {
      const { stdout } = await run(ffprobeBin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath], { timeout: 20000 });
      const d = Number(stdout.trim());
      if (d > 0) at = Math.max(1, Math.round(d * 0.15));
    } catch {
      /* fall back to 60s */
    }
    await run(ffmpegBin, ['-v', 'error', '-ss', String(at), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', '-y', file], { timeout: 45000 });
    if (!existsSync(file)) throw new Error('no frame extracted');
    return file;
  }).finally(() => inflight.delete(file));
  inflight.set(file, p);
  return p;
}
