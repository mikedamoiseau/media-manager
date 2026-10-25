import type { Card, Entry, Group, SetGroup, SetPart, TitleLang } from './types.ts';

export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const CATEGORIES: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'Everything' },
  { key: 'movies', label: 'Films' },
  { key: 'series', label: 'Series' },
  { key: 'animes', label: 'Anime' },
  { key: 'kids', label: 'Kids' },
  { key: 'shows', label: 'Shows' },
  { key: 'fitness', label: 'Fitness' },
  { key: 'courses', label: 'Courses' },
  { key: 'other', label: 'Other' },
];

export const categoryLabel = (k: string) => CATEGORIES.find((c) => c.key === k)?.label ?? k;

export const DECADES: Array<{ key: string; label: string; from: number; to: number }> = [
  { key: '2020', label: '2020s', from: 2020, to: 2099 },
  { key: '2010', label: '2010s', from: 2010, to: 2019 },
  { key: '2000', label: '2000s', from: 2000, to: 2009 },
  { key: '1990', label: '90s', from: 1990, to: 1999 },
  { key: '1980', label: '80s', from: 1980, to: 1989 },
  { key: 'old', label: 'Before 1980', from: 0, to: 1979 },
];

export type SortKey = 'added' | 'title' | 'year' | 'rating';
export type StatusKey = 'all' | 'unwatched' | 'progress' | 'review' | 'missing' | 'hidden';

export interface Filters {
  q: string;
  cat: string;
  genres: string[];
  decade: string | null;
  quality: string[];
  status: StatusKey;
  sort: SortKey;
}

export const DEFAULT_FILTERS: Filters = { q: '', cat: 'all', genres: [], decade: null, quality: [], status: 'all', sort: 'added' };

export function displayTitle(c: Pick<Card, 'fr' | 'en' | 'o'>, lang: TitleLang): { main: string; sub?: string } {
  const order = lang === 'fr' ? [c.fr, c.o, c.en] : lang === 'en' ? [c.en, c.o, c.fr] : [c.o, c.fr, c.en];
  const main = order[0]!;
  const sub = order.slice(1).find((t) => t && normalize(t) !== normalize(main));
  return { main, sub };
}

/** The plot follows the title language. Plots are kept in French and English only: VO uses the original language's when it is one of them. */
export function plotLang(lang: TitleLang, originalLanguage: string | null): 'fr' | 'en' {
  if (lang !== 'original') return lang;
  return originalLanguage === 'fr' ? 'fr' : 'en';
}

const RES_RANK: Record<string, number> ={ '4K': 4, '1080p': 3, '720p': 2, SD: 1 };
const rankCard = (c: Card) => (c.pr ? 100 : 0) + Math.max(0, ...c.q.map((q) => RES_RANK[q] ?? 0)) * 10 + (c.q.includes('HDR') ? 1 : 0);

/** Collapse versions of the same title; the best present copy represents the group. */
export function groupCards(items: Card[]): Group[] {
  const map = new Map<string, Card[]>();
  for (const c of items) {
    const list = map.get(c.g);
    if (list) list.push(c);
    else map.set(c.g, [c]);
  }
  const groups: Group[] = [];
  for (const [key, list] of map) {
    list.sort((a, b) => rankCard(b) - rankCard(a));
    groups.push({ key, main: list[0]!, items: list });
  }
  return groups;
}

