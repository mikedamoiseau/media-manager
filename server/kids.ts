// Kids mode: which titles a kids profile sees, and what it may do.
import { createHash, randomBytes } from 'node:crypto';
import type { DB } from './db.ts';
import type { RemoteAction } from './kodi.ts';

/** Asked as it is: the message says why (shown in the app). */
export class KidsError extends Error {}

/** A kids profile's age limit, on Germany's FSK steps. */
export const FSK_STEPS = [0, 6, 12, 16];

/** Age ratings from TMDB, for the countries the rule reads. */
export type Certs = Partial<Record<'DE' | 'FR' | 'US', string>>;

export const CERT_COUNTRIES = ['DE', 'FR', 'US'] as const;

const DE: Record<string, number> = { '0': 0, '6': 6, '12': 12, '16': 16, '18': 18 };
const FR: Record<string, number> = { TP: 0, U: 0, '10': 10, '12': 12, '16': 16, '18': 18 };
const US: Record<string, number> = {
  G: 0, 'TV-Y': 0, 'TV-G': 0, 'TV-Y7': 7, PG: 8, 'TV-PG': 10, 'PG-13': 13, 'TV-14': 14, R: 17, 'TV-MA': 17, 'NC-17': 18,
};

/**
 * The age a title is rated for: Germany's (FSK) when there is one, else the stricter of France's and the
 * US's (France is lenient: it rates some adult anime "Tous publics"). None of them: no rating.
 */
export function ageOf(certs: Certs | null | undefined): number | undefined {
  if (!certs) return undefined;
  const de = DE[certs.DE ?? ''];
  if (de !== undefined) return de;
  const others = [FR[(certs.FR ?? '').replace(/^-/, '')], US[certs.US ?? '']].filter((a) => a !== undefined);
  return others.length ? Math.max(...others) : undefined;
}

// ---------- which titles a kid sees ----------

/** Made for kids: in the KIDS folder, or TMDB calls it Family or Animation. */
export function madeForKids(category: string, genres: string[]): boolean {
  return category === 'kids' || genres.includes('Family') || genres.includes('Animation');
}

type KeyRow = { id: number; media_type: string | null; tmdb_id: number | null };
/** As the library groups items: one key for every copy of a title (an override covers them all). */
const keyOf = (r: KeyRow) => (r.tmdb_id ? `${r.media_type}:${r.tmdb_id}` : `i:${r.id}`);

export function itemKey(db: DB, itemId: number): string | undefined {
  const r = db.prepare('SELECT id, media_type, tmdb_id FROM items WHERE id = ?').get(itemId) as KeyRow | undefined;
  return r && keyOf(r);
}

/** A parent's call on a title: OK for kids, not for kids, or none (the rule decides). */
export type Override = 'ok' | 'no' | null;

export function overrideOf(db: DB, key: string): Override {
  const r = db.prepare('SELECT ok FROM kids_overrides WHERE key = ?').get(key) as { ok: number } | undefined;
  return r ? (r.ok ? 'ok' : 'no') : null;
}

export function setOverride(db: DB, key: string, value: Override, now = Date.now()): void {
  if (value === null) db.prepare('DELETE FROM kids_overrides WHERE key = ?').run(key);
  else db.prepare('INSERT INTO kids_overrides (key, ok, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET ok = excluded.ok, at = excluded.at')
    .run(key, value === 'ok' ? 1 : 0, now);
}

/**
 * The items a kid with this age limit sees (on disk, not hidden): a parent's "OK for kids", or made for
 * kids and within age (no rating: only in the KIDS folder), unless a parent said "not for kids".
 */
export function allowedItems(db: DB, maxAge: number): Set<number> {
  const overrides = new Map((db.prepare('SELECT key, ok FROM kids_overrides').all() as Array<{ key: string; ok: number }>).map((r) => [r.key, r.ok]));
  const rows = db.prepare(`SELECT i.id, i.media_type, i.tmdb_id, i.category, t.genres, t.certs FROM items i
    LEFT JOIN titles t ON t.media_type = i.media_type AND t.tmdb_id = i.tmdb_id
    WHERE i.present = 1 AND i.hidden = 0`).all() as Array<KeyRow & { category: string; genres: string | null; certs: string | null }>;
  const allowed = new Set<number>();
  for (const r of rows) {
    const o = overrides.get(keyOf(r));
    if (o === 0) continue;
    const age = ageOf(r.certs ? (JSON.parse(r.certs) as Certs) : null);
    const withinAge = age === undefined ? r.category === 'kids' : age <= maxAge;
    if (o === 1 || (withinAge && madeForKids(r.category, r.genres ? (JSON.parse(r.genres) as string[]) : []))) allowed.add(r.id);
  }
  return allowed;
}

