import { useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { api } from '../api.ts';
import { useStore, library, status, prefs, toast, loadLibrary } from '../store.ts';
import { ProfileBadge } from './WhosWatching.tsx';
import { categoryLabel, displayTitle } from '../search.ts';
import type { Card, Candidate, Detail } from '../types.ts';
import { Poster } from './Poster.tsx';
import { MatchDialog } from './MatchDialog.tsx';
import { useOpenTitle } from '../nav.ts';
import { PullToRefresh, serverRefresh } from './PullToRefresh.tsx';

/** Files nobody could identify yet: confirm a suggestion in one tap, or search. */
export function Review() {
  const { items } = useStore(library);
  const st = useStore(status);
  const { titleLang } = useStore(prefs);
  const [, navigate] = useLocation();
  const openTitle = useOpenTitle();
  const [matching, setMatching] = useState<Detail | null>(null);
  const [cat, setCat] = useState('all');
  const scroller = useRef<HTMLDivElement>(null);

  const todo = useMemo(() => items.filter((c) => c.pr && !c.h && (c.m === 'unmatched' || c.m === 'pending')).sort((a, b) => b.a - a.a), [items]);
  const cats = useMemo(() => [...new Set(todo.map((c) => c.c))], [todo]);
  const list = cat === 'all' ? todo : todo.filter((c) => c.c === cat);
  const pending = todo.filter((c) => c.m === 'pending').length;

  const openMatch = async (c: Card) => setMatching(await api.get<Detail>(`/api/items/${c.id}`));

  return (
    <>
      <div className="scroller" ref={scroller}>
        <header className="page-head">
          <div className="head-row">
            <h1>To review</h1>
            <ProfileBadge />
          </div>
          <p className="muted">
            {todo.length === 0
              ? 'Every file on the NAS is identified.'
              : `${todo.length.toLocaleString()} files without a confirmed title.`}
          </p>
        </header>

        {!st?.tmdbConfigured && pending > 0 && (
          <div className="callout pad">
            <p>
              {pending.toLocaleString()} files are waiting for TMDB. Kodi didn't know them, so they need a (free) TMDB key to get a title, poster and trailer.
            </p>
            <button className="btn primary small" onClick={() => navigate('/settings')}>
              Add the key in Settings
            </button>
          </div>
        )}
        {st?.tmdbConfigured && !st.metadata.running && todo.some((c) => c.m === 'unmatched') && (
          <div className="tool-row pad">
            <button
              className="btn small"
              onClick={() =>
                api.post<{ count: number }>('/api/match/retry').then(
                  (r) => toast(`Searching TMDB again for ${r.count} files`),
                  (e: Error) => toast(e.message, 'error'),
                )
              }
            >
              Search TMDB again
            </button>
          </div>
        )}
        {st?.metadata.running && st.metadata.progress && (
          <p className="hint pad">
            Matching on TMDB: {st.metadata.progress.done} of {st.metadata.progress.total}
          </p>
        )}

        {cats.length > 1 && (
          <div className="chips pad-x">
            <button className="chip" aria-selected={cat === 'all'} onClick={() => setCat('all')}>
              All <span className="chip-count">{todo.length}</span>
            </button>
            {cats.map((c) => (
              <button key={c} className="chip" aria-selected={cat === c} onClick={() => setCat(c)}>
                {categoryLabel(c)} <span className="chip-count">{todo.filter((x) => x.c === c).length}</span>
              </button>
            ))}
          </div>
        )}

        <ul className="review-list">
          {list.slice(0, 300).map((c) => (
            <ReviewRow key={c.id} card={c} lang={titleLang} onOpen={() => openTitle(c.id)} onSearch={() => void openMatch(c)} />
          ))}
        </ul>
        {list.length > 300 && <p className="hint pad">Showing the 300 most recent. Matching some will bring up the rest.</p>}

        {matching && <MatchDialog item={matching} onClose={() => setMatching(null)} onDone={() => setMatching(null)} />}
      </div>
      <PullToRefresh scroller={scroller} onRefresh={() => serverRefresh(() => api.post('/api/refresh')).then(loadLibrary)} />
    </>
  );
}

function ReviewRow({ card, lang, onOpen, onSearch }: { card: Card; lang: 'fr' | 'en' | 'original'; onOpen: () => void; onSearch: () => void }) {
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const t = displayTitle(card, lang);

  const loadCands = async () => {
    const d = await api.get<Detail>(`/api/items/${card.id}`);
    setCands(d.candidates.slice(0, 4));
  };

  const pick = async (c: Candidate) => {
    setBusy(true);
    try {
      await api.post(`/api/items/${card.id}/match`, { type: c.type, tmdbId: c.id });
      toast(`Matched to ${c.title}`);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <li className="review-row">
      <button className="review-thumb" onClick={onOpen} aria-label={`Open ${t.main}`}>
        <Poster src={card.p} title={t.main} year={card.y} />
      </button>
      <div className="review-body">
        <p className="review-title">
          {t.main}
          {card.y ? <span className="muted"> ({card.y})</span> : null}
        </p>
        <p className="muted small">
          {categoryLabel(card.c)}
          {card.m === 'pending' ? ', not searched yet' : ''}
        </p>
        {card.m === 'unmatched' && cands === null && (
          <button className="link-btn" onClick={() => void loadCands()}>
            Show suggestions
          </button>
        )}
        {cands && cands.length > 0 && (
          <div className="suggestions">
            {cands.map((c) => (
              <button key={`${c.type}${c.id}`} className="suggestion" disabled={busy} onClick={() => void pick(c)} title={`${c.title} (${c.year ?? '?'})`}>
                <Poster src={c.poster ? `/api/img?w=185&u=${encodeURIComponent(c.poster)}` : null} title={c.title} year={c.year} />
                <span>{c.year ?? ''}</span>
              </button>
            ))}
          </div>
        )}
        {cands && cands.length === 0 && <p className="muted small">No suggestions.</p>}
        <button className="btn small" onClick={onSearch}>
          Search
        </button>
      </div>
    </li>
  );
}
