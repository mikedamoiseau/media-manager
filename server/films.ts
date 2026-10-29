import type { DB } from './db.ts';
import { isLatin, type Tmdb, type TitleDetails, type CollectionPart } from './tmdb.ts';
import { tastes, recommended, dislikePenalties, seenSql } from './suggestions.ts';

/** A film that isn't on the NAS, as a tile shows it. */
export type Film = CollectionPart;
export type Pick = 'want' | 'skip';

const MAX_AGE = 30 * 24 * 3600 * 1000;
const ELSEWHERE = 24;
// Cinema programmes change weekly: a few hours old is fresh enough.
const CINEMA_AGE = 6 * 3600 * 1000;
const CINEMA_EACH = 12;

/** The day (YYYY-MM-DD) on this machine's clock, like release dates. */
export const localDay = (t: number) => new Date(t - new Date(t).getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

const inflight = new Map<number, Promise<TitleDetails>>();

/** TMDB details of a film, kept a month. Null without a TMDB key and nothing kept. */
export async function filmDetails(db: DB, tmdb: Tmdb | null, id: number, now = Date.now()): Promise<TitleDetails | null> {
  const row = db.prepare('SELECT data, fetched_at FROM films WHERE tmdb_id = ?').get(id) as { data: string; fetched_at: number } | undefined;
  if (row && (now - row.fetched_at < MAX_AGE || !tmdb)) return JSON.parse(row.data) as TitleDetails;
  if (!tmdb) return null;
  if (!inflight.has(id)) {
    inflight.set(
      id,
      tmdb
        .details('movie', id)
        .then((d) => {
          db.prepare(`INSERT INTO films (tmdb_id, data, fetched_at) VALUES (?, ?, ?)
            ON CONFLICT(tmdb_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`).run(id, JSON.stringify(d), now);
          return d;
        })
        .finally(() => inflight.delete(id)),
    );
  }
  try {
    return await inflight.get(id)!;
  } catch (e) {
    if (row) return JSON.parse(row.data) as TitleDetails;
    throw e;
  }
}

export function asFilm(d: TitleDetails): Film {
  const o = d.originalTitle || d.titleEn || '';
  const en = d.titleEn || o;
  // No French title: a Latin-script original, else the English one (as in the library).
  return { id: d.id, fr: d.titleFr || (isLatin(o) ? o : en), en, o, date: d.released ?? null, poster: d.poster ?? null };
}

const ids = (db: DB, sql: string, ...args: Array<string | number>) => new Set((db.prepare(sql).all(...args) as Array<{ id: number }>).map((r) => r.id));
/** Films with a copy on the NAS, hidden ones too. */
export const onNas = (db: DB) => ids(db, `SELECT DISTINCT tmdb_id id FROM items WHERE media_type = 'movie' AND present = 1 AND tmdb_id IS NOT NULL`);
export const picked = (db: DB, choice: Pick) => ids(db, 'SELECT tmdb_id id FROM picks WHERE choice = ?', choice);

/**
 * Released films that aren't on the NAS, from TMDB's recommendations for what interests you lately
 * (the same tastes as this profile's suggestions on the NAS). Films only in the sheet count as not on the
 * NAS; films it watched, and films the household said it's not interested in, are left out.
 */
export async function elsewhere(db: DB, profileId: number, tmdb: Tmdb | null, now = Date.now()): Promise<Array<{ film: Film; because: number }>> {
  const nas = onNas(db);
  const seen = ids(db, `SELECT DISTINCT i.tmdb_id id FROM items i WHERE i.media_type = 'movie' AND i.tmdb_id IS NOT NULL AND ${seenSql(profileId)}`);
  const skipped = picked(db, 'skip');
  const seeds = tastes(db, profileId, now).filter((t) => t.row.type === 'movie');
  const lists = await Promise.all(seeds.map((t) => recommended(db, tmdb, 'movie', t.row.tmdb, now)));
  const scores = new Map<number, { score: number; best: number; because: number }>();
  seeds.forEach((t, i) => {
    lists[i]!.slice(0, 20).forEach((id, rank) => {
      if (nas.has(id) || seen.has(id) || skipped.has(id)) return;
      const points = t.weight * (1 - rank / 20);
      const s = scores.get(id) ?? { score: 0, best: -1, because: t.row.id };
      s.score += points;
      if (points > s.best) Object.assign(s, { best: points, because: t.row.id });
      scores.set(id, s);
    });
  });
  const off = await dislikePenalties(db, profileId, tmdb, now);
  for (const [id, s] of scores) s.score -= off.get(`movie:${id}`) ?? 0;
  // Details for the best ones, a few at a time: titles in each language, and the release date to leave out films not out yet.
  const ranked = [...scores.entries()].filter(([, s]) => s.score > 0).sort((a, b) => b[1].score - a[1].score);
  const today = localDay(now);
  const out: Array<{ film: Film; because: number }> = [];
  for (let i = 0; i < ranked.length && out.length < ELSEWHERE; i += 8) {
    const batch = ranked.slice(i, i + 8);
    const details = await Promise.all(batch.map(([id]) => filmDetails(db, tmdb, id, now).catch(() => null)));
    batch.forEach(([, s], j) => {
      const d = details[j];
      if (d?.released && d.released <= today && out.length < ELSEWHERE) out.push({ film: asFilm(d), because: s.because });
    });
  }
  return out;
}

export type CinemaCache = Map<string, { at: number; now: Film[]; soon: Film[] }>;
const cinemaCache: CinemaCache = new Map();

/**
 * What's on in a country's cinemas (most popular first), then what comes out soon (earliest first),
 * dated for that country. Films on the NAS and films you're not interested in are left out.
 */
export async function cinema(db: DB, tmdb: Tmdb | null, country: string, now = Date.now(), cache = cinemaCache): Promise<Array<Film & { soon: boolean }>> {
  let lists = cache.get(country);
  if (tmdb && (!lists || now - lists.at > CINEMA_AGE)) {
    try {
      const [showing, soon] = await Promise.all([tmdb.cinemaList('now_playing', country), tmdb.cinemaList('upcoming', country)]);
      lists = { at: now, now: showing, soon };
      cache.set(country, lists);
    } catch (e) {
      if (!lists) throw e;
    }
  }
  if (!lists) return [];
  const today = localDay(now);
  const hide = new Set([...onNas(db), ...picked(db, 'skip')]);
  const showing = lists.now.filter((f) => f.date && f.date <= today && !hide.has(f.id)).slice(0, CINEMA_EACH);
  // A film out in a few days can be in either list.
  const soon = new Map<number, Film>();
  for (const f of [...lists.soon, ...lists.now]) if (f.date && f.date > today && !hide.has(f.id) && !soon.has(f.id)) soon.set(f.id, f);
  const coming = [...soon.values()].slice(0, CINEMA_EACH).sort((a, b) => a.date!.localeCompare(b.date!));
  return [...showing.map((f) => ({ ...f, soon: false })), ...coming.map((f) => ({ ...f, soon: true }))];
}

/** The film in the cinema lists last fetched for a country, with that country's release date. */
export function inCinemas(country: string, id: number, cache = cinemaCache): { date: string | null } | null {
  const lists = cache.get(country);
  const f = lists && [...lists.now, ...lists.soon].find((x) => x.id === id);
  return f ? { date: f.date } : null;
}

export function getPick(db: DB, id: number): Pick | null {
  return ((db.prepare('SELECT choice FROM picks WHERE tmdb_id = ?').get(id) as { choice: Pick } | undefined)?.choice) ?? null;
}

export function setPick(db: DB, id: number, choice: Pick | null, now = Date.now()): void {
  if (choice) db.prepare('INSERT INTO picks (tmdb_id, choice, at) VALUES (?, ?, ?) ON CONFLICT(tmdb_id) DO UPDATE SET choice = excluded.choice, at = excluded.at').run(id, choice, now);
  else db.prepare('DELETE FROM picks WHERE tmdb_id = ?').run(id);
}

/** Films you want and don't have yet, latest added first. A film leaves the list once a copy is on the NAS. */
export async function wantedFilms(db: DB, tmdb: Tmdb | null, now = Date.now()): Promise<Film[]> {
  const nas = onNas(db);
  const wanted = (db.prepare(`SELECT tmdb_id id FROM picks WHERE choice = 'want' ORDER BY at DESC`).all() as Array<{ id: number }>).filter((r) => !nas.has(r.id));
  const details = await Promise.all(wanted.map((r) => filmDetails(db, tmdb, r.id, now).catch(() => null)));
  return details.flatMap((d) => (d ? [asFilm(d)] : []));
}
