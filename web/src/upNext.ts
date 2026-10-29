import type { Sleep, UpNextEntry } from './types.ts';

/** "S2 E5", "E5", or null for a film. */
export function entryLabel(e: Pick<UpNextEntry, 'season' | 'episode'>): string | null {
  if (e.episode == null) return null;
  return e.season != null ? `S${e.season} E${e.episode}` : `E${e.episode}`;
}

/** What the sleep timer will do, or null when there is none. Minutes are rounded up: "1 min" until it stops. */
export function sleepLabel(s: Sleep, now: number, episode: boolean): string | null {
  if (!s) return null;
  if ('afterThis' in s) return `Stops after this ${episode ? 'episode' : 'film'}`;
  return `Stops in ${Math.max(1, Math.ceil((s.at - now) / 60_000))} min`;
}
