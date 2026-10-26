// Kids mode in the app: as server/kids.ts (the server decides; these only shape the screens).

/** A kids profile's age limit, on Germany's FSK steps. */
export const FSK_STEPS = [0, 6, 12, 16];

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
 * What the library shows: everything (not a kids profile: null), a kid's own titles, or nothing while the
 * kid's list is loading (undefined), so nothing else ever flashes by.
 */
export function kidsLibrary<T extends { id: number }>(cards: T[], allowed: Set<number> | null | undefined): T[] {
  if (allowed === null) return cards;
  if (!allowed) return [];
  return cards.filter((c) => allowed.has(c.id));
}