export function allGenres(groups: Group[]): string[] {
  const count = new Map<string, number>();
  for (const g of groups) for (const ge of g.main.ge) count.set(ge, (count.get(ge) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
}

function statusMatch(g: Group, s: StatusKey): boolean {
  const present = g.items.some((c) => c.pr);
  const hidden = g.items.every((c) => c.h);
  if (s === 'hidden') return hidden;
  if (hidden) return false;
  if (s === 'missing') return !present;
  if (!present) return false;
  switch (s) {
    case 'unwatched':
      return !g.items.some((c) => c.w);
    case 'progress':
      return g.items.some((c) => c.rs);
    case 'review':
      return g.items.some((c) => c.pr && (c.m === 'unmatched' || c.m === 'pending'));
    default:
      return true;
  }
}

/** Filter + search + sort. Every query word must appear somewhere in the item's titles, people or file name. */
export function applyFilters(groups: Group[], f: Filters, lang: TitleLang): Group[] {
  const words = normalize(f.q).split(' ').filter(Boolean);
  const decade = DECADES.find((d) => d.key === f.decade);
  const out: Array<{ g: Group; score: number }> = [];
  for (const g of groups) {
    const c = g.main;
    if (f.cat !== 'all' && c.c !== f.cat) continue;
    if (!statusMatch(g, f.status)) continue;
    if (f.genres.length && !f.genres.every((ge) => c.ge.includes(ge))) continue;
    if (decade && (!c.y || c.y < decade.from || c.y > decade.to)) continue;
    if (f.quality.length && !f.quality.every((q) => g.items.some((i) => i.q.includes(q)))) continue;
    let score = 0;
    if (words.length) {
      let ok = true;
      for (const w of words) {
        if (/^\d{4}$/.test(w) && c.y === Number(w)) continue;
        if (!c.s.includes(w)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const q = words.join(' ');
      const titles = [c.fr, c.en, c.o].map(normalize);
      if (titles.some((t) => t === q)) score = 3;
      else if (titles.some((t) => t.startsWith(q))) score = 2;
      else if (titles.some((t) => t.includes(q))) score = 1;
    }
    out.push({ g, score });
  }
  const title = (g: Group) => normalize(displayTitle(g.main, lang).main);
  const by: Record<SortKey, (a: Group, b: Group) => number> = {
    added: (a, b) => b.main.a - a.main.a,
    title: (a, b) => title(a).localeCompare(title(b)),
    year: (a, b) => (b.main.y ?? 0) - (a.main.y ?? 0),
    rating: (a, b) => (b.main.r ?? 0) - (a.main.r ?? 0),
  };
  out.sort((a, b) => b.score - a.score || by[f.sort](a.g, b.g));
  return out.map((x) => x.g);
}

export const isSet = (e: Entry): e is SetGroup => 'members' in e;

/** Films of a set in release order, undated ones last. */
export const byRelease = (a: Group, b: Group) => (a.main.y ?? 9999) - (b.main.y ?? 9999);

/** TMDB names sets "Rocky Collection"; the tile only needs "Rocky". */
export const setName = (k: string) => k.replace(/\s+collection$/i, '');

/**
 * Collapse films of the same collection into one set entry. Sets come first, ordered by their
 * best-ranked film (by name when sorted by title and not searching), then the other titles as sorted.
 * Works on already filtered results, so a set only holds the films that match; a set with a
 * single match stays a plain title.
 */
export function groupSets(groups: Group[], f: Filters): Entry[] {
  const bySet = new Map<string, Group[]>();
  for (const g of groups) {
    const k = g.main.k;
    if (!k) continue;
    const list = bySet.get(k);
    if (list) list.push(g);
    else bySet.set(k, [g]);
  }
  const sets: SetGroup[] = [];
  const rest: Group[] = [];
  for (const g of groups) {
    const k = g.main.k;
    const members = k ? bySet.get(k)! : [];
    if (!k || members.length < 2) rest.push(g);
    else if (members[0] === g) sets.push({ key: k, name: setName(k), members: [...members].sort(byRelease) });
  }
  if (f.sort === 'title' && !normalize(f.q)) sets.sort((a, b) => normalize(a.name).localeCompare(normalize(b.name)));
  return [...sets, ...rest];
}

const tmdbMovieId = (g: Group) => (g.key.startsWith('movie:') ? Number(g.key.slice(6)) : null);
const onNas = (g: Group) => g.items.some((c) => c.pr) && !g.items.every((c) => c.h);

/**
 * A set page: the films shown (those passing the filters, like the set tile; every film on the NAS
 * when the filters leave none) and the films of the TMDB collection that are not on the NAS. A film
 * belongs to the set by its collection name or by being one of the collection's TMDB films.
 */
export function splitSet(key: string, parts: SetPart[], results: Group[], groups: Group[], today = new Date().toISOString().slice(0, 10)) {
  const ids = new Set(parts.map((p) => p.id));
  const inSet = (g: Group) => g.main.k === key || ids.has(tmdbMovieId(g) ?? -1);
  let available = results.filter(inSet);
  if (!available.length) available = groups.filter((g) => inSet(g) && onNas(g));
  available = [...available].sort(byRelease);
  const shown = new Set(available.map(tmdbMovieId));
  const owned = (p: SetPart) => groups.some((g) => tmdbMovieId(g) === p.id && onNas(g));
  const missing = parts
    .filter((p) => !shown.has(p.id) && !owned(p))
    .map((part) => ({ part, group: groups.find((g) => tmdbMovieId(g) === part.id) }));
  const released = parts.filter((p) => p.date && p.date <= today);
  return { available, missing, onNas: released.filter(owned).length, released: released.length };
}

/**
 * A set as a row on a film's page, in release order: each film of the TMDB collection with its
 * library title when there is one (hidden ones count as missing), then slotted in by year the
 * library's films of the set that TMDB doesn't list. Without the TMDB list: the library's films.
 */
export function setLineup(key: string, parts: SetPart[], groups: Group[]): Array<{ part?: SetPart; group?: Group }> {
  const shown = groups.filter((g) => !g.items.every((c) => c.h));
  const ids = new Set(parts.map((p) => p.id));
  const fromTmdb = parts.map((part) => ({ part, group: shown.find((g) => tmdbMovieId(g) === part.id) }));
  const extra = shown.filter((g) => g.main.k === key && !ids.has(tmdbMovieId(g) ?? -1)).map((group) => ({ group }));
  const year = (e: { part?: SetPart; group?: Group }) => (e.part?.date ? Number(e.part.date.slice(0, 4)) : (e.group?.main.y ?? 9999));
  return [...fromTmdb, ...extra].sort((a, b) => year(a) - year(b));
}

export function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return '';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function formatRuntime(min: number | null | undefined): string {
  if (!min) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`;
}

/** A release date as "22 Oct", with the year when it isn't this year's: "3 Mar 2027". */
export function formatDay(date: string, today = new Date()): string {
  const d = new Date(`${date}T12:00:00`);
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** "Thailand" for TH. */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function formatClock(sec = 0): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
