// Filename parsing: turns release-style names ("Title.2010.MULTi.VFF.1080p...-Wawacity.xx.mkv")
// into a clean title, year, episode info and quality badges.

export const VIDEO_EXT = new Set([
  'mkv', 'mp4', 'avi', 'mov', 'm4v', 'wmv', 'mpg', 'mpeg', 'ts', 'm2ts', 'divx', 'flv', 'webm', 'iso', 'vob', 'ogm', 'rmvb',
]);
export const SUB_EXT = new Set(['srt', 'smi', 'sub', 'idx', 'ass', 'ssa', 'vtt']);
// Files still being downloaded/copied: never index them.
export const PARTIAL_EXT = new Set(['part', 'crdownload', 'download', 'tmp', '!qb', 'partial']);

export interface Quality {
  res?: '4K' | '1080p' | '720p' | 'SD';
  hdr?: boolean;
  langs: string[]; // MULTI, VF, VFQ, VOSTFR, VO
  source?: string; // BluRay, WEB, HDTV, DVD
}

export interface Parsed {
  title: string;
  year?: number;
  altTitles: string[];
  season?: number;
  episode?: number;
  episodeTitle?: string;
  quality: Quality;
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function isVideo(name: string): boolean {
  return VIDEO_EXT.has(extOf(name));
}

// Release tags that never appear in real titles.
const STRONG = new Set([
  'multi', 'multi-vf2', 'vff', 'vfq', 'vfi', 'vf2', 'vf', 'voa', 'vost', 'vostfr', 'vosta', 'vita', 'truefrench', 'subforced',
  'fansub', '1080p', '720p', '2160p', '480p', '576p', '1080i', '4k', 'uhd', '4klight', 'hdlight', 'mhd', 'mhdgz', 'bluray',
  'blu-ray', 'bdrip', 'brrip', 'dvdrip', 'dvdscr', 'dvd5', 'dvd9', 'web-dl', 'webdl', 'webrip', 'web-dllight', 'hdtv', 'hdrip',
  'tvrip', 'hdcam', 'remux', 'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx', 'ac3', 'aac', 'dts', 'dts-hd', 'hdma',
  'ddp', 'dd5', 'eac3', 'e-ac3', 'truehd', 'atmos', '10bit', 'hdr', 'hdr10', 'dolby', 'nf', 'amzn', 'dsnp', 'hmax', 'atvp',
  'pmtp', 'yify', 'axxo', 'dvd', 'web', 'bdrip-light', 'hdlight-1080p', 'dual', 'r5', 'r6', 'telesync', 'screener', 'dvdscreener',
]);
// Tags that may be part of a real title; only stripped when they sit right before the release junk.
const WEAK = new Set([
  'french', 'fr', 'eng', 'english', 'vo', 'doc', 'light', 'extended', 'remastered', 'limited', 'unrated', 'uncut', 'stv',
  'directors', "director's", 'cut', 'internal', 'proper', 'repack', 'imax', 'complete', 'integrale', 'intégrale', 'dv', 'version',
  'edition', 'special', 'collector', 'theatrical', 'final', 'hd', 'sd', 'ma', 'audio', '5', '1', '7', 'da', 'famille', 'enfants',
  'line', 'hdligt',
]);

const YEAR_RE = /^(19[1-9]\d|20[0-4]\d)$/;
const SXXEYY_RE = /\bs(\d{1,2})[ ._-]?e(\d{1,3})\b/i;
const NXNN_RE = /\b(\d{1,2})x(\d{2,3})\b/i;

function decodePercent(s: string): string {
  if (!/%[0-9a-f]{2}/i.test(s)) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    // Latin-1 escapes like %c9 (É)
    return s.replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  }
}

