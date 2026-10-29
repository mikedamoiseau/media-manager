import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { api } from '../api.ts';
import { useStore, library, prefs } from '../store.ts';
import { displayTitle, formatDay, formatSize, groupCards, setName } from '../search.ts';
import type { DuplicateFilm, Film, IncompleteSet, ShowToGet } from '../types.ts';
import { gapLabel } from '../series.ts';
import { IconBack } from './icons.tsx';
import { useOpenTitle, useOpenSet, useOpenFilm } from '../nav.ts';

/** A list opened from Settings: full page, back returns to Settings. */
function ReportPage({ title, summary, children }: { title: string; summary: ReactNode; children: ReactNode }) {
  const [, navigate] = useLocation();
  const back = () => {
    if ((history.state as { fromApp?: boolean } | null)?.fromApp) history.back();
    else navigate('/settings', { replace: true });
  };
  return (
    <div className="scroller">
      <header className="set-head">
        <button className="icon-btn" onClick={back} aria-label="Back to Settings">
          <IconBack />
        </button>
        <div className="set-head-text">
          <h1 className="set-title">{title}</h1>
          <p className="set-meta">{summary}</p>
        </div>
      </header>
      {children}
    </div>
  );
}

/** Films with more than one copy on the NAS, each copy with where it is and what it is. */
export function DuplicatesReport() {
  const [films, setFilms] = useState<DuplicateFilm[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { items } = useStore(library);
  const { titleLang } = useStore(prefs);
  const openTitle = useOpenTitle();

  useEffect(() => {
    api.get<{ films: DuplicateFilm[] }>('/api/reports/duplicates').then((r) => setFilms(r.films), (e: Error) => setError(e.message));
  }, []);

  const groups = useMemo(() => new Map(groupCards(items).map((g) => [g.key, g])), [items]);
  const rows = useMemo(
    () =>
      (films ?? [])
        .map((f) => {
          const g = groups.get(`movie:${f.tmdbId}`);
          return { f, title: g ? displayTitle(g.main, titleLang).main : f.copies[0]!.path, year: g?.main.y };
        })
        .sort((a, b) => a.title.localeCompare(b.title, 'fr')),
    [films, groups, titleLang],
  );
  // Copies are biggest first: keeping the biggest of each frees the least, so this is a floor.
  const extra = (films ?? []).reduce((sum, f) => sum + f.copies.slice(1).reduce((s, c) => s + (c.size ?? 0), 0), 0);

  return (
    <ReportPage
      title="Films with several copies"
      summary={
        error ?? (films === null ? 'Loading…' : films.length ? `${films.length} films. Keeping one copy of each frees at least ${formatSize(extra)}.` : 'Every film has a single copy.')
      }
    >
      <ul className="report-list">
        {rows.map(({ f, title, year }) => (
          <li key={f.tmdbId} className="report-item">
            <button className="report-title" onClick={() => openTitle(f.copies[0]!.id)}>
              {title}
              {year ? <span className="muted"> ({year})</span> : null}
            </button>
            <ul className="report-copies">
              {f.copies.map((c) => (
                <li key={c.id}>
                  <span className="report-file">{c.path}</span>
                  <span className="report-tags">
                    {[formatSize(c.size), ...c.quality, c.watched ? 'watched' : '', c.hidden ? 'hidden from the library' : ''].filter(Boolean).join(', ')}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </ReportPage>
  );
}

type SetsReply = { sets: IncompleteSet[]; total: number; checked: number; running: boolean; tmdb: boolean };

/** Sets with at least one released film missing from the NAS. */
export function SetsReport() {
  const [data, setData] = useState<SetsReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { titleLang } = useStore(prefs);
  const openSet = useOpenSet();

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The first time, the server fetches each set's film list from TMDB: ask again until it is done.
    const load = () =>
      api.get<SetsReply>('/api/reports/sets').then(
        (r) => {
          if (!alive) return;
          setData(r);
          if (r.running) timer = setTimeout(load, 1500);
        },
        (e: Error) => alive && setError(e.message),
      );
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  const sets = useMemo(() => [...(data?.sets ?? [])].sort((a, b) => setName(a.key).localeCompare(setName(b.key), 'fr')), [data]);
  const unchecked = data ? data.total - data.checked : 0;
  let summary = error ?? 'Loading…';
  if (data) {
    if (data.running) summary = `Checking sets with TMDB: ${data.checked} of ${data.total}…`;
    else if (!data.tmdb && unchecked) summary = 'Add a TMDB key in Settings to check which films each set has.';
    else summary = `${sets.length} of ${data.total} sets miss a film.${unchecked ? ` ${unchecked} couldn't be checked with TMDB.` : ''}`;
  }

  return (
    <ReportPage title="Sets with missing films" summary={summary}>
      <ul className="report-list">
        {sets.map((s) => (
          <li key={s.key} className="report-item">
            <button className="report-title" onClick={() => openSet(s.key)}>
              {setName(s.key)}
              <span className="muted">
                {' '}
                {s.onNas} of {s.released} on the NAS
              </span>
            </button>
            <p className="report-missing">
              Missing:{' '}
              {s.missing.map((p) => `${displayTitle(p, titleLang).main}${p.date ? ` (${p.date.slice(0, 4)})` : ''}`).join(', ')}
            </p>
          </li>
        ))}
      </ul>
    </ReportPage>
  );
}

type EpisodesReply = { shows: ShowToGet[]; total: number; checked: number; running: boolean; tmdb: boolean };

/** Followed series missing aired episodes, the latest news first. */
export function EpisodesReport() {
  const [data, setData] = useState<EpisodesReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { items } = useStore(library);
  const { titleLang } = useStore(prefs);
  const openTitle = useOpenTitle();

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The first time, the server fetches each series' seasons from TMDB: ask again until it is done.
    const load = () =>
      api.get<EpisodesReply>('/api/reports/episodes').then(
        (r) => {
          if (!alive) return;
          setData(r);
          if (r.running) timer = setTimeout(load, 1500);
        },
        (e: Error) => alive && setError(e.message),
      );
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  const cards = useMemo(() => new Map(items.map((c) => [c.id, c])), [items]);
  const unchecked = data ? data.total - data.checked : 0;
  let summary = error ?? 'Loading…';
  if (data) {
    const n = data.shows.length;
    if (data.running) summary = `Checking series with TMDB: ${data.checked} of ${data.total}…`;
    else if (!data.tmdb && unchecked) summary = 'Add a TMDB key in Settings to check your series.';
    else if (!data.total) summary = 'You follow no series yet: follow one from its page.';
    else {
      summary = n ? `${n} of the ${data.total} series you follow ${n === 1 ? 'misses' : 'miss'} episodes.` : `The ${data.total} series you follow are up to date.`;
      if (unchecked) summary += ` ${unchecked} couldn't be checked with TMDB.`;
    }
  }

  return (
    <ReportPage title="Episodes to get" summary={summary}>
      <ul className="report-list">
        {(data?.shows ?? []).map((s) => {
          const card = cards.get(s.itemId);
          return (
            <li key={s.tmdbId} className="report-item">
              <button className="report-title" onClick={() => openTitle(s.itemId)}>
                {card ? displayTitle(card, titleLang).main : 'Series'}
              </button>
              {s.status.missing.map((g) => (
                <p key={g.season} className="report-missing">
                  {gapLabel(g)}
                </p>
              ))}
              {s.status.latest && <p className="report-missing">Latest aired {formatDay(s.status.latest)}</p>}
            </li>
          );
        })}
      </ul>
    </ReportPage>
  );
}

/** Films you marked "Want it" that aren't on the NAS yet. */
export function WantedReport() {
  const [films, setFilms] = useState<Film[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { titleLang } = useStore(prefs);
  const openFilm = useOpenFilm();

  useEffect(() => {
    api.get<{ films: Film[] }>('/api/reports/wanted').then((r) => setFilms(r.films), (e: Error) => setError(e.message));
  }, []);

  const today = new Date().toLocaleDateString('sv');
  return (
    <ReportPage
      title="Films to get"
      summary={
        error ??
        (films === null
          ? 'Loading…'
          : films.length
            ? `${films.length} ${films.length === 1 ? 'film' : 'films'}. Each one leaves the list once a copy is on the NAS.`
            : 'Nothing yet. Tap “Want it” on a film that isn’t on the NAS to add it here.')
      }
    >
      <ul className="report-list">
        {(films ?? []).map((f) => (
          <li key={f.id} className="report-item">
            <button className="report-title" onClick={() => openFilm(f.id)}>
              {displayTitle(f, titleLang).main}
              {f.date ? <span className="muted"> ({f.date.slice(0, 4)})</span> : null}
            </button>
            {f.date && f.date > today && <p className="report-missing">Out on {formatDay(f.date)}</p>}
          </li>
        ))}
      </ul>
    </ReportPage>
  );
}
