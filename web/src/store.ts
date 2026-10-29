import { useSyncExternalStore } from 'react';
import { api, setKodiTv, setProfile } from './api.ts';
import { chosenTv } from './tvs.ts';
import { chosenProfile } from './profiles.ts';
import { allowedAtFirst, kidsLibrary } from './kids.ts';
import type { Card, NowPlaying, Profile, Status, TitleLang, TvStatus } from './types.ts';

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
  /** Library: new seasons, sequels, cinema releases and reminders to come */
  showSoon: boolean;
}

export const prefs = createStore<Prefs>(readLocal('mm.prefs', { titleLang: 'fr', groupSets: false, showContinue: true, showSuggested: true, showElsewhere: true, showCinema: true, showSoon: true }));
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
// The cards as the server sends them; the library shows them with this profile's marks, and a kid's only.
let cards: Card[] = [];

/** What this device's profile watched and has in progress: the cards are the same for everyone. */
const marks = createStore<{ w: Set<number>; rs: Set<number> }>({ w: new Set(), rs: new Set() });
const withMarks = (items: Card[]) => {
  const m = marks.get();
  return items.map((c) => ({ ...c, w: m.w.has(c.id), rs: m.rs.has(c.id) }));
};

/** A kids profile's titles; null: not a kids profile (everything); undefined: not known yet (nothing shown). */
export const allowed = createStore<Set<number> | null | undefined>(undefined);
const shown = () => kidsLibrary(withMarks(cards), allowed.get());

export async function loadAllowed(): Promise<void> {
  const who = profileChoice.get();
  if (!who) return;
  try {
    const r = await api.get<{ ids: number[] | null }>('/api/kids/allowed');
    if (profileChoice.get() !== who) return;
    allowed.set(r.ids ? new Set(r.ids) : null);
    library.set((s) => ({ ...s, items: shown() }));
  } catch {
    /* a kid's list stays as it was (nothing, at first); a grown-up's comes from the status below */
  }
}

export async function loadMarks(): Promise<void> {
  const who = profileChoice.get();
  if (!who) return;
  try {
    const m = await api.get<{ w: number[]; rs: number[] }>('/api/marks');
    // Asked for the profile this device has left meanwhile.
    if (profileChoice.get() !== who) return;
    marks.set({ w: new Set(m.w), rs: new Set(m.rs) });
    library.set((s) => ({ ...s, items: shown() }));
  } catch {
    /* the badges stay as they were */
  }
}

export function loadLibrary(): Promise<void> {
  loadingPromise ??= (async () => {
    // A kid gets only their titles: an answer for the profile this device has since left is dropped.
    const who = profileChoice.get();
    try {
      const r = await api.get<{ version: string; items: Card[] }>('/api/library');
      if (profileChoice.get() !== who) return;
      cards = r.items;
      library.set({ items: shown(), version: r.version, loading: false, error: null });
    } catch (e) {
      library.set((s) => ({ ...s, loading: false, error: (e as Error).message }));
    } finally {
      loadingPromise = null;
    }
  })();
  return loadingPromise;
}

/** The library again once a load under way is done (that one may be for the profile before). */
function reloadLibrary(): void {
  void (loadingPromise ?? Promise.resolve()).then(() => loadLibrary());
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
      // A sync may have given this profile new progress even when the cards didn't change.
      void loadMarks();
      // A parent's call on a title may have changed a kid's list.
      void loadAllowed();
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
      void loadMarks();
      void loadAllowed();
      void pollNowPlaying();
    }
  });
}

// ---------- Kodi now playing ----------

export const nowPlaying = createStore<NowPlaying | null>(null);
/** This device's TV didn't answer the last time it was asked: why. */
export const nowPlayingError = createStore<string | null>(null);
let fastPoll = 0;

