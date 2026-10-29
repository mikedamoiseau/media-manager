// Series tracker and Coming soon: how missing episodes, what's next and each tile read.
import { formatDay, setName } from './search.ts';
import type { NextUp, SeasonGap, SoonEntry } from './types.ts';

const ep = (n: number) => `E${String(n).padStart(2, '0')}`;

/** "E03, E07–E08". */
function ranges(nums: number[]): string {
  const sorted = [...nums].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const from = sorted[i]!;
    while (sorted[i + 1] === sorted[i]! + 1) i++;
    out.push(sorted[i] === from ? ep(from) : `${ep(from)}–${ep(sorted[i]!)}`);
  }
  return out.join(', ');
}

/** "Season 2: all 10 episodes", "Season 1: E03, E07–E08". */
export function gapLabel(g: SeasonGap): string {
  if (g.missing.length === g.aired) return `Season ${g.season}: ${g.aired === 1 ? '1 episode' : `all ${g.aired} episodes`}`;
  return `Season ${g.season}: ${ranges(g.missing)}`;
}

/** "Season 4 starts 8 Jul 2027", "Season 3 announced", "Next episode S03E05 on 2 Nov". */
export function nextLabel(n: NextUp, today = new Date()): string {
  if (n.kind === 'season') return n.date ? `Season ${n.season} starts ${formatDay(n.date, today)}` : `Season ${n.season} announced`;
  const which = `S${String(n.s).padStart(2, '0')}${ep(n.e)}`;
  return n.date ? `Next episode ${which} on ${formatDay(n.date, today)}` : `Next episode ${which}`;
}

/** A Coming soon tile's line: the set first, then the cinema, then the reminder. */
export function soonWhy(e: SoonEntry, today = new Date()): string {
  const when = e.date ? formatDay(e.date, today) : 'no date yet';
  if (e.kind === 'season') return `Season ${e.season} · ${when}`;
  if (e.set) return `Next in ${setName(e.set)} · ${when}`;
  if (e.cinema && e.date) return `In cinemas ${when}`;
  return `${e.cinema ? 'In cinemas' : 'Reminder'} · ${when}`;
}
