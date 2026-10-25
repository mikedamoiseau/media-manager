import { useSyncExternalStore } from 'react';
import { api } from './api.ts';
import type { Card, NowPlaying, Status, TitleLang } from './types.ts';

type Listener = () => void;

export function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set(next: T | ((prev: T) => T)) {
      state = typeof next === 'function' ? (next as (p: T) => T)(state) : next;
      listeners.forEach((l) => l());
    },
    subscribe(l: Listener) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export function useStore<T>(store: ReturnType<typeof createStore<T>>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

// ---------- local preferences (per device) ----------

function readLocal<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
}

export interface Prefs {
  titleLang: TitleLang;
  /** Library: show films of a collection as one set tile */
  groupSets: boolean;
  /** Library: the Continue watching and Suggested for you rows above the grid */
  showContinue: boolean;
  showSuggested: boolean;
  /** Library: films not on the NAS picked from your tastes, and what's in cinemas */
  showElsewhere: boolean;
  showCinema: boolean;
}

export const prefs = createStore<Prefs>(readLocal('mm.prefs', { titleLang: 'fr', groupSets: false, showContinue: true, showSuggested: true, showElsewhere: true, showCinema: true }));
prefs.subscribe(() => {
  try {
    localStorage.setItem('mm.prefs', JSON.stringify(prefs.get()));
  } catch {
    /* private mode */
  }
});

// ---------- library ----------

export const library = createStore<{ items: Card[]; version: string | null; loading: boolean; error: string | null }>({
  items: [],
  version: null,
  loading: true,
  error: null,
});

let loadingPromise: Promise<void> | null = null;

export function loadLibrary(): Promise<void> {
  loadingPromise ??= (async () => {
    try {
      const r = await api.get<{ version: string; items: Card[] }>('/api/library');
      library.set({ items: r.items, version: r.version, loading: false, error: null });
    } catch (e) {
      library.set((s) => ({ ...s, loading: false, error: (e as Error).message }));
    } finally {
      loadingPromise = null;
    }
  })();
  return loadingPromise;
}

// ---------- server status (SSE) ----------

export const status = createStore<Status | null>(null);
export const online = createStore<boolean>(true);

export function connectEvents(): void {
  let es: EventSource | null = null;
  let retry = 1000;
  const open = () => {
    es = new EventSource('/api/events');
    es.addEventListener('open', () => {
      retry = 1000;
      online.set(true);
    });
    es.addEventListener('status', (e) => status.set(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('library', (e) => {
      if ((e as MessageEvent).data !== library.get().version) void loadLibrary();
    });
    es.addEventListener('error', () => {
      online.set(false);
      es?.close();
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 15000);
    });
  };
  open();
  // Coming back to the app (phone unlocked): refresh right away.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void loadLibrary();
      void pollNowPlaying();
    }
  });
}

// ---------- Kodi now playing ----------

export const nowPlaying = createStore<NowPlaying | null>(null);
let fastPoll = 0;

export async function pollNowPlaying(): Promise<void> {
  if (!status.get()?.kodi.host) return;
  try {
    nowPlaying.set(await api.get<NowPlaying>('/api/kodi/now'));
  } catch {
    nowPlaying.set(null);
  }
}

/** Poll Kodi every 1s while the remote is open, every 5s otherwise (only when the app is visible). */
export function startNowPlayingLoop(): void {
  const tick = async () => {
    if (document.visibilityState === 'visible') await pollNowPlaying();
    setTimeout(tick, fastPoll > 0 ? 1000 : 5000);
  };
  void tick();
}

export function startFastPoll(): () => void {
  fastPoll++;
  void pollNowPlaying();
  return () => {
    fastPoll--;
  };
}

// ---------- toasts ----------

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}
export const toasts = createStore<Toast[]>([]);
let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = ++toastId;
  toasts.set((t) => [...t.slice(-2), { id, text, kind }]);
  setTimeout(() => toasts.set((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3000);
}
