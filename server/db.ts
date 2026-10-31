import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = DatabaseSync;

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,          -- relative to the media root; 'sheet:<tab>:<file>' for sheet-only entries
    folder TEXT NOT NULL,               -- top-level folder, '' for files at the root
    category TEXT NOT NULL,             -- movies|series|animes|kids|shows|fitness|courses|other
    is_dir INTEGER NOT NULL DEFAULT 0,
    present INTEGER NOT NULL DEFAULT 1, -- 0 = not on disk anymore (or only known from the sheet)
    source TEXT NOT NULL DEFAULT 'disk',
    size INTEGER,
    mtime INTEGER,
    file_count INTEGER,
    parsed_title TEXT,
    parsed_year INTEGER,
    alt_titles TEXT,                    -- JSON array
    quality TEXT,                       -- JSON {res,hdr,langs,source}
    sheet_en TEXT,
    sheet_fr TEXT,
    sheet_year INTEGER,
    media_type TEXT,                    -- expected TMDB type: movie|tv, NULL = never match
    tmdb_id INTEGER,
    match_state TEXT NOT NULL DEFAULT 'pending', -- pending|matched|unmatched|manual|none
    match_source TEXT,                  -- kodi|tmdb|manual
    match_score REAL,
    candidates TEXT,                    -- JSON list for the review screen
    kodi_id INTEGER,
    kodi_type TEXT,                     -- movie|tvshow
    playcount INTEGER,
    resume REAL,
    last_played TEXT,
    custom_poster TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX items_tmdb ON items(media_type, tmdb_id);
  CREATE INDEX items_match ON items(match_state);

  CREATE TABLE titles (
    media_type TEXT NOT NULL,
    tmdb_id INTEGER NOT NULL,
    title_en TEXT,
    title_fr TEXT,
    original_title TEXT,
    original_language TEXT,
    year INTEGER,
    genres TEXT,                        -- JSON array (English names)
    overview_en TEXT,
    overview_fr TEXT,
    tagline TEXT,
    runtime INTEGER,                    -- minutes
    rating REAL,
    votes INTEGER,
    poster TEXT,                        -- remote URL
    backdrop TEXT,                      -- remote URL
    trailer TEXT,                       -- YouTube video id
    cast_json TEXT,                     -- JSON [{name, character}]
    directors TEXT,                     -- JSON array
    imdb_id TEXT,
    collection TEXT,
    seasons INTEGER,
    source TEXT NOT NULL,               -- kodi|tmdb
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (media_type, tmdb_id)
  );

  CREATE TABLE episodes (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    path TEXT NOT NULL UNIQUE,
    size INTEGER,
    season INTEGER,
    episode INTEGER,
    title TEXT,
    present INTEGER NOT NULL DEFAULT 1,
    kodi_id INTEGER,
    playcount INTEGER
  );
  CREATE INDEX episodes_item ON episodes(item_id);

  CREATE TABLE sheet_rows (
    id INTEGER PRIMARY KEY,
    tab TEXT NOT NULL,
    filename TEXT NOT NULL,
    key TEXT NOT NULL,
    title_en TEXT,
    title_fr TEXT,
    year INTEGER,
    folders TEXT
  );
  CREATE INDEX sheet_key ON sheet_rows(key);

  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  `
  -- Every film of a set (TMDB collection), to show the ones missing from the NAS.
  CREATE TABLE collections (
    key TEXT PRIMARY KEY,               -- titles.collection
    tmdb_id INTEGER,                    -- TMDB collection id
    parts TEXT NOT NULL,                -- JSON SetPart[]
    fetched_at INTEGER NOT NULL
  );
  `,
  `
  -- TMDB "if you liked this" lists of titles watched or started, for suggestions.
  CREATE TABLE recommendations (
    media_type TEXT NOT NULL,
    tmdb_id INTEGER NOT NULL,
    ids TEXT NOT NULL,                  -- JSON TMDB ids, best first
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (media_type, tmdb_id)
  );
  `,
  `
  -- What you do in the app (pages opened, trailers, plays), for suggestions.
  CREATE TABLE activity (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                 -- open|trailer|play
    at INTEGER NOT NULL
  );
  CREATE INDEX activity_item ON activity(item_id, kind, at);
  `,
  `
  -- Continue watching: how far VLC got (Kodi keeps its own resume point) and films removed by hand.
  CREATE TABLE watching (
    item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    fraction REAL,                      -- bytes served to VLC / file size; NULL: never played from the app
    played_at INTEGER,
    dismissed_at INTEGER
  );
  `,
  `
  -- Films not on the NAS (suggestions, cinemas): TMDB details, kept apart from the library's titles.
  CREATE TABLE films (
    tmdb_id INTEGER PRIMARY KEY,        -- movie
    data TEXT NOT NULL,                 -- JSON TitleDetails
    fetched_at INTEGER NOT NULL
  );
  -- What you said about a film not on the NAS: want (the "Films to get" list) or skip (not interested).
  CREATE TABLE picks (
    tmdb_id INTEGER PRIMARY KEY,        -- movie
    choice TEXT NOT NULL,               -- want|skip
    at INTEGER NOT NULL
  );
  `,
  `
  -- Watched films you liked (1) or not (-1), for suggestions.
  CREATE TABLE ratings (
    media_type TEXT NOT NULL,
    tmdb_id INTEGER NOT NULL,
    value INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (media_type, tmdb_id)
  );
  `,
  `
  -- Where each episode got to: Kodi's resume point and last play, and how far VLC got on the phone.
  ALTER TABLE episodes ADD COLUMN resume REAL;
  ALTER TABLE episodes ADD COLUMN last_played TEXT;
  ALTER TABLE episodes ADD COLUMN streamed REAL;
  ALTER TABLE episodes ADD COLUMN streamed_at INTEGER;
  `,
  `
  -- Who's watching: each person's likes, activity and progress. Profile 1 is the main one: it gets
  -- everything recorded before profiles, and whatever is played on a TV without the app.
  -- AUTOINCREMENT: a removed profile's id is never given again (a phone still set to it asks again).
  CREATE TABLE profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  INSERT INTO profiles (id, name, color, created_at) VALUES (1, 'Me', '#e8a33d', 0);

  -- Kodi's progress per profile. items and episodes keep Kodi's own view, shared by everyone.
  CREATE TABLE film_states (
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    playcount INTEGER,
    resume REAL,
    last_played TEXT,
    PRIMARY KEY (profile_id, item_id)
  );
  INSERT INTO film_states SELECT 1, id, playcount, resume, last_played FROM items
    WHERE kodi_type = 'movie' AND (COALESCE(playcount, 0) > 0 OR resume IS NOT NULL OR last_played IS NOT NULL);

  CREATE TABLE episode_states (
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    playcount INTEGER,
    resume REAL,
    last_played TEXT,
    streamed REAL,                      -- how far VLC got
    streamed_at INTEGER,
    PRIMARY KEY (profile_id, episode_id)
  );
  INSERT INTO episode_states SELECT 1, id, playcount, resume, last_played, streamed, streamed_at FROM episodes
    WHERE COALESCE(playcount, 0) > 0 OR resume IS NOT NULL OR last_played IS NOT NULL OR streamed_at IS NOT NULL;

  CREATE TABLE watching_new (
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    fraction REAL,
    played_at INTEGER,
    dismissed_at INTEGER,
    PRIMARY KEY (profile_id, item_id)
  );
  INSERT INTO watching_new SELECT 1, item_id, fraction, played_at, dismissed_at FROM watching;
  DROP TABLE watching;
  ALTER TABLE watching_new RENAME TO watching;

  CREATE TABLE ratings_new (
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    media_type TEXT NOT NULL,
    tmdb_id INTEGER NOT NULL,
    value INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, media_type, tmdb_id)
  );
  INSERT INTO ratings_new SELECT 1, media_type, tmdb_id, value, at FROM ratings;
  DROP TABLE ratings;
  ALTER TABLE ratings_new RENAME TO ratings;

  CREATE TABLE activity_new (
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  INSERT INTO activity_new SELECT id, 1, item_id, kind, at FROM activity;
  DROP TABLE activity;
  ALTER TABLE activity_new RENAME TO activity;
  CREATE INDEX activity_item ON activity(profile_id, item_id, kind, at);

  -- Who started a film or episode on a TV last: Kodi's next changes to it are that profile's.
  CREATE TABLE tv_plays (
    kodi_type TEXT NOT NULL,            -- movie|episode
    kodi_id INTEGER NOT NULL,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    used_at INTEGER,                    -- when the change of that play was given: a later one isn't theirs
    PRIMARY KEY (kodi_type, kodi_id)
  );
  `,
  `
  -- Kids mode. Age ratings from TMDB, kept for Germany, France and the US: JSON {"DE":"12","FR":"TP"};
  -- '{}' when TMDB has none, NULL until fetched.
  ALTER TABLE titles ADD COLUMN certs TEXT;

  -- A kids profile sees only titles fit for it (age limit on Germany's FSK steps) and stops at bedtime ("HH:MM").
  ALTER TABLE profiles ADD COLUMN kids INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE profiles ADD COLUMN max_age INTEGER NOT NULL DEFAULT 12;
  ALTER TABLE profiles ADD COLUMN bedtime TEXT;

  -- A parent's call on a title, for every kids profile: ok 1 (OK for kids) or 0 (not for kids).
  -- key: the library's group key (movie:671, tv:1399, i:<item id> when not matched).
  CREATE TABLE kids_overrides (
    key TEXT PRIMARY KEY,
    ok INTEGER NOT NULL,
    at INTEGER NOT NULL
  );
  `,
  `
  -- Live TV. iptv-org's French and Belgian channels by tvg-id with its feed (TF1.fr@SD); the first list wins a
  -- channel both have. A channel no longer listed keeps its row (seen_at stays where it was).
  CREATE TABLE live_catalog (
    key TEXT PRIMARY KEY,
    list TEXT NOT NULL,                 -- fr|be
    name TEXT NOT NULL,                 -- iptv-org's name without resolution or tags
    logo TEXT NOT NULL,
    grp TEXT NOT NULL,
    url TEXT NOT NULL,
    opts TEXT NOT NULL,                 -- JSON: the #EXTVLCOPT / #KODIPROP lines
    seen_at INTEGER NOT NULL,           -- the last refresh of its list that had it
    ok INTEGER,                         -- its stream answered (1) or not (0); NULL: not checked since its address changed
    checked_at INTEGER
  );
  -- When each list was last read: a channel seen before that is no longer listed.
  CREATE TABLE live_lists (
    list TEXT PRIMARY KEY,
    refreshed_at INTEGER NOT NULL
  );

  -- The owner's channels in their order: position 1..n is the channel number on the TVs.
  -- guide: NULL automatic, '' no guide, 'source<TAB>id' the owner's pick.
  CREATE TABLE live_channels (
    key TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    guide TEXT
  );

  -- The guide: each source's channels (to pick from), and the programmes of the channels in use.
  CREATE TABLE epg_channels (
    source TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (source, id)
  );
  CREATE TABLE epg_programmes (
    source TEXT NOT NULL,
    channel TEXT NOT NULL,
    start INTEGER NOT NULL,
    stop INTEGER NOT NULL,
    title TEXT NOT NULL,
    sub TEXT,
    category TEXT,
    descr TEXT,
    icon TEXT,
    PRIMARY KEY (source, channel, start)
  );
  `,
  // 12: the owner's own stream address for a channel of theirs (written without request headers); NULL: iptv-org's.
  `ALTER TABLE live_channels ADD COLUMN url TEXT;`,
  `
  -- Series tracker: TMDB's seasons, last and next episode of each show (JSON ShowData), kept a day.
  CREATE TABLE shows (
    tmdb_id INTEGER PRIMARY KEY,        -- tv
    data TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  -- The owner's choice to follow a show or not, only where it differs from the default (a copy in a SERIES folder).
  CREATE TABLE follows (
    tmdb_id INTEGER PRIMARY KEY,        -- tv
    follow INTEGER NOT NULL,
    at INTEGER NOT NULL
  );
  `,
  `
  -- What each TV plays next, in the order added; each entry plays for the profile that added it.
  CREATE TABLE up_next (
    id INTEGER PRIMARY KEY,
    tv_id TEXT NOT NULL,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE, -- null: a film
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    at INTEGER NOT NULL                 -- the TV's list last added to or played from
  );
  CREATE INDEX up_next_tv ON up_next(tv_id);
  -- Each TV's sleep timer.
  CREATE TABLE tv_sleep (
    tv_id TEXT PRIMARY KEY,
    at INTEGER,                         -- when to stop; null: after what plays now
    until INTEGER NOT NULL              -- an "after this" left behind lapses then
  );
  `,
  `
  -- Every play of a film or episode, for Your year in film. A play from Kodi's events or the phone has a device
  -- and, once over, its minutes; an estimated one (put in from Kodi's last plays, the phone's last streams, or a
  -- play the app missed) has no device and only how far it got.
  CREATE TABLE plays (
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, -- the film, or the episode's series
    kind TEXT NOT NULL,                 -- film|episode
    -- A rescan drops an episode whose file was renamed or replaced: its plays stay, as an episode's of that series.
    episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL,
    device TEXT,                        -- a TV's id, 'phone'; null: estimated
    at INTEGER NOT NULL,                -- when it started
    ended_at INTEGER,                   -- when it stopped (a TV's: Kodi stamps its last play then); the phone's last stream
    minutes REAL,                       -- played, without pauses; null while it plays, or not known
    reached REAL,                       -- how far it got (0..1), when known
    finished INTEGER NOT NULL DEFAULT 0,
    estimated INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX plays_profile ON plays(profile_id, at);
  -- Whether each profile was asked about its year (either answer).
  CREATE TABLE year_asked (
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    year INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, year)
  );
  -- An actor's TMDB photo (url null: TMDB has none), looked up by name.
  CREATE TABLE person_photos (name TEXT PRIMARY KEY, url TEXT, fetched_at INTEGER NOT NULL);
  -- An episode's runtime in minutes, from Kodi.
  ALTER TABLE episodes ADD COLUMN runtime INTEGER;
  `,
  `
  -- The Samsung TV Plus guide (the Extra channels'), also where the guide sources were saved before it was a default.
  UPDATE settings SET value = json_insert(value, '$[#]', 'https://i.mjh.nz/SamsungTVPlus/fr.xml.gz')
    WHERE key = 'liveGuides' AND json_valid(value) AND value NOT LIKE '%i.mjh.nz/SamsungTVPlus/%';
  -- The owner's channels numbered category by category (France, Belgium, Extra), each in the owner's order.
  CREATE TEMP TABLE regroup AS SELECT p.key, ROW_NUMBER() OVER (
    ORDER BY CASE c.list WHEN 'fr' THEN 0 WHEN 'be' THEN 1 WHEN 'extra' THEN 2 ELSE 3 END, p.position
  ) AS n FROM live_channels p LEFT JOIN live_catalog c ON c.key = p.key;
  UPDATE live_channels SET position = (SELECT n FROM regroup WHERE regroup.key = live_channels.key);
  DROP TABLE regroup;
  `,
  `
  -- A channel of the owner's made for kids: in the TVs' Kids group, and the kids profiles' to watch.
  ALTER TABLE live_channels ADD COLUMN kids INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- The owner's own logo for a channel of theirs (null: iptv-org's), for one whose listed logo doesn't load.
  ALTER TABLE live_channels ADD COLUMN logo TEXT;
  `,
];

