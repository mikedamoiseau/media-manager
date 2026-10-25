/** Grid card (compact keys, see server/views.ts). */
export interface Card {
  id: number;
  g: string;
  fr: string;
  en: string;
  o: string;
  y: number | null;
  c: string;
  ge: string[];
  p: string | null;
  r: number | null;
  q: string[];
  t: 'movie' | 'tv' | null;
  d: boolean;
  n: number;
  m: 'pending' | 'matched' | 'unmatched' | 'manual' | 'none';
  w: boolean;
  rs: boolean;
  pr: boolean;
  h: boolean;
  a: number;
  s: string;
  /** TMDB collection (film set) */
  k?: string;
}

/** Several files of the same film (e.g. 1080p + 4K) collapse into one group. */
export interface Group {
  key: string;
  main: Card;
  items: Card[];
}

/** Films of one TMDB collection shown as a single tile ("Rocky", "Les Gendarmes"). */
export interface SetGroup {
  key: string;
  name: string;
  members: Group[];
}

export type Entry = Group | SetGroup;

/** One film of a set according to TMDB, owned or not. */
/** A film with more than one copy on the NAS (Settings list), biggest copy first. */
export interface DuplicateFilm {
  tmdbId: number;
  copies: Array<{ id: number; path: string; size: number | null; quality: string[]; hidden: boolean; watched: boolean }>;
}

/** A set with a film on the NAS that lacks released films (Settings list). */
export interface IncompleteSet {
  key: string;
  onNas: number;
  released: number;
  missing: Array<Omit<SetPart, 'poster'>>;
}

export interface SetPart {
  id: number;
  fr: string;
  en: string;
  o: string;
  /** release date (YYYY-MM-DD), null when not announced */
  date: string | null;
  poster: string | null;
}

/** A film that isn't on the NAS (see server/films.ts). */
export type Film = SetPart;

/** The page of a film that isn't on the NAS. */
export interface FilmDetail extends Film {
  backdrop: string | null;
  y: number | null;
  runtime: number | null;
  r: number | null;
  votes: number | null;
  ge: string[];
  overviewFr: string | null;
  overviewEn: string | null;
  tagline: string | null;
  trailer: string | null;
  cast: Array<{ name: string; character?: string }>;
  directors: string[];
  imdbId: string | null;
  originalLanguage: string | null;
  /** want: on the "Films to get" list; skip: not interested */
  pick: 'want' | 'skip' | null;
  /** a copy on the NAS after all */
  itemId: number | null;
  /** in the cinema lists of the chosen country, with its release date there */
  cinema: { date: string | null; country: string } | null;
}

/** A film started and not finished (see server/watching.ts). */
export interface Watching {
  id: number;
  fraction: number;
  where: 'tv' | 'phone';
  at: number;
}

/** A title to watch next, from what was watched or started (see server/suggestions.ts). */
export interface Suggestion {
  id: number;
  because: number;
  kind: 'next' | 'like';
}

export interface Candidate {
  id: number;
  type: 'movie' | 'tv';
  title: string;
  originalTitle: string;
  year?: number;
  poster?: string;
  score?: number;
}

export interface Version {
  id: number;
  path: string;
  folder: string;
  present: boolean;
  source: string;
  isDir: boolean;
  size: number | null;
  fileCount: number | null;
  quality: string[];
  kodiId: number | null;
  watched: boolean;
  resume: number | null;
  matchState: string;
  matchSource: string | null;
}

export interface Episode {
  id: number;
  name: string;
  dir: string | null;
  size: number | null;
  season: number | null;
  episode: number | null;
  title: string | null;
  watched: boolean;
}

export interface Detail extends Card {
  path: string;
  folder: string;
  source: string;
  poster: string | null;
  backdrop: string | null;
  trailer: string | null;
  runtime: number | null;
  overviewEn: string | null;
  overviewFr: string | null;
  tagline: string | null;
  cast: Array<{ name: string; character?: string }>;
  directors: string[];
  collection: string | null;
  imdbId: string | null;
  originalLanguage: string | null;
  votes: number | null;
  metaSource: string | null;
  tmdbId: number | null;
  mediaType: 'movie' | 'tv' | null;
  sheet: { en: string | null; fr: string | null; year: number | null } | null;
  parsed: { title: string | null; year: number | null };
  candidates: Candidate[];
  versions: Version[];
  episodes: Episode[];
  /** a film you watched: it can be liked (1) or not (-1), which steers suggestions */
  canRate: boolean;
  rating: 1 | -1 | null;
}

export interface TaskStatus {
  running: boolean;
  lastAt?: number;
  message?: string;
  error?: string;
  progress?: { done: number; total: number };
}

/** Kodi's on-screen keyboard: what for (keyboard, password, numericpassword, number, seconds, ip, date, time) and what it holds. */
export interface KodiInput {
  id: number;
  type: string;
  title: string;
  value: string;
}

export interface Status {
  nas: { mounted: boolean; root: string };
  scan: TaskStatus;
  sheet: TaskStatus;
  kodi: TaskStatus & {
    connected: boolean;
    host?: string;
    transport: string;
    /** the phone can type when Kodi shows its keyboard */
    keyboard?: boolean;
    /** Kodi's keyboard, while it waits for text */
    input?: KodiInput | null;
  };
  metadata: TaskStatus;
  tmdbConfigured: boolean;
  counts: Record<string, number>;
}

export interface Settings {
  mediaRoot: string;
  tmdbKey: string;
  kodiHost: string;
  kodiPort: number;
  kodiUser: string;
  kodiPass: string;
  kodiPathPrefix: string;
  scanIntervalMin: number;
  sheetId: string;
  sheetImportedAt: number;
  cinemaCountry: string;
}

export interface NowPlaying {
  active: boolean;
  title?: string;
  showTitle?: string;
  season?: number;
  episode?: number;
  year?: number;
  poster?: string;
  fanart?: string;
  time?: number;
  total?: number;
  speed?: number;
  volume?: number;
  muted?: boolean;
  subtitlesOn?: boolean;
  subtitle?: SubtitleStream;
  audio?: AudioStream;
}

export interface AudioStream {
  index: number;
  language?: string;
  name?: string;
  codec?: string;
  channels?: number;
  isDefault?: boolean;
  isOriginal?: boolean;
  isImpaired?: boolean;
}

export interface SubtitleStream {
  index: number;
  language?: string;
  name?: string;
  isDefault?: boolean;
  isForced?: boolean;
  isImpaired?: boolean;
}

export interface Streams {
  active: boolean;
  audio: AudioStream[];
  subtitles: SubtitleStream[];
  currentAudio?: number;
  currentSubtitle?: number;
  subtitlesOn: boolean;
}

export type TitleLang = 'fr' | 'en' | 'original';
