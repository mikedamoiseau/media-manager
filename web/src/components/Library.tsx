import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useLocation, useRoute } from 'wouter';
import { useStore, library, prefs, toast, loadLibrary, personRequest, profileChoice, useKids } from '../store.ts';
import { ProfileBadge } from './WhosWatching.tsx';
import {
  applyFilters, allGenres, groupCards, groupSets, isSet, setName, splitSet, displayTitle, formatDay, CATEGORIES, DECADES, DEFAULT_FILTERS,
  type Filters, type SortKey, type StatusKey,
} from '../search.ts';
import type { Entry, Film, Group, Person, SetGroup, SetPart, Suggestion, TitleLang, Watching } from '../types.ts';
import { api } from '../api.ts';
import { forProfile } from '../profiles.ts';
import { peopleTitles } from '../peopleTitles.ts';
import { Poster } from './Poster.tsx';
import { Sheet } from './Sheet.tsx';
import { IconSearch, IconClose, IconFilter, IconCheck, IconSets, IconBack } from './icons.tsx';
import { useOpenTitle, useOpenSet, useOpenFilm } from '../nav.ts';
import { PullToRefresh, serverRefresh } from './PullToRefresh.tsx';

function loadFilters(): Filters {
  try {
    return { ...DEFAULT_FILTERS, ...JSON.parse(sessionStorage.getItem('mm.filters') ?? '{}') };
  } catch {
    return DEFAULT_FILTERS;
  }
}

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'added', label: 'Recently added' },
  { key: 'title', label: 'Title' },
  { key: 'year', label: 'Newest first' },
  { key: 'rating', label: 'Best rated' },
];

const STATUSES: Array<{ key: StatusKey; label: string }> = [
  { key: 'all', label: 'On the NAS' },
  { key: 'unwatched', label: 'Not watched' },
  { key: 'progress', label: 'In progress' },
  { key: 'review', label: 'Needs a match' },
  { key: 'missing', label: 'Only in the sheet' },
  { key: 'hidden', label: 'Hidden' },
];
// A kid's titles are all on the NAS, matched or not, never hidden: the other choices would show nothing.
const KIDS_STATUSES = new Set<StatusKey>(['all', 'unwatched', 'progress']);

const QUALITIES = ['4K', 'HDR', '1080p', 'MULTI', 'VF', 'VOSTFR'];

