import type { CatalogRow, LiveChannel, LiveProgramme } from './types.ts';
import { vlcLink } from './vlc.ts';

/** From this width the guide is a grid (a phone held sideways, a tablet, a computer); below, a list. */
export const GRID_MIN_WIDTH = 700;

export type LiveView = 'grid' | 'list';

/** The view for this screen: the switch holds while the screen keeps the shape it was flipped on. */
export function liveView(screen: { w: number; h: number }, override: { view: LiveView; w: number; h: number } | null): LiveView {
  if (override && override.w === screen.w && override.h === screen.h) return override.view;
  return screen.w >= GRID_MIN_WIDTH ? 'grid' : 'list';
}

/** What's on, what's next, and how far into what's on (0..1). */
export function nowAndNext(ps: LiveProgramme[], now: number): { now?: LiveProgramme; next?: LiveProgramme; progress: number } {
  const on = ps.find((p) => p.start <= now && now < p.stop);
  const next = ps.find((p) => p.start >= (on ? on.stop : now));
  return { now: on, next, progress: on ? (now - on.start) / (on.stop - on.start) : 0 };
}

/** Where a programme sits in the grid's window, cut to it; null when it's outside. */
export function gridSpan(p: LiveProgramme, from: number, to: number, pxPerMin: number): { left: number; width: number } | null {
  const start = Math.max(p.start, from);
  const stop = Math.min(p.stop, to);
  if (stop <= start) return null;
  return { left: ((start - from) / 60_000) * pxPerMin, width: ((stop - start) / 60_000) * pxPerMin };
}

const HALF_HOUR = 30 * 60_000;

/** Where the grid starts: half an hour back, on the half hour. */
export function gridStart(now: number): number {
  return Math.floor((now - HALF_HOUR) / HALF_HOUR) * HALF_HOUR;
}

/** The grid's start on a page left open: kept until it's six hours behind, then half an hour back from now again. */
export function gridFrom(from: number, now: number): number {
  return now - from > 6 * 3600_000 ? gridStart(now) : from;
}

/** VLC on the phone: the stream itself, or the app's one-channel playlist when the channel needs request headers. */
export function liveVlcHref(origin: string, ch: LiveChannel, back: string | null): string {
  return vlcLink(ch.vlc === 'direct' ? ch.url : `${origin}/api/livetv/${encodeURIComponent(ch.key)}/vlc.m3u`, back);
}

// The channels' categories: their lists, as the server names them too (LIST_NAMES in server/livetv.ts).
const LISTS = ['fr', 'be', 'extra'];
const NAMES: Record<string, string> = { fr: 'France', be: 'Belgium', extra: 'Extra' };

/** A category's name. */
export const listName = (list: string): string => NAMES[list] ?? list;

/** The categories among these, each once, in their order (an unknown one last). */
export function listsIn(lists: string[]): string[] {
  const rank = (l: string) => (LISTS.includes(l) ? LISTS.indexOf(l) : LISTS.length);
  return [...new Set(lists)].sort((a, b) => rank(a) - rank(b));
}

/** `keys` with the places of `subset`'s channels filled with `subset`, in its order: the other channels stay put. */
export function inSlots(keys: string[], subset: string[]): string[] {
  const members = new Set(subset);
  let i = 0;
  const next = keys.map((k) => (members.has(k) ? subset[i++]! : k));
  return next.every((k, j) => k === keys[j]) ? keys : next;
}

/** The list with `key` moved one place (`by`: -1 up, 1 down); unchanged at the ends. */
export function moveKey(keys: string[], key: string, by: -1 | 1): string[] {
  const i = keys.indexOf(key);
  const j = i + by;
  if (i < 0 || j < 0 || j >= keys.length) return keys;
  const next = [...keys];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** A dragged row: one place per row-height travelled (past half a row), up to the ends. `rows`: how far it went. */
export function dragMove(keys: string[], key: string, dy: number, rowHeight: number): { keys: string[]; rows: number } {
  const want = Math.ceil(Math.abs(dy) / rowHeight - 0.5);
  const by = dy > 0 ? 1 : -1;
  let next = keys;
  let rows = 0;
  while (Math.abs(rows) < want) {
    const moved = moveKey(next, key, by);
    if (moved === next) break;
    next = moved;
    rows += by;
  }
  return { keys: next, rows };
}

/** A picked channel's guide, as Settings shows it. */
export function guideLabel(row: Pick<CatalogRow, 'listed' | 'guide'>): string {
  const g = row.guide;
  if (!row.listed) return 'No longer listed by iptv-org';
  if (g.mode === 'none') return 'No guide';
  if (!g.name) return g.mode === 'manual' ? 'The guide channel picked is gone from the guides' : 'No guide found';
  return `Guide: ${g.name} · ${g.source ? new URL(g.source).hostname.replace(/^www\./, '') : ''}${g.mode === 'manual' ? ' (picked)' : ''}`;
}
