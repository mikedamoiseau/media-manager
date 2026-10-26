import { normalize } from './parse.ts';
import type { MediaType } from './scanner.ts';
import { CERT_COUNTRIES, type Certs } from './kids.ts';

const API = 'https://api.themoviedb.org/3';
export const IMG = 'https://image.tmdb.org/t/p';

export class TmdbError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Candidate {
  id: number;
  type: MediaType;
  title: string;
  originalTitle: string;
  year?: number;
  poster?: string;
  popularity: number;
  overview?: string;
  /** All titles seen for this candidate across searches (localized + original) */
  titles: string[];
  score?: number;
}

export interface TitleDetails {
  type: MediaType;
  id: number;
  titleEn?: string;
  titleFr?: string;
  originalTitle?: string;
  originalLanguage?: string;
  year?: number;
  /** first release date (YYYY-MM-DD) */
  released?: string;
  genres: string[];
  overviewEn?: string;
  overviewFr?: string;
  tagline?: string;
  runtime?: number;
  rating?: number;
  votes?: number;
  poster?: string;
  backdrop?: string;
  trailer?: string;
  cast: Array<{ name: string; character?: string }>;
  directors: string[];
  imdbId?: string;
  collection?: string;
  seasons?: number;
  /** age ratings (Germany, France, US); none fetched: undefined */
  certs?: Certs;
}

/** One film of a collection. */
export interface CollectionPart {
  id: number;
  fr: string;
  en: string;
  o: string;
  /** release date (YYYY-MM-DD), null when not announced */
  date: string | null;
  poster: string | null;
}

type Fetch = typeof fetch;

/** Small TMDB v3 client. Accepts a v3 API key or a v4 "API Read Access Token". */
export class Tmdb {
  private key: string;
  private fetchFn: Fetch;
  private queue: Promise<void> = Promise.resolve();
  private minGapMs: number;

