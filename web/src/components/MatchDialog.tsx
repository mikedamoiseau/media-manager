import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { toast, useStore, status } from '../store.ts';
import type { Candidate, Detail } from '../types.ts';
import { Sheet } from './Sheet.tsx';
import { Poster } from './Poster.tsx';
import { IconSearch } from './icons.tsx';

export function guessQuery(d: Pick<Detail, 'parsed' | 'sheet' | 'en'>): string {
  return d.sheet?.en ?? d.parsed.title ?? d.en;
}

/** Pick the right TMDB title for a file: suggestions first, then free search. */
export function MatchDialog({ item, onClose, onDone }: { item: Detail; onClose: () => void; onDone: (d: Detail) => void }) {
  const st = useStore(status);
  const [q, setQ] = useState(guessQuery(item));
  const [year, setYear] = useState<string>(String(item.sheet?.year ?? item.parsed.year ?? ''));
  const [results, setResults] = useState<Candidate[] | null>(item.candidates.length ? item.candidates : null);
  const [busy, setBusy] = useState(false);
  const fileName = item.path.slice(item.path.lastIndexOf('/') + 1);

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      const r = await api.get<{ results: Candidate[] }>(`/api/search?q=${encodeURIComponent(q)}${year ? `&year=${year}` : ''}`);
      setResults(r.results);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!results && st?.tmdbConfigured) void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = async (body: Record<string, unknown>, msg: string) => {
    setBusy(true);
    try {
      const r = await api.post<Detail>(`/api/items/${item.id}/match`, body);
      toast(msg);
      onDone(r);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <Sheet title="Find the right title" onClose={onClose} wide>
      <p className="file-name muted">{fileName}</p>
      {!st?.tmdbConfigured ? (
        <p className="callout">Searching needs a TMDB key. Add it in Settings, it's free.</p>
      ) : (
        <form
          className="match-search"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <div className="search">
            <IconSearch size={20} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title" aria-label="Title to search" enterKeyHint="search" />
          </div>
          <input className="year-input" value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="Year" inputMode="numeric" aria-label="Year" />
          <button className="btn primary" disabled={busy}>
            Search
          </button>
        </form>
      )}

      {results && results.length === 0 && <p className="muted">No results. Try the original title, or drop the year.</p>}
      {results && results.length > 0 && (
        <ul className="candidates">
          {results.map((c) => (
            <li key={`${c.type}:${c.id}`}>
              <button
                className="candidate"
                disabled={busy}
                onClick={() => void choose({ type: c.type, tmdbId: c.id }, `Matched to ${c.title}`)}
              >
                <Poster src={c.poster ? `/api/img?w=185&u=${encodeURIComponent(c.poster)}` : null} title={c.title} year={c.year} />
                <span className="candidate-text">
                  <strong>{c.title}</strong>
                  {c.originalTitle !== c.title && <span>{c.originalTitle}</span>}
                  <span className="muted">
                    {c.year ?? 'Year unknown'}, {c.type === 'tv' ? 'series' : 'film'}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="sheet-actions">
        {item.m !== 'none' && (
          <button className="btn ghost" disabled={busy} onClick={() => void choose({ none: true }, 'Kept as a plain video')}>
            It's not a film or series
          </button>
        )}
        {(item.m === 'none' || item.m === 'manual') && (
          <button className="btn ghost" disabled={busy} onClick={() => void choose({ reset: true }, 'Matching it again automatically')}>
            Match automatically
          </button>
        )}
      </div>
    </Sheet>
  );
}
