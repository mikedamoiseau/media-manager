// Kids mode: which titles a kids profile sees, and what it may do.
import { createHash, randomBytes } from 'node:crypto';
import type { DB } from './db.ts';

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
