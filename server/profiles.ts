import type { DB } from './db.ts';
import { FSK_STEPS, hasParentsCode } from './kids.ts';

/** Who's watching: each person's likes, activity and progress. The library itself is shared. */
export interface Profile {
  id: number;
  name: string;
  color: string;
  /** gets what was recorded before profiles, and what is played on a TV without the app; can't be removed */
  main: boolean;
  /** a kids profile: only titles fit for it, the parents' code to leave it */
  kids: boolean;
  /** a kids profile's age limit (Germany's FSK steps) */
  maxAge: number;
  /** a kids profile's bedtime, "HH:MM"; none: null */
  bedtime: string | null;
}

export const MAIN_PROFILE = 1;

/** The first one is the main profile's (set in the migration that created profiles). */
export const PROFILE_COLORS = ['#e8a33d', '#e5674e', '#d9548c', '#9b6ce0', '#4f8ff0', '#2fb3a6', '#6cbf4a', '#8a94a6'];

/** A profile that can't be saved or removed as asked: the message says why. */
export class ProfileError extends Error {}

type Row = { id: number; name: string; color: string; kids: number; max_age: number; bedtime: string | null };
const asProfile = (r: Row): Profile => ({
  id: r.id, name: r.name, color: r.color, main: r.id === MAIN_PROFILE, kids: !!r.kids, maxAge: r.max_age, bedtime: r.bedtime,
});
const COLUMNS = 'id, name, color, kids, max_age, bedtime';

/** What a profile's form may change; bedtime null: none. */
export interface ProfileInput {
  name?: string;
  color?: string;
  kids?: boolean;
  maxAge?: number;
  bedtime?: string | null;
}

export function listProfiles(db: DB): Profile[] {
  return (db.prepare(`SELECT ${COLUMNS} FROM profiles ORDER BY id`).all() as unknown as Row[]).map(asProfile);
}

function find(db: DB, id: number): Profile {
  const r = db.prepare(`SELECT ${COLUMNS} FROM profiles WHERE id = ?`).get(id) as unknown as Row | undefined;
  if (!r) throw new ProfileError('Profile not found');
  return asProfile(r);
}

type Checked = Omit<Profile, 'id' | 'main'>;

function checked(db: DB, id: number | null, p: Checked): Checked {
  const name = p.name.trim();
  if (!name) throw new ProfileError('Give the profile a name');
  if (!PROFILE_COLORS.includes(p.color)) throw new ProfileError('Pick a colour');
  const same = listProfiles(db).find((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase());
  if (same) throw new ProfileError(`${same.name} is already a profile`);
  if (!FSK_STEPS.includes(p.maxAge)) throw new ProfileError('Pick an age limit');
  if (p.bedtime !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.bedtime)) throw new ProfileError('Bedtime is a time like 20:00');
  if (p.kids && id === MAIN_PROFILE) throw new ProfileError("The main profile can't be a kids profile");
  if (p.kids && !hasParentsCode(db)) throw new ProfileError("Set the parents' code first");
  return { ...p, name };
}

export function addProfile(db: DB, input: ProfileInput, now = Date.now()): Profile {
  const p = checked(db, null, {
    name: input.name ?? '', color: input.color ?? '', kids: !!input.kids, maxAge: input.maxAge ?? 12, bedtime: input.bedtime ?? null,
  });
  const r = db.prepare('INSERT INTO profiles (name, color, kids, max_age, bedtime, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(p.name, p.color, p.kids ? 1 : 0, p.maxAge, p.bedtime, now);
  return find(db, Number(r.lastInsertRowid));
}

export function editProfile(db: DB, id: number, patch: ProfileInput): Profile {
  const was = find(db, id);
  const p = checked(db, id, {
    name: patch.name ?? was.name, color: patch.color ?? was.color, kids: patch.kids ?? was.kids,
    maxAge: patch.maxAge ?? was.maxAge, bedtime: patch.bedtime === undefined ? was.bedtime : patch.bedtime,
  });
  db.prepare('UPDATE profiles SET name = ?, color = ?, kids = ?, max_age = ?, bedtime = ? WHERE id = ?')
    .run(p.name, p.color, p.kids ? 1 : 0, p.maxAge, p.bedtime, id);
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
