export interface PeopleTitlesState {
  /** the library version these titles are for */
  version: string;
  /** each person's titles, as library group keys ("movie:949") */
  keys: Map<string, Set<string>>;
  /** the last lookup failed: nothing is asked until retry() */
  error: string | null;
}

/**
 * The titles of the people in the library filter, fetched once per library version. An answer for an
 * older version is dropped (its titles may have changed since), and a failure isn't taken for "no
 * titles": the person is asked again after retry().
 */
export function peopleTitles(fetchTitles: (name: string) => Promise<string[]>) {
  let state: PeopleTitlesState = { version: '', keys: new Map(), error: null };
  const asked = new Set<string>();
  const listeners = new Set<() => void>();
  const set = (next: PeopleTitlesState) => {
    state = next;
    listeners.forEach((l) => l());
  };
  return {
    get: () => state,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    /** Fetch the titles of these people for this version of the library, unless held or on their way. */
    want(names: string[], version: string) {
      if (version !== state.version) {
        asked.clear();
        set({ version, keys: new Map(), error: null });
      }
      if (state.error) return;
      for (const name of names) {
        if (state.keys.has(name) || asked.has(name)) continue;
        asked.add(name);
        fetchTitles(name).then(
          (g) => {
            if (state.version === version) set({ ...state, keys: new Map(state.keys).set(name, new Set(g)) });
          },
          (e: Error) => {
            // A lookup for an older library: the newer one for this person may be on its way.
            if (state.version !== version) return;
            asked.delete(name);
            set({ ...state, error: e.message });
          },
        );
      }
    },
    /** After a failure: ask again on the next want(). */
    retry() {
      set({ ...state, error: null });
    },
  };
}
