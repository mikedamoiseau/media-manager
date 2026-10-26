import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = DatabaseSync;

const MIGRATIONS: string[] = [
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
  /** Whose cinemas the "At the cinema" row follows (ISO 3166-1 code) */
  cinemaCountry: string;
}

export const DEFAULT_SETTINGS: Settings = {
  mediaRoot: '/Volumes/video/MEDIA',
  tmdbKey: '',
  kodiTvs: [],
  kodiTvLast: 0,
  scanIntervalMin: 10,
  sheetId: '',
  sheetImportedAt: 0,
  cinemaCountry: 'TH',
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
