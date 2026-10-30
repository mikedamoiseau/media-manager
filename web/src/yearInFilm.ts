import type { YearInFilm } from './types.ts';

// What Your year in film says, from the year's numbers.

export type CardKey = 'open' | 'count' | 'hours' | 'genres' | 'actor' | 'series' | 'prime' | 'tvs' | 'summary';

/** The story's cards in order: one with nothing to say is left out; the first and the last are always there. */
export function storyCards(y: YearInFilm): CardKey[] {
  const has: Record<CardKey, boolean> = {
    open: true,
    count: true,
    hours: y.hours > 0,
    genres: y.genres.length > 0,
    actor: !!y.actor,
    series: y.series.length > 0,
    prime: y.primeHour !== null,
    tvs: !!y.tvs,
    summary: true,
  };
  return (Object.keys(has) as CardKey[]).filter((k) => has[k]);
}

/** An hour of the day: '10 PM', 'Midnight', 'Noon'. */
export function hourLabel(h: number): string {
  if (h === 0) return 'Midnight';
  if (h === 12) return 'Noon';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

const NUMBERS = ['', 'a', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** The hours in days ('More than three days'); a day or less: null. */
export function daysLine(hours: number): string | null {
  const days = Math.floor((hours - 1) / 24);
  if (days < 1) return null;
  return days === 1 ? 'More than a day' : `More than ${NUMBERS[days] ?? days} days`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The question's line: '46 films, 103 episodes and one actor you kept coming back to'. */
export function teaser(y: YearInFilm): string {
  const parts = [y.films > 0 && plural(y.films, 'film'), y.episodes > 0 && plural(y.episodes, 'episode')].filter((p): p is string => !!p);
  if (y.actor) parts.push('one actor you kept coming back to');
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] ?? '';
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayMonth = (t: number) => `${new Date(t).getDate()} ${MONTHS[new Date(t).getMonth()]}`;

/** The dates covered while the year runs ('1 January to 29 October'); the year over: null. */
export function coveredLine(y: YearInFilm, now: number): string | null {
  return new Date(now).getFullYear() === y.year ? `${dayMonth(y.from)} to ${dayMonth(y.to)}` : null;
}