/** wouter only applies decodeURI, which leaves "%3A" (Mission: Impossible) and "%2F" encoded. */
function decodeKey(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function yearSpan(list: Array<number | null>): string {
  const years = list.filter((y): y is number => !!y);
  if (!years.length) return '';
  const from = Math.min(...years);
  const to = Math.max(...years);
  return from === to ? String(from) : `${from}–${to}`;
}

export function Library({ active }: { active: boolean }) {
  const { items, loading, error, version } = useStore(library);
  // Someone else watching on this device: their rows.
  const who = useStore(profileChoice);
  const p = useStore(prefs);
  // Kids mode: nothing that leads past the kid's titles (films elsewhere or at the cinema, people, a set's other films).
  const kid = useKids();
  const { titleLang, showContinue, showSuggested } = p;
  const setsOn = p.groupSets && !kid;
  const showElsewhere = p.showElsewhere && !kid;
  const showCinema = p.showCinema && !kid;
  const [chosen, setFilters] = useState<Filters>(loadFilters);
  // A grown-up's people and status filters wait for them, out of kids mode.
  const filters = useMemo(
    () => (kid ? { ...chosen, people: [], status: KIDS_STATUSES.has(chosen.status) ? chosen.status : 'all' } : chosen),
    [kid, chosen],
  );
  const [, setParams] = useRoute('/set/:key');
  const openSet = setParams ? decodeKey(setParams.key) : null;
  const [showFilters, setShowFilters] = useState(false);
  const deferred = useDeferredValue(filters);
  const scroller = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // The titles of each person in the filter (group keys), from the server.
  const people = useMemo(() => peopleTitles((name) => api.get<{ g: string[] }>(`/api/person?name=${encodeURIComponent(name)}`).then((r) => r.g)), []);
  const { keys: peopleKeys, error: peopleError } = useSyncExternalStore(people.subscribe, people.get);
  const person = useStore(personRequest);

  useEffect(() => {
    sessionStorage.setItem('mm.filters', JSON.stringify(chosen));
  }, [chosen]);

  useEffect(() => people.want(filters.people, version ?? ''), [people, filters.people, version, peopleError]);
  // A name tapped on a title's page: only their titles, whatever was filtered before.
  useEffect(() => {
    if (!person) return;
    setFilters((f) => ({ ...DEFAULT_FILTERS, sort: f.sort, people: [person] }));
    scroller.current?.scrollTo({ top: 0 });
    personRequest.set(null);
  }, [person]);

  const groups = useMemo(() => groupCards(items), [items]);
  const genres = useMemo(() => allGenres(groups), [groups]);
  const results = useMemo(() => applyFilters(groups, deferred, titleLang, peopleKeys), [groups, deferred, titleLang, peopleKeys]);
  const entries = useMemo(() => (setsOn ? groupSets(results, deferred) : results), [setsOn, results, deferred]);
  const [suggested, setSuggested] = useState<Suggestion[]>([]);
  const [watching, setWatching] = useState<Watching[]>([]);
  // These rows are the profile's: an answer that comes back after a switch is dropped.
  const loadWatching = () =>
    api.get<{ items: Watching[] }>('/api/continue').then(
      forProfile(profileChoice.get, (r) => setWatching(r.items)),
      () => setWatching([]),
    );
  const loadSuggestions = () =>
    api.get<{ suggestions: Suggestion[] }>('/api/suggestions').then(
      forProfile(profileChoice.get, (r) => setSuggested(r.suggestions)),
      () => setSuggested([]),
    );
  const [elsewhere, setElsewhere] = useState<Array<Film & { because: number }>>([]);
  const [cinema, setCinema] = useState<Array<Film & { soon: boolean }>>([]);
  const loadElsewhere = () =>
    api.get<{ films: typeof elsewhere }>('/api/elsewhere').then(
      forProfile(profileChoice.get, (r) => setElsewhere(r.films)),
      () => setElsewhere([]),
    );
  const loadCinema = () =>
    api.get<{ films: typeof cinema }>('/api/cinema').then(
      (r) => setCinema(r.films),
      () => setCinema([]),
    );
  useEffect(() => {
    // Refetched on coming back to the library (after opening a title, playing, a trailer) and when
    // Kodi reports something newly watched (the library changes).
    if (!active) return;
    if (showContinue) void loadWatching();
    if (showSuggested) void loadSuggestions();
    if (showElsewhere) void loadElsewhere();
    if (showCinema) void loadCinema();
  }, [version, who, active, showContinue, showSuggested, showElsewhere, showCinema]); // eslint-disable-line react-hooks/exhaustive-deps
  // Pull to refresh: new files on the NAS, what Kodi says was watched, then everything shown here.
  const refreshAll = async () => {
    await serverRefresh(() => api.post('/api/refresh'));
    await Promise.all([
      loadLibrary(),
      showContinue && loadWatching(),
      showSuggested && loadSuggestions(),
      showElsewhere && loadElsewhere(),
      showCinema && loadCinema(),
    ]);
  };
  const dismiss = (id: number) => {
    setWatching((list) => list.filter((w) => w.id !== id));
    api.post(`/api/continue/${id}/dismiss`).catch((e: Error) => {
      toast(e.message, 'error');
      void loadWatching();
    });
  };
  const groupOf = useMemo(() => {
    const m = new Map<number, Group>();
    for (const g of groups) for (const c of g.items) m.set(c.id, g);
    return m;
  }, [groups]);
  const inCategory = (g: Group) => deferred.cat === 'all' || g.main.c === deferred.cat;
  const filmsInView = deferred.cat === 'all' || deferred.cat === 'movies';
  const started = useMemo(
    () =>
      watching.flatMap((w) => {
        const g = groupOf.get(w.id);
        return g && inCategory(g) ? [{ w, g }] : [];
      }),
    [watching, groupOf, deferred.cat], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const shelf = useMemo(
    () =>
      suggested.flatMap((s) => {
        const g = groupOf.get(s.id);
        const seed = groupOf.get(s.because);
        return g && seed && inCategory(g) ? [{ s, g, seed }] : [];
      }),
    [suggested, groupOf, deferred.cat], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const catCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    const base = applyFilters(groups, { ...deferred, cat: 'all' }, titleLang, peopleKeys);
    for (const g of base) counts[g.main.c] = (counts[g.main.c] ?? 0) + 1;
    counts.all = base.length;
    return counts;
  }, [groups, deferred, titleLang, peopleKeys]);

  const set = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    scroller.current?.scrollTo({ top: 0 });
  };
  const activeFilterCount =
    filters.genres.length + filters.quality.length + filters.people.length + (filters.decade ? 1 : 0) + (filters.status !== 'all' ? 1 : 0);
  const peopleLoading = filters.people.some((n) => !peopleKeys.has(n));
  const togglePerson = (name: string) =>
    set({ people: filters.people.includes(name) ? filters.people.filter((x) => x !== name) : [...filters.people, name] });

  // "/" focuses search on desktop.
  useEffect(() => {
    if (!active || openSet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, openSet]);

  return (
    <>
      <div className="scroller" ref={scroller}>
        <header className="lib-head">
          <div className="lib-row">
          <div className="search">
            <IconSearch size={20} />
            <input
              ref={searchRef}
              type="search"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              spellCheck={false}
              placeholder="Title, actor, director, year…"
              value={filters.q}
              onChange={(e) => set({ q: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              aria-label="Search the library"
            />
            {filters.q && (
              <button className="icon-btn" onClick={() => set({ q: '' })} aria-label="Clear search">
                <IconClose size={18} />
              </button>
            )}
            <button
              className={`icon-btn filter-btn${activeFilterCount ? ' is-on' : ''}`}
              onClick={() => setShowFilters(true)}
              aria-label={`Filters${activeFilterCount ? ` (${activeFilterCount} on)` : ''}`}
            >
              <IconFilter />
              {activeFilterCount > 0 && <b>{activeFilterCount}</b>}
            </button>
          </div>
          <ProfileBadge />
          </div>
          {filters.people.length > 0 && (
            <div className="chips" aria-label="Actors and directors">
              {filters.people.map((n) => (
                <button key={n} className="chip person-chip" aria-pressed="true" onClick={() => togglePerson(n)} aria-label={`Stop showing only titles with ${n}`}>
                  {n}
                  <IconClose size={15} />
                </button>
              ))}
            </div>
          )}
          <div className="chips" role="tablist" aria-label="Category">
            {CATEGORIES.filter((c) => c.key === 'all' || catCounts[c.key]).map((c) => (
              <button key={c.key} role="tab" aria-selected={filters.cat === c.key} className="chip" onClick={() => set({ cat: c.key })}>
                {c.label}
                <span className="chip-count">{catCounts[c.key] ?? 0}</span>
              </button>
            ))}
          </div>
        </header>

        {showContinue && !filters.q && activeFilterCount === 0 && started.length > 0 && <ContinueShelf entries={started} lang={titleLang} onDismiss={dismiss} />}
      {showSuggested && !filters.q && activeFilterCount === 0 && shelf.length >= 3 && <Shelf entries={shelf} lang={titleLang} />}
      {/* Films not on the NAS: only with films in view. */}
      {showElsewhere && !filters.q && activeFilterCount === 0 && filmsInView && elsewhere.length >= 3 && (
        <FilmShelf
          id="elsewhere-title"
          title="Not on the NAS"
          lang={titleLang}
          notOnNas
          films={elsewhere.map((f) => {
            const seed = groupOf.get(f.because);
            const like = seed ? displayTitle(seed.main, titleLang).main : null;
            return { f, why: like ? `Like ${like}` : '' };
          })}
        />
      )}
      {showCinema && !filters.q && activeFilterCount === 0 && filmsInView && cinema.length > 0 && (
        <FilmShelf
          id="cinema-title"
          title="At the cinema"
          lang={titleLang}
          films={cinema.map((f) => ({ f, why: f.soon && f.date ? `Out ${formatDay(f.date)}` : 'In cinemas' }))}
        />
      )}

      {error && !items.length ? (
          <div className="empty">
            <h2>Can't load the library</h2>
            <p>{error}</p>
          </div>
        ) : loading && !items.length ? (
          <div className="empty">
            <p>Loading your library…</p>
          </div>
        ) : peopleLoading ? (
          <div className="empty">
            {peopleError ? (
              <>
                <h2>Can't find their titles</h2>
                <p>{peopleError}</p>
                <button className="btn" onClick={() => people.retry()}>
                  Try again
                </button>
              </>
            ) : (
              <p>Finding their titles…</p>
            )}
          </div>
        ) : results.length === 0 ? (
          <div className="empty">
            <h2>Nothing matches</h2>
            <p>{filters.q ? `No title, actor or file name contains “${filters.q}”.` : 'Loosen the filters to see more.'}</p>
            <button className="btn" onClick={() => set({ ...DEFAULT_FILTERS, sort: filters.sort })}>
              Clear search and filters
            </button>
          </div>
        ) : (
          <>
            <div className="result-line">
              <span>
                {results.length.toLocaleString()} {results.length === 1 ? 'title' : 'titles'}
              </span>
              {!kid && (
                <button
                  className="chip sets-toggle"
                  aria-pressed={setsOn}
                  onClick={() => {
                    prefs.set({ ...p, groupSets: !setsOn });
                    scroller.current?.scrollTo({ top: 0 });
                  }}
                >
                  <IconSets size={16} /> Group sets
                </button>
              )}
              <label className="sort">
                <span className="sr-only">Sort by</span>
                <select value={filters.sort} onChange={(e) => set({ sort: e.target.value as SortKey })}>
                  {SORTS.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <Grid entries={entries} scroller={scroller} />
          </>
        )}

        {showFilters && (
          <Sheet title="Filters" onClose={() => setShowFilters(false)}>
            <h3 className="field-label">Show</h3>
            <div className="chips wrap">
              {STATUSES.filter((s) => !kid || KIDS_STATUSES.has(s.key)).map((s) => (
                <button key={s.key} className="chip" aria-pressed={filters.status === s.key} onClick={() => set({ status: s.key })}>
                  {s.label}
                </button>
              ))}
            </div>
            <h3 className="field-label">Decade</h3>
            <div className="chips wrap">
              {DECADES.map((d) => (
                <button key={d.key} className="chip" aria-pressed={filters.decade === d.key} onClick={() => set({ decade: filters.decade === d.key ? null : d.key })}>
                  {d.label}
                </button>
              ))}
            </div>
            <h3 className="field-label">Quality and language</h3>
            <div className="chips wrap">
              {QUALITIES.map((q) => (
                <button
                  key={q}
                  className="chip"
                  aria-pressed={filters.quality.includes(q)}
                  onClick={() => set({ quality: filters.quality.includes(q) ? filters.quality.filter((x) => x !== q) : [...filters.quality, q] })}
                >
                  {q}
                </button>
              ))}
            </div>
            <h3 className="field-label">Genres</h3>
            <div className="chips wrap">
              {genres.map((g) => (
                <button
                  key={g}
                  className="chip"
                  aria-pressed={filters.genres.includes(g)}
                  onClick={() => set({ genres: filters.genres.includes(g) ? filters.genres.filter((x) => x !== g) : [...filters.genres, g] })}
                >
                  {g}
                </button>
              ))}
            </div>
            {!kid && <PeoplePicker chosen={filters.people} onToggle={togglePerson} version={version} />}
            <div className="sheet-actions">
              <button className="btn ghost" onClick={() => set({ genres: [], decade: null, quality: [], status: 'all', people: [] })}>
                Reset filters
              </button>
              <button className="btn primary" onClick={() => setShowFilters(false)}>
                Show {results.length.toLocaleString()} titles
              </button>
            </div>
          </Sheet>
        )}
      </div>
      <PullToRefresh scroller={scroller} onRefresh={refreshAll} />
      {/* A sibling of the library scroller, so the grid underneath keeps its scroll position. */}
      {openSet && <SetView key={openSet} name={openSet} results={results} groups={groups} />}
    </>
  );
}

/** The Filters' actors and directors: those with the most titles, or those whose name you type. */
function PeoplePicker({ chosen, onToggle, version }: { chosen: string[]; onToggle: (name: string) => void; version: string | null }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Again when the library changes: new people, new counts.
  useEffect(() => {
    let stale = false;
    const t = setTimeout(
      () =>
        api.get<{ people: Person[] }>(`/api/people?q=${encodeURIComponent(q)}`).then(
          (r) => {
            if (stale) return;
            setFound(r.people);
            setError(null);
          },
          (e: Error) => {
            if (stale) return;
            setFound(null);
            setError(e.message);
          },
        ),
      q ? 150 : 0,
    );
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [q, version, attempt]);
  const others = (found ?? []).filter((p) => !chosen.includes(p.name));

  return (
    <>
      <h3 className="field-label">Actors and directors</h3>
      <div className="search people-search">
        <IconSearch size={18} />
        <input
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          placeholder="Find an actor or director"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Find an actor or director"
        />
      </div>
      <div className="chips wrap">
        {chosen.map((n) => (
          <button key={n} className="chip" aria-pressed="true" onClick={() => onToggle(n)}>
            {n}
          </button>
        ))}
        {others.map((p) => (
          <button key={p.name} className="chip" aria-pressed="false" onClick={() => onToggle(p.name)}>
            {p.name}
            <span className="chip-count">{p.n}</span>
          </button>
        ))}
      </div>
      {error ? (
        <p className="muted small">
          Can't load actors and directors: {error}{' '}
          <button className="link-btn" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </p>
      ) : (
        found && !found.length && q && <p className="muted small">No one called “{q}” in the library.</p>
      )}
    </>
  );
}

function SetView({ name, results, groups }: { name: string; results: Group[]; groups: Group[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [, navigate] = useLocation();
  const { titleLang } = useStore(prefs);
  const openTitle = useOpenTitle();
  const [parts, setParts] = useState<SetPart[] | null>(null);
  const [partsError, setPartsError] = useState(false);
  const title = setName(name);
  const close = () => {
    if ((history.state as { fromApp?: boolean } | null)?.fromApp) history.back();
    else navigate('/', { replace: true });
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    scroller.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[aria-modal="true"]')) closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    api.get<{ parts: SetPart[] }>(`/api/set?name=${encodeURIComponent(name)}`).then(
      (r) => setParts(r.parts),
      () => setPartsError(true),
    );
  }, [name]);

  const { available, missing, onNas, released } = useMemo(() => splitSet(name, parts ?? [], results, groups), [name, parts, results, groups]);
  // The whole set's range when TMDB knows it, not just the films on the NAS.
  const span = yearSpan(parts?.length ? parts.map((p) => (p.date ? Number(p.date.slice(0, 4)) : null)) : available.map((g) => g.main.y));
  return (
    <div className="scroller set-view" ref={scroller} tabIndex={-1} aria-label={title}>
      <header className="set-head">
        <button className="icon-btn" onClick={close} aria-label="Back to the library">
          <IconBack />
        </button>
        <div className="set-head-text">
          <h1 className="set-title">{title}</h1>
          <p className="set-meta">
            {released > 0 ? `${onNas} of ${released} films on the NAS` : `${available.length} ${available.length === 1 ? 'film' : 'films'}`}
            {span && `, ${span}`}
          </p>
        </div>
      </header>
      {missing.length > 0 && <h2 className="set-section">On the NAS</h2>}
      {available.length ? (
        <div className="set-grid">
          {available.map((g) => (
            <TitleTile key={g.key} g={g} lang={titleLang} onOpen={openTitle} />
          ))}
        </div>
      ) : (
        <p className="set-note">None of these films is on the NAS.</p>
      )}
      {!parts && !partsError && <p className="set-note">Looking up the rest of the set…</p>}
      {partsError && <p className="set-note">Couldn't get the full set from TMDB.</p>}
      {missing.length > 0 && (
        <>
          <h2 className="set-section">
            Missing <span className="chip-count">{missing.length}</span>
          </h2>
          <div className="set-grid">
            {missing.map(({ part, group }) =>
              group ? <TitleTile key={part.id} g={group} lang={titleLang} onOpen={openTitle} /> : <MissingTile key={part.id} part={part} lang={titleLang} />,
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** "S1 E5", or what there is of it. */
function episodeLabel(e: NonNullable<Watching['episode']>): string {
  if (e.season != null && e.episode != null) return `S${e.season} E${e.episode}`;
  return e.episode != null ? `E${e.episode}` : (e.title ?? 'Next episode');
}

/**
 * Films started and not finished, with how far you got and where; series with the episode to go on
 * with and how much of it you've seen. × removes one from the row.
 */
function ContinueShelf({ entries, lang, onDismiss }: { entries: Array<{ w: Watching; g: Group }>; lang: TitleLang; onDismiss: (id: number) => void }) {
  const openTitle = useOpenTitle();
  return (
    <section className="shelf" aria-labelledby="continue-title">
      <h2 className="shelf-title" id="continue-title">
        Continue watching
      </h2>
      <div className="shelf-row">
        {entries.map(({ w, g }) => {
          const t = displayTitle(g.main, lang);
          const pct = Math.round(w.fraction * 100);
          // A series' bar is the share of its episodes watched.
          const bar = w.seen ? Math.round((w.seen.watched / Math.max(1, w.seen.total)) * 100) : pct;
          const why = !w.episode
            ? `${pct}% ${w.where === 'tv' ? 'on the TV' : 'in VLC'}`
            : w.fraction > 0
              ? `${episodeLabel(w.episode)} at ${pct}%`
              : `Next: ${episodeLabel(w.episode)}`;
          return (
            <div key={g.key} className="shelf-item">
              <button className="tile shelf-tile" onClick={() => openTitle(w.id)}>
                <Poster src={g.main.p} title={t.main} year={g.main.y} />
                <span className="tile-bar" aria-hidden="true">
                  <span>
                    <i style={{ width: `${bar}%` }} />
                  </span>
                </span>
                <span className="tile-title">{t.main}</span>
                <span className="tile-meta">
                  <span className="shelf-why">{why}</span>
                </span>
              </button>
              <button className="tile-remove" onClick={() => onDismiss(w.id)} aria-label={`Remove ${t.main} from Continue watching`}>
                <IconClose size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** A row of titles to watch next, each with why it is there. */
function Shelf({ entries, lang }: { entries: Array<{ s: Suggestion; g: Group; seed: Group }>; lang: TitleLang }) {
  const openTitle = useOpenTitle();
  return (
    <section className="shelf" aria-labelledby="shelf-title">
      <h2 className="shelf-title" id="shelf-title">
        Suggested for you
      </h2>
      <div className="shelf-row">
        {entries.map(({ s, g, seed }) => {
          const t = displayTitle(g.main, lang);
          const seedTitle = displayTitle(seed.main, lang).main;
          // "Dragons, like Dragons": the year tells the 2010 film from the 2025 one you watched.
          const like = seedTitle === t.main && seed.main.y ? `${seedTitle} (${seed.main.y})` : seedTitle;
          const why = s.kind === 'next' && g.main.k ? `Next in ${setName(g.main.k)}` : `Like ${like}`;
          return (
            <button key={g.key} className="tile shelf-tile" onClick={() => openTitle(g.main.id)}>
              <Poster src={g.main.p} title={t.main} year={g.main.y} />
              <span className="tile-title">{t.main}</span>
              <span className="tile-meta">
                <span className="shelf-why">{why}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** A row of films that aren't on the NAS, each opening its page. notOnNas: faded and tagged, as films to get rather than to play. */
function FilmShelf({ id, title, films, lang, notOnNas = false }: { id: string; title: string; films: Array<{ f: Film; why: string }>; lang: TitleLang; notOnNas?: boolean }) {
  const openFilm = useOpenFilm();
  return (
    <section className="shelf" aria-labelledby={id}>
      <h2 className="shelf-title" id={id}>
        {title}
      </h2>
      <div className="shelf-row">
        {films.map(({ f, why }) => {
          const t = displayTitle(f, lang);
          return (
            <button key={f.id} className={`tile shelf-tile${notOnNas ? ' is-elsewhere' : ''}`} onClick={() => openFilm(f.id)}>
              <Poster src={f.poster} title={t.main} year={f.date ? Number(f.date.slice(0, 4)) : null} />
              {notOnNas && <span className="tile-flag is-plain">Not on NAS</span>}
              <span className="tile-title">{t.main}</span>
              <span className="tile-meta">
                <span className="shelf-why">{why}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** A film of the set that is not in the library at all: shown greyed, nothing to open. */
export function MissingTile({ part, lang }: { part: SetPart; lang: TitleLang }) {
  const t = displayTitle(part, lang);
  const year = part.date ? Number(part.date.slice(0, 4)) : null;
  const out = part.date !== null && part.date <= new Date().toISOString().slice(0, 10);
  return (
    <div className="tile is-missing">
      <Poster src={part.poster} title={t.main} year={year} />
      <span className="tile-title">{t.main}</span>
      <span className="tile-meta">{out ? year : 'Not out yet'}</span>
    </div>
  );
}

function Grid({ entries, scroller }: { entries: Entry[]; scroller: React.RefObject<HTMLDivElement | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [offset, setOffset] = useState(0);
  const { titleLang } = useStore(prefs);
  const openTitle = useOpenTitle();
  const openSet = useOpenSet();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
      setOffset(el.offsetTop);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Content above the grid can change without resizing it (the suggestions row arriving).
  useLayoutEffect(() => {
    const top = ref.current?.offsetTop;
    if (top !== undefined && top !== offset) setOffset(top);
  });

  const gap = width < 600 ? 10 : 16;
  const minCol = width < 600 ? 100 : 152;
  const cols = Math.max(3, Math.floor((width + gap) / (minCol + gap)));
  const colW = width ? (width - gap * (cols - 1)) / cols : 0;
  // Poster (2:3) + caption: 7px gap, two 16px title lines, an 18px meta line.
  const rowH = Math.round(colW * 1.5 + 60 + gap);
  const rows = Math.ceil(entries.length / cols);

  const virt = useVirtualizer({
    count: rows,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowH,
    overscan: 3,
    scrollMargin: offset,
  });
  useEffect(() => virt.measure(), [rowH, virt]);

  return (
    <div ref={ref} className="grid" style={{ height: rows * rowH }}>
      {width > 0 &&
        virt.getVirtualItems().map((row) => (
          <div
            key={row.key}
            className="grid-row"
            style={{ transform: `translateY(${row.start - offset}px)`, gridTemplateColumns: `repeat(${cols}, 1fr)`, gap, height: rowH - gap }}
          >
            {entries.slice(row.index * cols, row.index * cols + cols).map((g) => {
              if (isSet(g)) return <SetTile key={`set:${g.key}`} set={g} onOpen={() => openSet(g.key)} />;
              return <TitleTile key={g.key} g={g} lang={titleLang} onOpen={openTitle} />;
            })}
          </div>
        ))}
    </div>
  );
}

export function TitleTile({ g, lang, onOpen, current }: { g: Group; lang: TitleLang; onOpen: (id: number) => void; current?: boolean }) {
  const c = g.main;
  const t = displayTitle(c, lang);
  const present = g.items.some((i) => i.pr);
  const needsMatch = present && g.items.some((i) => i.pr && (i.m === 'unmatched' || i.m === 'pending'));
  return (
    <button
      className={`tile${present ? '' : ' is-missing'}${current ? ' is-current' : ''}`}
      aria-current={current || undefined}
      onClick={() => !current && onOpen(c.id)}
    >
      <Poster src={c.p} title={t.main} year={c.y} />
      {g.items.some((i) => i.w) && (
        <span className="tile-watched" aria-label="Watched">
          <IconCheck size={13} strokeWidth={3} />
        </span>
      )}
      {needsMatch && <span className="tile-flag">Needs a match</span>}
      {g.items.some((i) => i.rs) && <span className="tile-progress" aria-label="In progress" />}
      <span className="tile-title">{t.main}</span>
      <span className="tile-meta">
        {c.y ?? ''}
        {g.items.length > 1 && <span className="tile-copies">{g.items.length} copies</span>}
        {c.q.includes('4K') && <span className="tile-q">4K</span>}
      </span>
    </button>
  );
}

/** Box-set tile: the first film's poster with sleeves peeking above it. */
function SetTile({ set, onOpen }: { set: SetGroup; onOpen: () => void }) {
  const first = set.members[0]!.main;
  const present = set.members.some((g) => g.items.some((i) => i.pr));
  const n = set.members.length;
  return (
    <button className={`tile is-set${present ? '' : ' is-missing'}`} onClick={onOpen} aria-label={`${set.name}, set of ${n} films`}>
      <Poster src={first.p} title={set.name} year={first.y} />
      {set.members.every((g) => g.items.some((i) => i.w)) && (
        <span className="tile-watched" aria-label="All watched">
          <IconCheck size={13} strokeWidth={3} />
        </span>
      )}
      <span className="tile-title">{set.name}</span>
      {/* The year range would not fit next to the count on a phone; the set page shows it. */}
      <span className="tile-meta">
        <span className="tile-copies">{n} films</span>
      </span>
    </button>
  );
}