function isStrong(tok: string): boolean {
  const t = tok.toLowerCase().replace(/[(),[\]+]/g, '');
  if (!t) return false;
  if (STRONG.has(t)) return true;
  if (/^\d{3,4}p$/.test(t)) return true;
  if (/^[xh]\.?26[45]$/.test(t)) return true;
  if (/^(dd|ddp|ac3|eac3|aac)\d(\.\d)?$/.test(t)) return true;
  if (/^multi[-(]/.test(t)) return true;
  if (/^(vff|vfq|vfi|vostfr)[-+]/.test(t)) return true;
  return false;
}

function isWeak(tok: string): boolean {
  return WEAK.has(tok.toLowerCase().replace(/[(),[\]]/g, ''));
}

/** Split a token on '-' when one of its parts is release junk (e.g. "Thieves-DVDRip", "kung-fu-2004-MULTI"). */
function splitDashed(tok: string): string[] {
  if (!tok.includes('-') || isStrong(tok)) return [tok];
  const parts = tok.split('-').filter(Boolean);
  return parts.some((p) => isStrong(p) || YEAR_RE.test(p)) ? parts : [tok];
}

function cleanTitle(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–:,]+|[\s\-–:,]+$/g, '')
    .trim();
}

export function parseQuality(name: string): Quality {
  const n = name.toLowerCase();
  const q: Quality = { langs: [] };
  if (/2160p|\b4k|uhd|4klight/.test(n)) q.res = '4K';
  else if (/1080[pi]/.test(n)) q.res = '1080p';
  else if (/720p/.test(n)) q.res = '720p';
  else if (/dvdrip|xvid|divx|480p|576p|dvdscr|tvrip|\.avi$/.test(n)) q.res = 'SD';
  if (/\bhdr|dolby.?vision|[ ._-]dv[ ._-]/.test(n)) q.hdr = true;
  if (/\bmulti/.test(n)) q.langs.push('MULTI');
  if (/\b(vff|vfi|vf2|truefrench|french|vf)\b|\bfr\b/.test(n)) q.langs.push('VF');
  if (/\bvfq\b/.test(n)) q.langs.push('VFQ');
  if (/vostfr|subforced|fansub/.test(n)) q.langs.push('VOSTFR');
  if (/blu-?ray|bdrip|brrip|remux/.test(n)) q.source = 'BluRay';
  else if (/web-?dl|webrip|\bweb\b|\bnf\b|amzn/.test(n)) q.source = 'WEB';
  else if (/hdtv|tvrip/.test(n)) q.source = 'TV';
  else if (/dvd/.test(n)) q.source = 'DVD';
  return q;
}

