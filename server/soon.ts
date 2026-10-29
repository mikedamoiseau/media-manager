// Coming soon: new seasons of followed shows, sequels to films on the NAS, films coming to cinemas, and reminders.
import type { DB } from './db.ts';
import type { CollectionPart, Tmdb } from './tmdb.ts';
import { asFilm, cinema, filmDetails, localDay, onNas, picked, type CinemaCache, type Film } from './films.ts';
import { followed, keptShow, seriesItem, seriesStatus } from './series.ts';
import { ownedSetKeys } from './sets.ts';

export type SoonEntry =
  | { kind: 'season'; tmdbId: number; itemId: number; season: number; date: string | null }
  | {
      kind: 'film';
      film: Film;
      /** the country's cinema date, else the set's, else TMDB's; null: not announced */
      date: string | null;
      /** the set (TMDB collection) with a film on the NAS it belongs to */
      set: string | null;
      cinema: boolean;
      reminder: boolean;
    };

type FilmEntry = Extract<SoonEntry, { kind: 'film' }>;

/**
 * What comes out next, soonest first and the ones with no date last. Seasons and sets come from the TMDB data
 * kept (the routes fetch what is stale); a film found several ways shows once, with each of them.
 */
export async function comingSoon(db: DB, tmdb: Tmdb | null, country: string, now = Date.now(), cache?: CinemaCache): Promise<SoonEntry[]> {
  const today = localDay(now);
  const notOut = (date: string | null | undefined) => !date || date > today;
  const seasons: SoonEntry[] = [];
  for (const [id, on] of followed(db)) {
    const data = on ? keptShow(db, id) : null;
    const next = data && seriesStatus(db, id, data, today).nextSeason;
    if (next && notOut(next.date)) seasons.push({ kind: 'season', tmdbId: id, itemId: seriesItem(db, id)!, season: next.season, date: next.date });
  }

  const nas = onNas(db);
  const films = new Map<number, FilmEntry>();
  const add = (f: Film, date: string | null, more: Partial<FilmEntry>) => {
    const e = films.get(f.id) ?? { kind: 'film', film: f, date: null, set: null, cinema: false, reminder: false };
    films.set(f.id, { ...e, ...more, date: e.date ?? date });
  };
  // The cinema date first: it is the country's.
  const showing = await cinema(db, tmdb, country, now, cache).catch(() => []);
  for (const f of showing) if (f.soon) add(f, f.date, { cinema: true });
  const skipped = picked(db, 'skip');
  const part = db.prepare('SELECT parts FROM collections WHERE key = ?');
  for (const key of ownedSetKeys(db)) {
    const row = part.get(key) as { parts: string } | undefined;
    for (const p of row ? (JSON.parse(row.parts) as CollectionPart[]) : []) {
      if (notOut(p.date) && !nas.has(p.id) && !skipped.has(p.id)) add(p, p.date, { set: key });
    }
  }
  const wanted = [...picked(db, 'want')].filter((id) => !nas.has(id));
  const details = await Promise.all(wanted.map((id) => filmDetails(db, tmdb, id, now).catch(() => null)));
  for (const d of details) if (d && notOut(d.released)) add(asFilm(d), d.released ?? null, { reminder: true });

  // Undated last; on the same day (or both undated), seasons first, then films by title.
  const key = (e: SoonEntry) => `${e.date ?? '9999'}|${e.kind === 'season' ? 0 : 1}|${e.kind === 'film' ? e.film.en : String(e.tmdbId).padStart(9, '0')}`;
  return [...seasons, ...films.values()].sort((a, b) => key(a).localeCompare(key(b)));
}