  constructor(key: string, fetchFn: Fetch = fetch, minGapMs = 30) {
    this.key = key.trim();
    this.fetchFn = fetchFn;
    this.minGapMs = minGapMs;
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    // Pace requests (TMDB allows ~40/s); serialize the start of each call.
    const turn = this.queue.then(() => new Promise<void>((r) => setTimeout(r, this.minGapMs)));
    this.queue = turn;
    await turn;
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.key.startsWith('eyJ')) headers.authorization = `Bearer ${this.key}`;
    else url.searchParams.set('api_key', this.key);
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(url, { headers, signal: AbortSignal.timeout(15000) });
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new TmdbError(res.status, `TMDB ${path}: HTTP ${res.status}`);
      return (await res.json()) as T;
    }
  }

  async validate(): Promise<boolean> {
    try {
      await this.get('/configuration');
      return true;
    } catch (e) {
      if (e instanceof TmdbError && e.status === 401) return false;
      throw e;
    }
  }

  async search(type: MediaType, query: string, year?: number, language = 'fr-FR'): Promise<Candidate[]> {
    type R = {
      id: number; title?: string; name?: string; original_title?: string; original_name?: string;
      release_date?: string; first_air_date?: string; poster_path?: string | null; popularity: number; overview?: string;
    };
    const res = await this.get<{ results: R[] }>(`/search/${type}`, {
      query: query.normalize('NFC'),
      language,
      include_adult: 'false',
      ...(type === 'movie' ? { year } : { first_air_date_year: year }),
    });
    return res.results.slice(0, 10).map((r) => {
      const title = r.title ?? r.name ?? '';
      const originalTitle = r.original_title ?? r.original_name ?? title;
      const date = r.release_date ?? r.first_air_date;
      return {
        id: r.id,
        type,
        title,
        originalTitle,
        year: date ? Number(date.slice(0, 4)) || undefined : undefined,
        poster: r.poster_path ? `${IMG}/w342${r.poster_path}` : undefined,
        popularity: r.popularity,
        overview: r.overview,
        titles: [title, originalTitle],
      };
    });
  }

  /** TMDB's "if you liked this" list, best first. */
  async recommendations(type: MediaType, id: number): Promise<number[]> {
    const d = await this.get<{ results?: Array<{ id: number }> }>(`/${type}/${id}/recommendations`, { language: 'en-US', page: 1 });
    return (d.results ?? []).map((r) => r.id);
  }

  /** The collection (film set) a movie belongs to. */
  async collectionOf(movieId: number): Promise<number | undefined> {
    const d = await this.get<{ belongs_to_collection?: { id: number } | null }>(`/movie/${movieId}`);
    return d.belongs_to_collection?.id;
  }

  /** Every film of a collection in release order (undated last), with French and English titles. */
  async collectionParts(id: number): Promise<CollectionPart[]> {
    const [fr, en] = await Promise.all(['fr-FR', 'en-US'].map((language) => this.get<{ parts?: FilmResult[] }>(`/collection/${id}`, { language })));
    return bilingual(fr?.parts ?? [], en?.parts ?? []).sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
  }

  /** Films in cinemas (now_playing) or coming soon (upcoming) in a country, most popular first, dated for that country. */
  async cinemaList(list: 'now_playing' | 'upcoming', region: string): Promise<CollectionPart[]> {
    const [fr, en] = await Promise.all(['fr-FR', 'en-US'].map((language) => this.get<{ results?: FilmResult[] }>(`/movie/${list}`, { language, region, page: 1 })));
    return bilingual(fr?.results ?? [], en?.results ?? []);
  }

  /** Countries TMDB knows release dates for. */
  async countries(): Promise<Array<{ code: string; name: string }>> {
    const r = await this.get<Array<{ iso_3166_1: string; english_name: string }>>('/configuration/countries', { language: 'en-US' });
    return r.map((c) => ({ code: c.iso_3166_1, name: c.english_name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async details(type: MediaType, id: number): Promise<TitleDetails> {
    type Video = { key: string; site: string; type: string; official?: boolean; iso_639_1?: string };
    type Translation = { iso_639_1: string; iso_3166_1: string; data: { title?: string; name?: string; overview?: string } };
    type D = {
      id: number; title?: string; name?: string; original_title?: string; original_name?: string; original_language?: string;
      release_date?: string; first_air_date?: string; genres?: Array<{ name: string }>; overview?: string; tagline?: string;
      runtime?: number; episode_run_time?: number[]; vote_average?: number; vote_count?: number; poster_path?: string | null;
      backdrop_path?: string | null; imdb_id?: string; external_ids?: { imdb_id?: string }; number_of_seasons?: number;
      belongs_to_collection?: { name: string } | null; created_by?: Array<{ name: string }>;
      videos?: { results: Video[] }; credits?: { cast: Array<{ name: string; character?: string }>; crew: Array<{ name: string; job: string }> };
      translations?: { translations: Translation[] };
      release_dates?: { results: Array<{ iso_3166_1: string; release_dates?: Array<{ certification?: string }> }> };
      content_ratings?: { results: Array<{ iso_3166_1: string; rating?: string }> };
    };
    const d = await this.get<D>(`/${type}/${id}`, {
      language: 'en-US',
      append_to_response: type === 'tv' ? 'videos,credits,translations,external_ids,content_ratings' : 'videos,credits,translations,release_dates',
      include_video_language: 'fr,en,null',
    });
    const tr = d.translations?.translations ?? [];
    const fr = tr.find((t) => t.iso_639_1 === 'fr' && t.iso_3166_1 === 'FR') ?? tr.find((t) => t.iso_639_1 === 'fr');
    const date = d.release_date ?? d.first_air_date;
    const titleEn = d.title ?? d.name;
    return {
      type,
      id: d.id,
      titleEn,
      titleFr: fr?.data.title || fr?.data.name || undefined,
      originalTitle: d.original_title ?? d.original_name,
      originalLanguage: d.original_language,
      year: date ? Number(date.slice(0, 4)) || undefined : undefined,
      released: date || undefined,
      genres: (d.genres ?? []).map((g) => g.name),
      overviewEn: d.overview || undefined,
      overviewFr: fr?.data.overview || undefined,
      tagline: d.tagline || undefined,
      runtime: d.runtime ?? d.episode_run_time?.[0],
      rating: d.vote_average,
      votes: d.vote_count,
      poster: d.poster_path ? `${IMG}/w780${d.poster_path}` : undefined,
      backdrop: d.backdrop_path ? `${IMG}/w1280${d.backdrop_path}` : undefined,
      trailer: pickTrailer(d.videos?.results ?? []),
      cast: (d.credits?.cast ?? []).slice(0, 12).map((c) => ({ name: c.name, character: c.character || undefined })),
      directors:
        type === 'tv'
          ? (d.created_by ?? []).map((c) => c.name)
          : (d.credits?.crew ?? []).filter((c) => c.job === 'Director').map((c) => c.name),
      imdbId: d.imdb_id ?? d.external_ids?.imdb_id,
      collection: d.belongs_to_collection?.name,
      seasons: d.number_of_seasons,
      certs: certsOf(d.release_dates?.results.map((r) => [r.iso_3166_1, (r.release_dates ?? []).map((x) => x.certification)])
        ?? d.content_ratings?.results.map((r) => [r.iso_3166_1, [r.rating]])),
    };
  }

  async posters(type: MediaType, id: number): Promise<Array<{ url: string; lang?: string; votes: number }>> {
    const r = await this.get<{ posters: Array<{ file_path: string; iso_639_1: string | null; vote_average: number }> }>(
      `/${type}/${id}/images`, { include_image_language: 'fr,en,null' },
    );
    return r.posters.map((p) => ({ url: `${IMG}/w780${p.file_path}`, lang: p.iso_639_1 ?? undefined, votes: p.vote_average }));
  }
}

type FilmResult = { id: number; title?: string; original_title?: string; release_date?: string; poster_path?: string | null };

/** Per country, the first rating given (a film has one per release), for the countries kept. */
function certsOf(byCountry: Array<[string, Array<string | undefined>]> | undefined): Certs {
  const certs: Certs = {};
  for (const [country, ratings] of byCountry ?? []) {
    const r = ratings.map((x) => x?.trim()).find((x) => x);
    if (r && (CERT_COUNTRIES as readonly string[]).includes(country)) certs[country as keyof Certs] ??= r;
  }
  return certs;
}

export const isLatin = (s: string) => /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}\p{S}]+$/u.test(s);

/** The same films asked in French and in English: one entry each with both titles. */
function bilingual(fr: FilmResult[], en: FilmResult[]): CollectionPart[] {
  const enTitle = new Map(en.map((p) => [p.id, p.title]));
  return fr.map((p) => {
    const o = p.original_title || p.title || '';
    const english = enTitle.get(p.id) || o;
    // Without a French title TMDB sends the original: English reads better than "ஜெயிலர் 2".
    const french = p.title || o;
    return {
      id: p.id,
      fr: isLatin(french) ? french : english,
      en: english,
      o,
      date: p.release_date || null,
      poster: p.poster_path ? `${IMG}/w342${p.poster_path}` : null,
    };
  });
}

export function pickTrailer(videos: Array<{ key: string; site: string; type: string; official?: boolean; iso_639_1?: string }>): string | undefined {
  const yt = videos.filter((v) => v.site === 'YouTube');
  const rank = (v: (typeof yt)[number]) =>
    (v.type === 'Trailer' ? 0 : v.type === 'Teaser' ? 10 : 20) + (v.official ? 0 : 2) + (v.iso_639_1 === 'fr' ? 0 : v.iso_639_1 === 'en' ? 1 : 3);
  return yt.sort((a, b) => rank(a) - rank(b))[0]?.key;
}

// ---------- matching ----------

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Dice coefficient on character bigrams of normalized strings (0..1). */
export function similarity(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = bigrams(x);
  const B = bigrams(y);
  let inter = 0;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) ?? 0);
  const total = [...A.values()].reduce((s, n) => s + n, 0) + [...B.values()].reduce((s, n) => s + n, 0);
  return (2 * inter) / total;
}