export function parseName(raw: string, opts: { isDir?: boolean } = {}): Parsed {
  // macOS SMB hands out decomposed (NFD) names; TMDB search finds nothing for "Aste\u0301rix".
  const input = raw.normalize('NFC');
  let s = input;
  if (!opts.isDir) {
    const ext = extOf(s);
    if (VIDEO_EXT.has(ext) || SUB_EXT.has(ext)) s = s.slice(0, -(ext.length + 1));
  }
  s = decodePercent(s);
  const quality = parseQuality(input);

  // Download-site suffixes and duplicate markers.
  s = s.replace(/[\s._-]*wawacity.*$/i, '');
  s = s.replace(/\bwww\.[^\s]+/gi, ' ');
  s = s.replace(/\s*\(\d\)$/, '');
  // Leading group tags: "[NeoRyu-Team]Title", "[Téléfilms de Noël] Title"
  s = s.replace(/^(\s*\[[^\]]*\]\s*)+/, '');
  s = s.replace(/^[._\s-]+/, '');

  // Episode markers.
  let season: number | undefined;
  let episode: number | undefined;
  let episodeTitle: string | undefined;
  const se = SXXEYY_RE.exec(s) ?? NXNN_RE.exec(s);
  if (se) {
    season = Number(se[1]);
    episode = Number(se[2]);
    const after = s.slice(se.index + se[0].length);
    const epTitle = cleanTitle(after.replace(/[._]/g, ' ').replace(/\(.*$/, '').split(/\s(?=\S*(?:1080p|720p|2160p|web|x26[45]|h26[45])\b)/i)[0] ?? '');
    if (epTitle && !isStrong(epTitle.split(' ')[0] ?? '')) episodeTitle = epTitle;
    s = s.slice(0, se.index);
  }

  // Bracketed groups: years, junk, or alternate titles.
  const altTitles: string[] = [];
  let bracketYear: number | undefined;
  s = s.replace(/[([]([^()[\]]*)[)\]]/g, (_m, inner: string) => {
    const c = cleanTitle(inner.replace(/[._]/g, ' '));
    if (YEAR_RE.test(c)) {
      bracketYear ??= Number(c);
      return ` ${c} `;
    }
    const toks = c.split(/[\s,+-]+/).filter(Boolean);
    if (toks.length === 0 || toks.some((t) => isStrong(t) || isWeak(t))) return ' ¦ ';
    altTitles.push(c);
    return ' † ';
  });

  const tokens = s
    .replace(/[._]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .flatMap(splitDashed);

  // First strong junk token (or a bracket marker) ends the title zone.
  let junk = tokens.findIndex((t) => t === '¦' || isStrong(t));
  if (junk === -1) junk = tokens.length;

  // Year: last year-looking token before the junk that isn't the very first token.
  let yearIdx = -1;
  for (let i = junk - 1; i >= 1; i--) {
    if (YEAR_RE.test(tokens[i]!)) {
      yearIdx = i;
      break;
    }
  }
  let end = yearIdx >= 0 ? yearIdx : junk;
  while (end > 1 && isWeak(tokens[end - 1]!)) end--;
  let titleToks = tokens.slice(0, end).filter((t) => t !== '†');
  let year = yearIdx >= 0 ? Number(tokens[yearIdx]) : bracketYear;

  // Words between the year and the junk are usually a translated title ("The.Body.2001.Le.Tombeau.TRUEFRENCH").
  if (yearIdx >= 0) {
    let altEnd = junk;
    while (altEnd > yearIdx + 1 && isWeak(tokens[altEnd - 1]!)) altEnd--;
    const between = tokens.slice(yearIdx + 1, altEnd).filter((t) => t !== '†' && !isWeak(t) && !YEAR_RE.test(t));
    if (between.length >= 2) altTitles.push(cleanTitle(between.join(' ')));
  }

  // A year-only name ("2012") is the title itself.
  if (titleToks.length === 0 && year !== undefined) {
    titleToks = [String(year)];
    year = undefined;
  }

  // Episode inside a folder: "Episode 9 Title", "029 - Show - Title"
  let title = cleanTitle(titleToks.join(' '));
  if (episode === undefined) {
    const ep = /^(?:episode|ep|épisode)\s*(\d{1,4})\b\s*[-:.]?\s*(.*)$/i.exec(title);
    if (ep) {
      episode = Number(ep[1]);
      episodeTitle = cleanTitle(ep[2] ?? '') || undefined;
    } else if (!opts.isDir) {
      const lead = /^(\d{2,4})\s*-\s*(.+)$/.exec(title);
      if (lead && !YEAR_RE.test(lead[1]!)) {
        episode = Number(lead[1]);
        const rest = lead[2]!.split(/\s+-\s+/);
        episodeTitle = cleanTitle(rest[rest.length - 1] ?? '') || undefined;
      }
    }
  }

  return { title, year, altTitles: [...new Set(altTitles)], season, episode, episodeTitle, quality };
}

/** Season number from a folder name: "Season 01", "S01", "Saison 2", "Dragon Ball Super - Season 03 - Universe 6 Saga" */
export function seasonFromDir(name: string): number | undefined {
  const m = /\b(?:season|saison|series)\s*(\d{1,2})\b/i.exec(name) ?? /\bs(\d{1,2})\b/i.exec(name);
  return m ? Number(m[1]) : undefined;
}

/** Lowercase, strip accents and punctuation: used for search and fuzzy comparisons. */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