export async function pollNowPlaying(): Promise<void> {
  if (!status.get()?.tvs.length) return;
  const tv = tvChoice.get();
  try {
    const np = await api.get<NowPlaying>('/api/kodi/now');
    // The answer of a TV this device left meanwhile: not about the TV it controls now.
    if (tvChoice.get() !== tv) return;
    nowPlaying.set(np);
    nowPlayingError.set(null);
  } catch (e) {
    if (tvChoice.get() !== tv) return;
    nowPlaying.set(null);
    nowPlayingError.set((e as Error).message);
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

// ---------- the TV this device controls ----------

function readTv(): string | null {
  try {
    return localStorage.getItem('mm.tv');
  } catch {
    return null;
  }
}

/** The TV this phone or iPad picked, each its own; null (or a TV removed since): the first. */
export const tvChoice = createStore<string | null>(readTv());
setKodiTv(tvChoice.get());
tvChoice.subscribe(() => {
  const id = tvChoice.get();
  setKodiTv(id);
  try {
    if (id) localStorage.setItem('mm.tv', id);
    else localStorage.removeItem('mm.tv');
  } catch {
    /* private mode */
  }
  // Another TV: what played on the last one says nothing about this one.
  nowPlaying.set(null);
  nowPlayingError.set(null);
  void pollNowPlaying();
});
// The TV picked was removed: back to the first, and not to a TV added later under the same id.
status.subscribe(() => {
  const tvs = status.get()?.tvs;
  const id = tvChoice.get();
  if (tvs && id && !tvs.some((t) => t.id === id)) tvChoice.set(null);
});

/** This device's TV; null when none is set up. */
export function useTv(): TvStatus | null {
  const st = useStore(status);
  const choice = useStore(tvChoice);
  return chosenTv(st?.tvs ?? [], choice);
}

// ---------- who's watching on this device ----------

function readProfile(): number | null {
  try {
    const id = Number(localStorage.getItem('mm.profile'));
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/** The profile this phone or iPad picked, each its own; null: the app asks who's watching. */
export const profileChoice = createStore<number | null>(readProfile());
setProfile(profileChoice.get());
profileChoice.subscribe(() => {
  const id = profileChoice.get();
  setProfile(id);
  try {
    if (id) localStorage.setItem('mm.profile', String(id));
    else localStorage.removeItem('mm.profile');
  } catch {
    /* private mode */
  }
  marks.set({ w: new Set(), rs: new Set() });
  startOver(chosenProfile(status.get()?.profiles ?? [], id));
  if (id) void loadMarks();
});
// The profile picked was removed (on any device): ask again who's watching.
status.subscribe(() => {
  const profiles = status.get()?.profiles;
  const id = profileChoice.get();
  if (profiles && id && !profiles.some((p) => p.id === id)) profileChoice.set(null);
});

// The library for this device's profile as it is now: a grown-up's shows everything at once, a kid's nothing
// until their list comes. Again when the profile turns into a kids one or back, or its age limit changes (on any device).
let kidsShape: string | undefined;
const shapeOf = (me: Profile | null) => (me ? `${me.id}:${me.kids}:${me.maxAge}` : undefined);
function startOver(me: Profile | null): void {
  kidsShape = shapeOf(me);
  allowed.set(allowedAtFirst(me));
  library.set((s) => ({ ...s, items: shown() }));
  void loadAllowed();
  reloadLibrary();
}
status.subscribe(() => {
  const me = chosenProfile(status.get()?.profiles ?? [], profileChoice.get());
  if (!me || shapeOf(me) === kidsShape) return;
  if (kidsShape !== undefined) return startOver(me);
  // The first status: the loads under way are this profile's already.
  kidsShape = shapeOf(me);
  if (allowed.get() === undefined && !me.kids) {
    allowed.set(null);
    library.set((s) => ({ ...s, items: shown() }));
  }
});

/** This device's profile; null until one is picked (or while the list is loading). */
export function useProfile(): Profile | null {
  const st = useStore(status);
  const choice = useStore(profileChoice);
  return chosenProfile(st?.profiles ?? [], choice);
}

/** This device's profile when it is a kids one (kids mode), else null. */
export function useKids(): Profile | null {
  const me = useProfile();
  return me?.kids ? me : null;
}

/** A name tapped on a title's page: the library shows the titles of that actor or director. */
export const personRequest = createStore<string | null>(null);

/** The Remote's Keyboard button: type for Kodi even when its keyboard wasn't announced. */
export const typingForKodi = createStore(false);

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
