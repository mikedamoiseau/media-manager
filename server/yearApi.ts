import type { Context, Hono } from 'hono';
import type { Service } from './service.ts';
import { img } from './views.ts';
import { yearInFilm, yearToShow } from './yearInFilm.ts';

/** An actor's photo is asked of TMDB again after this. */
const PHOTO_KEPT = 30 * 86400_000;

/** Your year in film for the profile asking; kids too (among the kids' routes), of what kids mode shows them (`sees`). */
export function yearRoutes(api: Hono, svc: Service, who: (c: Context) => number, sees: (c: Context) => Set<number> | null): void {
  const db = svc.db;
  /** `?year=` (a preview at any time, for checks), else the year offered now; undefined: not a year. */
  const yearOf = (c: Context, now: number): number | null | undefined => {
    const q = c.req.query('year');
    if (q === undefined) return yearToShow(now);
    return /^\d{4}$/.test(q) ? Number(q) : undefined;
  };

  /** The actor's photo: kept for 30 days once TMDB answered (a photo or none); TMDB not set up or failing: none, asked again next time. */
  const photoOf = async (name: string, now: number): Promise<string | null> => {
    const kept = db.prepare('SELECT url, fetched_at FROM person_photos WHERE name = ?').get(name) as { url: string | null; fetched_at: number } | undefined;
    if (kept && now - kept.fetched_at < PHOTO_KEPT) return img(kept.url, 185);
    const url = await svc.tmdb()?.personPhoto(name).catch(() => undefined);
    if (url === undefined) return null;
    db.prepare('INSERT INTO person_photos (name, url, fetched_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET url = excluded.url, fetched_at = excluded.fetched_at')
      .run(name, url, now);
    return img(url, 185);
  };

  api.get('/year', async (c) => {
    const now = Date.now();
    const year = yearOf(c, now);
    if (year === undefined) return c.json({ error: 'Pick a year' }, 400);
    const profile = who(c);
    const tvNames = new Map([...svc.tvs().map((t) => [t.id, t.name] as const), ['phone', 'On the phone'] as const]);
    const y = year === null ? null : yearInFilm(db, profile, year, now, tvNames, sees(c));
    if (!y) return c.json({ error: 'Nothing to show' }, 404);
    if (y.actor) y.actor.photo = await photoOf(y.actor.name, now);
    const asked = !!db.prepare('SELECT 1 FROM year_asked WHERE profile_id = ? AND year = ?').get(profile, y.year);
    return c.json({ ...y, asked });
  });

  /** The question was answered (or closed) on some device: not asked again. */
  api.post('/year/asked', (c) => {
    const now = Date.now();
    const year = yearOf(c, now);
    if (year === undefined) return c.json({ error: 'Pick a year' }, 400);
    if (year === null) return c.json({ error: 'Nothing to show' }, 404);
    db.prepare('INSERT OR IGNORE INTO year_asked (profile_id, year, at) VALUES (?, ?, ?)').run(who(c), year, now);
    return c.body(null, 204);
  });
}