/** Title similarity, counting "Shrek 4" → "Shrek 4 : Il était une fin" (title extends the query) as a strong match. */
export function titleSimilarity(query: string, title: string): number {
  const s = similarity(query, title);
  const q = normalize(query);
  return q.includes(' ') && normalize(title).startsWith(q + ' ') ? Math.max(s, 0.86) : s;
}

export function scoreCandidate(c: Candidate, queryTitles: string[], year?: number): number {
  let titleScore = 0;
  for (const q of queryTitles) for (const t of c.titles) titleScore = Math.max(titleScore, titleSimilarity(q, t));
  let yearScore = 0.5;
  if (year && c.year) {
    const d = Math.abs(year - c.year);
    yearScore = d === 0 ? 1 : d === 1 ? 0.75 : d <= 3 ? 0.2 : 0;
  } else if (year && !c.year) yearScore = 0.3;
  const pop = Math.min(c.popularity, 50) / 50;
  return titleScore * 0.7 + yearScore * 0.25 + pop * 0.05;
}

export interface MatchQuery {
  type: MediaType;
  titles: string[]; // best first
  year?: number;
  /** Title known to be English (from the sheet): searched with English results */
  englishTitle?: string;
}

export interface MatchResult {
  best?: Candidate;
  confident: boolean;
  candidates: Candidate[];
}

