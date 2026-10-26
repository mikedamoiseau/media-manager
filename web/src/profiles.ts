import type { Profile } from './types.ts';

/** As server/profiles.ts: the first is the main profile's. */
export const PROFILE_COLORS = ['#e8a33d', '#e5674e', '#d9548c', '#9b6ce0', '#4f8ff0', '#2fb3a6', '#6cbf4a', '#8a94a6'];

/** This device's profile: the one it picked, while it exists; none: the app asks who's watching. */
export function chosenProfile(profiles: Profile[], id: number | null): Profile | null {
  return profiles.find((p) => p.id === id) ?? null;
}

/** What the round badge shows: the first letter of the name. */
export const initial = (name: string) => ([...name.trim()][0] ?? '?').toUpperCase();
