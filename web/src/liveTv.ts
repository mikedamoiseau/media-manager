import type { LiveChannel, LiveProgramme } from './types.ts';
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