/** A kids profile, as the rule and bedtime need it. */
export interface KidsProfile {
  id: number;
  name: string;
  maxAge: number;
  bedtime: string | null;
}

const KIDS = 'SELECT id, name, max_age AS maxAge, bedtime FROM profiles WHERE kids = 1';

/** The profile when it is a kids one, else null. */
export function kidsProfile(db: DB, profileId: number): KidsProfile | null {
  const r = db.prepare(`${KIDS} AND id = ?`).get(profileId) as KidsProfile | undefined;
  return r ? { ...r } : null;
}

export function kidsProfiles(db: DB): KidsProfile[] {
  return (db.prepare(`${KIDS} ORDER BY id`).all() as unknown as KidsProfile[]).map((r) => ({ ...r }));
}

// ---------- what a kids profile may ask ----------

// The server's side of kids mode: the app shows no more than this, and a kids profile can't reach more.
const KIDS_ROUTES: Array<[string, RegExp]> = [
  ['GET', /^\/(library|marks|continue|suggestions|status|events|profiles|img|kids\/allowed|kodi\/now|kodi\/streams)$/],
  ['GET', /^\/(items|thumb|poster)\/\d+$/],
  ['POST', /^\/items\/\d+\/(play|activity)$/],
  ['PUT', /^\/items\/\d+\/rating$/],
  ['POST', /^\/continue\/\d+\/dismiss$/],
  ['POST', /^\/(kodi\/remote|kids\/unlock|refresh)$/],
];

/** Whether a kids profile may make this request (path as under /api). */
export function kidsRoute(method: string, path: string): boolean {
  return KIDS_ROUTES.some(([m, re]) => m === method && re.test(path));
}

/** The TV controls kids mode keeps: for a break, the sound, the language and the subtitles. */
export const KIDS_REMOTE: ReadonlySet<RemoteAction> = new Set<RemoteAction>(['playpause', 'stop', 'volume', 'mute', 'subtitles', 'audio']);

// ---------- bedtime ----------

// Bedtime lasts until the morning.
const MORNING = 6 * 60;
const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/** From the bedtime ("HH:MM") until 6:00, local time. No bedtime: never. */
export function isBedtime(bedtime: string | null, now: Date): boolean {
  if (!bedtime) return false;
  const b = minutes(bedtime);
  const m = now.getHours() * 60 + now.getMinutes();
  return b >= MORNING ? m >= b || m < MORNING : m >= b && m < MORNING;
}

/**
 * A play that just started on a TV is stopped at bedtime only when it is a kid's and Kodi went on to it
 * by itself (the next episode): what plays finishes, a parent's play never stops.
 */
export function bedtimeStop(kid: { bedtime: string | null } | null, chained: boolean, now: Date): boolean {
  return !!kid && chained && isBedtime(kid.bedtime, now);
}

// ---------- the parents' code ----------

// In the settings table but not among the app's settings (never sent to a phone): a salted hash.
const CODE_KEY = 'parentsCode';
const hashed = (salt: string, code: string) => createHash('sha256').update(`${salt}:${code}`).digest('hex');

/** The household's code to leave kids mode: 4 digits. Set again from any device not in kids mode. */
export function setParentsCode(db: DB, code: string): void {
  if (!/^\d{4}$/.test(code)) throw new KidsError('The code is 4 digits');
  const salt = randomBytes(8).toString('hex');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(CODE_KEY, JSON.stringify({ salt, hash: hashed(salt, code) }));
}

export function hasParentsCode(db: DB): boolean {
  return !!db.prepare('SELECT 1 FROM settings WHERE key = ?').get(CODE_KEY);
}

export function checkParentsCode(db: DB, code: string): boolean {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(CODE_KEY) as { value: string } | undefined;
  if (!r) return false;
  const { salt, hash } = JSON.parse(r.value) as { salt: string; hash: string };
  return hashed(salt, code) === hash;
}
