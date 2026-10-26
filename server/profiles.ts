import type { DB } from './db.ts';

/** Who's watching: each person's likes, activity and progress. The library itself is shared. */
export interface Profile {
  id: number;
  name: string;
  color: string;
  /** gets what was recorded before profiles, and what is played on a TV without the app; can't be removed */
  main: boolean;
}

export const MAIN_PROFILE = 1;

/** The first one is the main profile's (set in the migration that created profiles). */
export const PROFILE_COLORS = ['#e8a33d', '#e5674e', '#d9548c', '#9b6ce0', '#4f8ff0', '#2fb3a6', '#6cbf4a', '#8a94a6'];

/** A profile that can't be saved or removed as asked: the message says why. */
export class ProfileError extends Error {}

type Row = { id: number; name: string; color: string };
const asProfile = (r: Row): Profile => ({ id: r.id, name: r.name, color: r.color, main: r.id === MAIN_PROFILE });

export function listProfiles(db: DB): Profile[] {
  return (db.prepare('SELECT id, name, color FROM profiles ORDER BY id').all() as unknown as Row[]).map(asProfile);
}

function find(db: DB, id: number): Profile {
  const r = db.prepare('SELECT id, name, color FROM profiles WHERE id = ?').get(id) as unknown as Row | undefined;
  if (!r) throw new ProfileError('Profile not found');
  return asProfile(r);
}

function checked(db: DB, id: number | null, name: string, color: string): { name: string; color: string } {
  const n = name.trim();
  if (!n) throw new ProfileError('Give the profile a name');
  if (!PROFILE_COLORS.includes(color)) throw new ProfileError('Pick a colour');
  const same = listProfiles(db).find((p) => p.id !== id && p.name.toLowerCase() === n.toLowerCase());
  if (same) throw new ProfileError(`${same.name} is already a profile`);
  return { name: n, color };
}

export function addProfile(db: DB, input: { name?: string; color?: string }, now = Date.now()): Profile {
  const p = checked(db, null, input.name ?? '', input.color ?? '');
  const r = db.prepare('INSERT INTO profiles (name, color, created_at) VALUES (?, ?, ?)').run(p.name, p.color, now);
  return find(db, Number(r.lastInsertRowid));
}

export function editProfile(db: DB, id: number, patch: { name?: string; color?: string }): Profile {
  const was = find(db, id);
  const p = checked(db, id, patch.name ?? was.name, patch.color ?? was.color);
  db.prepare('UPDATE profiles SET name = ?, color = ? WHERE id = ?').run(p.name, p.color, id);
  return find(db, id);
}

/** Its likes, activity and progress go with it. */
export function removeProfile(db: DB, id: number): void {
  if (id === MAIN_PROFILE) throw new ProfileError("The main profile can't be removed");
  find(db, id);
  db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
}

/** The profile a request is for: the one it names when it exists, else the main one. */
export function profileOf(db: DB, raw: string | undefined | null): number {
  const id = Number(raw);
  if (!raw || !Number.isInteger(id)) return MAIN_PROFILE;
  return db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(id) ? id : MAIN_PROFILE;
}
