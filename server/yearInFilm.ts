import type { DB } from './db.ts';
import { img } from './views.ts';
import { MIN_PLAY_MINUTES, playMinutes } from './plays.ts';

// Your year in film: a profile's year from the play log. Only films and series matched on TMDB count; a title
// (a film, a series) is its TMDB entry, whichever copy or folder was played.

/** Fewer films and episodes watched in the year than this: nothing to show. */
export const MIN_WATCHED = 3;
// A title's first names in its cast; the genres, series and posters shown.
const CAST = 8;
const GENRES = 5;
const SERIES = 4;
const POSTERS = 18;
const ACTOR_TITLES = 3;

export interface YearTitle {
  itemId: number;
  name: string;
  poster: string | null;
}

export interface YearInFilm {
  year: number;
  from: number; // 1 January, local
  to: number; // now in the year shown, else 31 December 23:59:59
  films: number; // finished plays (rewatches count)
  episodes: number;
  hours: number; // rounded
  estimated: boolean; // any counted play estimated
  titles: number; // films and series watched (each once)
  genres: Array<{ name: string; n: number }>; // top by titles, then name
  actor: { name: string; n: number; tie: string | null; photo: string | null; titles: YearTitle[] } | null; // in 2 titles or more
  series: Array<YearTitle & { episodes: number; backdrop: string | null }>; // most episodes first
  hours24: number[]; // plays by the local hour they started
  primeHour: number | null;
  primeCount: number;
  plays: number;
  afterMidnight: number; // started 00:00 to 04:59
  tvs: { since: number; rows: Array<{ name: string; n: number }> } | null; // logged (not estimated) plays only
  oldest: (YearTitle & { year: number }) | null; // the oldest film watched
  posters: string[]; // latest first, one per title
}

/** The year whose story is offered: in December this one, in January the one just ended. */
export function yearToShow(now: number): number | null {
  const d = new Date(now);
  return d.getMonth() === 11 ? d.getFullYear() : d.getMonth() === 0 ? d.getFullYear() - 1 : null;
}

type Row = {
  item_id: number; kind: 'film' | 'episode'; device: string | null; at: number; minutes: number | null; reached: number | null;
  finished: number; estimated: number; runtime: number | null; key: string; name: string; year: number | null;
  genres: string | null; cast_json: string | null; poster: string | null; backdrop: string | null;
};

const byCount = (a: { name: string; n: number }, b: { name: string; n: number }) => b.n - a.n || a.name.localeCompare(b.name);

/**
 * The profile's year (`tvNames`: a TV's id, or 'phone', to what to call it). A play counts from 5 minutes;
 * one whose length isn't known (a film without a runtime that Kodi says was watched) counts when finished.
 * For a kids profile (`sees`: the items kids mode shows it), only titles it may see count, whichever copy was
 * played. Null when fewer than MIN_WATCHED films and episodes were watched.
 */
