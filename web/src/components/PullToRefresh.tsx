import { useEffect, useRef, useState, type RefObject } from 'react';
import { IconDown } from './icons.tsx';

// Distances in px of page movement (the finger travels about twice as far).
const READY = 70;
const HOLD = 56;
const MAX = 110;
const SLOP = 8;

/**
 * Pull down at the top of a list to refresh, like native apps. Browsers offer none inside an app's
 * own scrolling panels (nor in the home-screen app), so the gesture is handled here. Touch only.
 */
export function PullToRefresh({ scroller, onRefresh }: { scroller: RefObject<HTMLElement | null>; onRefresh: () => Promise<unknown> }) {
  const indicator = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'idle' | 'pulling' | 'ready' | 'refreshing'>('idle');
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let startX = 0;
    let startY = 0;
    let tracking = false;
    let pulling = false;
    let busy = false;
    let dist = 0;
    // Moved with styles, not React state: this runs on every touchmove.
    const paint = (d: number, animate: boolean, opacity = Math.min(1, d / READY)) => {
      el.style.transition = animate ? 'transform 0.25s ease-out' : 'none';
      el.style.transform = d ? `translateY(${d}px)` : '';
      const ind = indicator.current;
      if (!ind) return;
      ind.style.transition = animate ? 'opacity 0.25s ease-out' : 'none';
      ind.style.opacity = String(opacity);
      ind.style.setProperty('--turn', `${Math.min(1, d / READY) * 180}deg`);
    };
    const onStart = (e: TouchEvent) => {
      // Not while refreshing, not with two fingers, not mid-list, not inside a sheet (Filters).
      tracking = !busy && e.touches.length === 1 && el.scrollTop <= 0 && !(e.target as Element).closest('[role="dialog"]');
      pulling = false;
      startX = e.touches[0]!.clientX;
      startY = e.touches[0]!.clientY;
    };
    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      const dx = e.touches[0]!.clientX - startX;
      const dy = e.touches[0]!.clientY - startY;
      if (!pulling) {
        // A sideways swipe (the poster rows) or scrolling up is not a pull.
        if (Math.abs(dx) > SLOP || dy < -SLOP) tracking = false;
        if (dy < SLOP || Math.abs(dx) > dy || el.scrollTop > 0) return;
        pulling = true;
      }
      e.preventDefault();
      dist = Math.min(MAX, (dy - SLOP) * 0.5);
      paint(dist, false);
      setState(dist >= READY ? 'ready' : 'pulling');
    };
    const onEnd = async () => {
      tracking = false;
      if (!pulling) return;
      pulling = false;
      if (dist < READY) {
        paint(0, true);
        setState('idle');
        return;
      }
      busy = true;
      setState('refreshing');
      paint(HOLD, true, 1);
      try {
        await Promise.all([refresh.current().catch(() => {}), new Promise((r) => setTimeout(r, 600))]);
      } finally {
        busy = false;
        dist = 0;
        paint(0, true);
        setState('idle');
      }
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      el.style.transform = '';
      el.style.transition = '';
    };
  }, [scroller]);

  return (
    <div ref={indicator} className={`ptr ptr-${state}`} role="status" aria-label={state === 'refreshing' ? 'Refreshing' : undefined}>
      {state === 'refreshing' ? <span className="ptr-spin" /> : <IconDown size={20} />}
    </div>
  );
}

/** Rescan the NAS and Kodi on the server, waiting at most `ms` (the rest arrives as live updates). */
export function serverRefresh(post: () => Promise<unknown>, ms = 8000): Promise<unknown> {
  return Promise.race([post().catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
}