export function openDb(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** A Kodi box the app can control. The first one is also where the library syncs from. */
export interface KodiTv {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  pass: string;
  /** How this Kodi sees the media root, e.g. smb://192.168.0.24/video/MEDIA */
  pathPrefix: string;
}

export interface Settings {
  mediaRoot: string;
  tmdbKey: string;
  kodiTvs: KodiTv[];
  /** The highest TV number given (tv3: 3): a removed TV's id is never given again */
  kodiTvLast: number;
  scanIntervalMin: number;
  sheetId: string;
  sheetImportedAt: number;
  /** Whose cinemas the "At the cinema" row follows (ISO 3166-1 code); '' until picked in Settings */
  cinemaCountry: string;
  /** The live TV channel list both TVs read, on the NAS share (next to MEDIA, never inside) */
  liveFile: string;
  /** TV guides (XMLTV), the first wins a channel several have */
  liveGuides: string[];
  /** When the channel lists and guides were last refreshed */
  liveRefreshedAt: number;
}

export const DEFAULT_SETTINGS: Settings = {
  mediaRoot: '/Volumes/video/MEDIA',
  tmdbKey: '',
  kodiTvs: [],
  kodiTvLast: 0,
  scanIntervalMin: 10,
  sheetId: '',
  sheetImportedAt: 0,
  cinemaCountry: '',
  liveFile: '/Volumes/video/IPTV/channels.m3u',
  liveGuides: ['https://xmltvfr.fr/xmltv/xmltv.xml.gz', 'https://i.mjh.nz/PlutoTV/fr.xml.gz', 'https://i.mjh.nz/SamsungTVPlus/fr.xml.gz'],
  liveRefreshedAt: 0,
};

export function getSettings(db: DB): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) s[r.key] = JSON.parse(r.value);
  if (!rows.some((r) => r.key === 'kodiTvs')) s.kodiTvs = oneKodi(rows);
  // Never below the TVs listed: the Kodi set up before TVs is tv1 before anything was saved.
  s.kodiTvLast = Math.max(s.kodiTvLast as number, ...(s.kodiTvs as KodiTv[]).map((t) => Number(/^tv(\d+)$/.exec(t.id)?.[1] ?? 0)));
  return s as unknown as Settings;
}

/** The single Kodi set up before there were TVs: the first TV, until TVs are saved. */
function oneKodi(rows: Array<{ key: string; value: string }>): KodiTv[] {
  const old = Object.fromEntries(rows.filter((r) => r.key.startsWith('kodi')).map((r) => [r.key, JSON.parse(r.value)]));
  if (!old.kodiHost) return [];
  return [{ id: 'tv1', name: 'Living room', host: old.kodiHost, port: old.kodiPort ?? 8080, user: old.kodiUser ?? 'kodi', pass: old.kodiPass ?? '', pathPrefix: old.kodiPathPrefix ?? '' }];
}

export function saveSettings(db: DB, patch: Partial<Settings>): Settings {
  const stmt = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) {
    if (k in DEFAULT_SETTINGS && v !== undefined) stmt.run(k, JSON.stringify(v));
  }
  return getSettings(db);
}