/** Search TMDB with every known title and pick the best-scoring candidate. */
export async function findMatch(tmdb: Tmdb, q: MatchQuery): Promise<MatchResult> {
  const pool = new Map<string, Candidate>();
  const add = (list: Candidate[]) => {
    for (const c of list) {
      const k = `${c.type}:${c.id}`;
      const prev = pool.get(k);
      if (prev) prev.titles = [...new Set([...prev.titles, ...c.titles])];
      else pool.set(k, c);
    }
  };
  const searches: Array<[MediaType, string, number | undefined, string]> = [];
  const titles = [...new Set(q.titles.filter(Boolean))];
  if (q.englishTitle) searches.push([q.type, q.englishTitle, q.year, 'en-US']);
  for (const t of titles.slice(0, 2)) searches.push([q.type, t, q.year, 'fr-FR']);
  for (const [type, query, year, lang] of searches) {
    const found = await tmdb.search(type, query, year, lang);
    add(found);
    // Years in file names are often off by one or more (French vs US release): retry without it.
    if (year && !rank(found, [query], year).some((c) => c.score! >= 0.75)) add(await tmdb.search(type, query, undefined, lang));
    const top = rank([...pool.values()], titles, q.year);
    if (top[0] && top[0].score! >= 0.9) break;
  }
  const allTitles = q.englishTitle ? [q.englishTitle, ...titles] : titles;
  let ranked = rank([...pool.values()], allTitles, q.year);
  // File named in English but searched in French: fetch English titles so they can be compared.
  if ((!ranked[0] || ranked[0].score! < 0.75) && !q.englishTitle && titles[0]) {
    add(await tmdb.search(q.type, titles[0], q.year, 'en-US'));
    ranked = rank([...pool.values()], allTitles, q.year);
  }
  // Wrong guess about movie vs show (e.g. a kids folder that is a film): try the other type.
  if (!ranked[0] || ranked[0].score! < 0.75) {
    const other: MediaType = q.type === 'movie' ? 'tv' : 'movie';
    add(await tmdb.search(other, q.englishTitle ?? titles[0] ?? '', undefined, q.englishTitle ? 'en-US' : 'fr-FR'));
    ranked = rank([...pool.values()], allTitles, q.year);
  }
  let [best, second] = ranked;
  let confident = !!best && best.score! >= 0.75 && (!second || best.score! - second.score! >= 0.04 || best.score! >= 0.93);
  if (!confident) {
    // Exactly one candidate carries the exact title (e.g. "Chicken run 2005" → Chicken Run, 2000): take it unless
    // the year is far off. Several exact hits (Cendrillon 1950/2015, Peter Pan...) stay for the user to pick.
    const wanted = new Set(allTitles.map(normalize));
    const exact = ranked.filter((c) => c.titles.some((t) => wanted.has(normalize(t))));
    const only = exact.length === 1 ? exact[0]! : undefined;
    if (only && (!q.year || !only.year || Math.abs(q.year - only.year) <= 12)) {
      best = only;
      confident = true;
      ranked = [only, ...ranked.filter((c) => c !== only)];
    }
  }
  return { best, confident, candidates: ranked.slice(0, 8) };
}

function rank(cands: Candidate[], titles: string[], year?: number): Candidate[] {
  return cands.map((c) => ({ ...c, score: scoreCandidate(c, titles, year) })).sort((a, b) => b.score! - a.score!);
}