export function yearInFilm(db: DB, profileId: number, year: number, now: number, tvNames: Map<string, string>, sees: Set<number> | null = null): YearInFilm | null {
  const from = new Date(year, 0, 1).getTime();
  const end = new Date(year + 1, 0, 1).getTime();
  const all = db.prepare(`SELECT p.item_id, p.kind, p.device, p.at, p.minutes, p.reached, p.finished, p.estimated,
      CASE WHEN p.kind = 'film' THEN t.runtime ELSE e.runtime END AS runtime, t.media_type || ':' || t.tmdb_id AS key,
      COALESCE(t.title_en, t.original_title, i.parsed_title) AS name, t.year, t.genres, t.cast_json, t.poster, t.backdrop
    FROM plays p JOIN items i ON i.id = p.item_id JOIN titles t ON t.media_type = i.media_type AND t.tmdb_id = i.tmdb_id
    LEFT JOIN episodes e ON e.id = p.episode_id
    WHERE p.profile_id = ? AND p.at >= ? AND p.at < ? AND i.match_state IN ('matched', 'manual')
      AND (p.kind = 'film' AND i.media_type = 'movie' OR p.kind = 'episode' AND i.media_type = 'tv')
    ORDER BY p.at DESC`).all(profileId, from, end) as Row[];

  // The copies that open: on the NAS and not hidden; for a kid, those kids mode shows. A kid's title counts when one does.
  const opens = new Set<number>();
  const copyOf = new Map<string, number>();
  for (const i of db.prepare("SELECT id, media_type || ':' || tmdb_id AS key, present, hidden FROM items WHERE tmdb_id IS NOT NULL").all() as Array<{ id: number; key: string; present: number; hidden: number }>) {
    if (sees ? !sees.has(i.id) : !i.present || i.hidden) continue;
    opens.add(i.id);
    if (!copyOf.has(i.key)) copyOf.set(i.key, i.id);
  }
  const plays: Array<Row & { length: number }> = [];
  for (const r of all) {
    if (sees && !copyOf.has(r.key)) continue;
    const runtime = r.runtime || null;
    const known = r.minutes !== null || runtime !== null || r.kind === 'episode';
    const length = known ? playMinutes(r, runtime, r.kind === 'episode') : 0;
    if (known ? length >= MIN_PLAY_MINUTES : r.finished) plays.push({ ...r, length });
  }
  const finished = plays.filter((r) => r.finished);
  const films = finished.filter((r) => r.kind === 'film').length;
  const episodes = finished.length - films;
  if (films + episodes < MIN_WATCHED) return null;

  // The copy played, else one that opens.
  const title = (r: Row): YearTitle => ({ itemId: opens.has(r.item_id) ? r.item_id : copyOf.get(r.key) ?? r.item_id, name: r.name, poster: img(r.poster, 342) });
  // Each title watched, as its latest play.
  const watched = new Map<string, Row>();
  for (const r of finished) if (!watched.has(r.key)) watched.set(r.key, r);

  const genres = new Map<string, number>();
  const cast = new Map<string, YearTitle[]>();
  for (const r of watched.values()) {
    for (const g of new Set(JSON.parse(r.genres ?? '[]') as string[])) genres.set(g, (genres.get(g) ?? 0) + 1);
    const names = (JSON.parse(r.cast_json ?? '[]') as Array<{ name: string }>).slice(0, CAST).map((c) => c.name);
    for (const n of new Set(names)) cast.set(n, [...(cast.get(n) ?? []), title(r)]);
  }
  const actors = [...cast].map(([name, titles]) => ({ name, n: titles.length, titles })).sort(byCount);
  const top = actors[0];

  const series = new Map<string, Row & { episodes: number }>();
  for (const r of finished) {
    if (r.kind !== 'episode') continue;
    const s = series.get(r.key);
    if (s) s.episodes++;
    else series.set(r.key, { ...r, episodes: 1 });
  }

  const hours24 = Array.from({ length: 24 }, () => 0);
  for (const r of plays) hours24[new Date(r.at).getHours()]!++;
  const primeCount = Math.max(...hours24);

  const logged = plays.filter((r) => !r.estimated && r.device);
  const tvs = new Map<string, number>();
  for (const r of logged) {
    const name = tvNames.get(r.device!) ?? r.device!;
    tvs.set(name, (tvs.get(name) ?? 0) + 1);
  }

  const oldest = [...watched.values()]
    .filter((r) => r.kind === 'film' && r.year !== null)
    .sort((a, b) => a.year! - b.year! || a.name.localeCompare(b.name))[0];

  const posters = new Map<string, string>();
  for (const r of plays) if (r.poster && !posters.has(r.key) && posters.size < POSTERS) posters.set(r.key, img(r.poster, 342)!);

  return {
    year,
    from,
    to: now >= from && now < end ? now : end - 1000,
    films,
    episodes,
    hours: Math.round(plays.reduce((n, r) => n + r.length, 0) / 60),
    estimated: plays.some((r) => r.estimated),
    titles: watched.size,
    genres: [...genres].map(([name, n]) => ({ name, n })).sort(byCount).slice(0, GENRES),
    actor: top && top.n >= 2
      ? { name: top.name, n: top.n, tie: actors[1]?.n === top.n ? actors[1].name : null, photo: null, titles: top.titles.slice(0, ACTOR_TITLES) }
      : null,
    series: [...series.values()]
      .map((s) => ({ ...title(s), episodes: s.episodes, backdrop: img(s.backdrop, 1280) }))
      .sort((a, b) => b.episodes - a.episodes || a.name.localeCompare(b.name))
      .slice(0, SERIES),
    hours24,
    primeHour: plays.length ? hours24.indexOf(primeCount) : null,
    primeCount,
    plays: plays.length,
    afterMidnight: hours24.slice(0, 5).reduce((n, h) => n + h, 0),
    tvs: logged.length ? { since: Math.min(...logged.map((r) => r.at)), rows: [...tvs].map(([name, n]) => ({ name, n })).sort(byCount) } : null,
    oldest: oldest ? { ...title(oldest), year: oldest.year! } : null,
    posters: [...posters.values()],
  };
}
