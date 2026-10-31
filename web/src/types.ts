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
  /** watched and in progress, for this device's profile (from /api/marks) */
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
  /** into the film, or into the episode in progress (0: the next episode, not started) */
  fraction: number;
  where: 'tv' | 'phone';
  at: number;
  /** a series: the episode to go on with, and how many of its episodes were watched */
  episode?: { id: number; season: number | null; episode: number | null; title: string | null };
  seen?: { watched: number; total: number };
}

/** A title to watch next, from what was watched or started (see server/suggestions.ts). */
/** An actor or director, and how many titles the library shows with them (see server/people.ts). */
export interface Person {
  name: string;
  n: number;
}

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
  /** The library sync, from the first TV */
  kodi: TaskStatus & { connected: boolean; transport: string };
  tvs: TvStatus[];
  /** Who's watching: the people a device can pick */
  profiles: Profile[];
  /** a parents' code is set */
  kidsCode: boolean;
  metadata: TaskStatus;
  tmdbConfigured: boolean;
  counts: Record<string, number>;
  /** The channel lists and guides; `file`: what became of the NAS channel file at the last write */
  live: TaskStatus & { file?: 'written' | 'same' | 'not_mounted' };
}

/** A programme of the guide (see server/epg.ts). */
export interface LiveProgramme {
  start: number;
  stop: number;
  title: string;
  sub?: string;
  category?: string;
  descr?: string;
  icon?: string;
}

/** One of the owner's channels with its programmes (see server/livetv.ts). */
export interface LiveChannel {
  key: string;
  number: number;
  name: string;
  logo: string;
  url: string;
  /** Its list: its category */
  list: string;
  /** How VLC on the phone gets it: the stream itself, or the app's one-channel playlist (for request headers) */
  vlc: 'direct' | 'playlist';
  programmes: LiveProgramme[];
}

/** A channel of the lists, picked or not (see server/livetv.ts). */
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
}

/** A person's likes, suggestions and progress (see server/profiles.ts). */
export interface Profile {
  id: number;
  name: string;
  color: string;
  /** gets what is played on a TV without the app; can't be removed */
  main: boolean;
  /** a kids profile: only titles fit for it, the parents' code to leave it */
  kids: boolean;
  /** a kids profile's age limit (Germany's FSK steps) */
  maxAge: number;
  /** a kids profile's bedtime, "HH:MM"; none: null */
  bedtime: string | null;
}

export interface TvStatus {
  id: string;
  name: string;
  /** phones on this TV can type when Kodi shows its keyboard */
  keyboard: boolean;
  /** Kodi's keyboard, while it waits for text */
  input: KodiInput | null;
  /** what plays next on this TV, in order */
  upNext: UpNextEntry[];
  sleep: Sleep;
}

/** A film (no episode) or an episode in a TV's Up next, played for whoever added it. */
export interface UpNextEntry {
  id: number;
  itemId: number;
  episodeId: number | null;
  season: number | null;
  episode: number | null;
  episodeTitle: string | null;
}

/** A TV's sleep timer: stop at that time, or once what plays now ends. */
export type Sleep = { at: number } | { afterThis: true } | null;

/** A Kodi box, as Settings edits it (the password comes back hidden: "••••"). */
export interface KodiTv {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  pass: string;
  /** how this Kodi sees the media root, e.g. smb://192.168.0.24/video/MEDIA */
  pathPrefix: string;
}

export interface Settings {
  mediaRoot: string;
  tmdbKey: string;
  kodiTvs: KodiTv[];
  scanIntervalMin: number;
  sheetId: string;
  sheetImportedAt: number;
  cinemaCountry: string;
  liveFile: string;
  /** The TV guides (XMLTV), first one first */
  liveGuides: string[];
  liveRefreshedAt: number;
}

export interface NowPlaying {
  active: boolean;
  /** kids mode: something not for this kid plays (nothing else is told) */
  hidden?: boolean;
  /** the file of the library Kodi plays, when it is one VLC can stream */
  media?: { kind: 'item' | 'episode'; id: number; ext: string };
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

/** Series tracker: the aired episodes of a season that aren't on the NAS. */
export interface SeasonGap {
  season: number;
  aired: number;
  missing: number[];
}

export interface SeriesStatus {
  missing: SeasonGap[];
  /** when the latest missing episode aired: exact, or only when its season started */
  latest: { date: string; season: number; exact: boolean } | null;
  /** the next episode of a season under way */
  nextEpisode: { season: number; episode: number; date: string | null } | null;
  /** the next season: dated, or announced (null date) */
  nextSeason: { season: number; date: string | null } | null;
  /** the show won't come back */
  ended: 'ended' | 'cancelled' | null;
  /** files of the show with no episode number: not counted */
  unnumbered: number;
}

/** A series page's tracker: null status when TMDB couldn't say. */
export interface SeriesInfo {
  follow: boolean;
  status: SeriesStatus | null;
  tmdb: boolean;
}

/** A followed show missing aired episodes (Episodes to get). */
export interface ShowToGet {
  tmdbId: number;
  itemId: number;
  status: SeriesStatus;
}

/** Coming soon: a followed show's next season, or a film not out yet (in a set on the NAS, coming to cinemas, or wanted). */
export type SoonEntry =
  | { kind: 'season'; tmdbId: number; itemId: number; season: number; date: string | null }
  | { kind: 'film'; film: Film; date: string | null; set: string | null; cinema: boolean; reminder: boolean };

/** A film or series in Your year in film (`itemId`: its copy to open). */
export interface YearTitle {
  itemId: number;
  name: string;
  poster: string | null;
}

/** Your year in film, as the server works it out for this device's profile (see server/yearInFilm.ts). */
export interface YearInFilm {
  year: number;
  from: number;
  to: number;
  films: number;
  episodes: number;
  hours: number;
  estimated: boolean;
  titles: number;
  genres: Array<{ name: string; n: number }>;
  actor: { name: string; n: number; tie: string | null; photo: string | null; titles: YearTitle[]; onlyFilms: boolean } | null;
  series: Array<YearTitle & { episodes: number; backdrop: string | null }>;
  hours24: number[];
  primeHour: number | null;
  primeCount: number;
  plays: number;
  afterMidnight: number;
  tvs: { since: number; rows: Array<{ name: string; n: number }> } | null;
  oldest: (YearTitle & { year: number }) | null;
  posters: string[];
  /** The question was answered on some device. */
  asked: boolean;
}
