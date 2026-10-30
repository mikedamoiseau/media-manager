import { useEffect, useRef } from 'react';
import { useLocation } from 'wouter';
import { yearAsked } from '../store.ts';
import { teaser } from '../yearInFilm.ts';
import { IconRight } from './icons.tsx';
import type { Profile, YearInFilm } from '../types.ts';

/** Open the story over Home; closing it comes back here. */
function useOpenYear() {
  const [, navigate] = useLocation();
  return () => navigate('/year', { state: { fromApp: true } });
}

/** Asked once per profile, from December: see the year now or later. Any answer, or closing, counts. */
export function YearQuestion({ year, me }: { year: YearInFilm; me: Profile }) {
  const open = useOpenYear();
  const ref = useRef<HTMLDivElement>(null);
  const answer = (see: boolean) => {
    void yearAsked();
    if (see) open();
  };
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && void yearAsked();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="sheet-backdrop" onClick={() => answer(false)}>
      <div ref={ref} className="sheet year-ask" role="dialog" aria-modal="true" aria-labelledby="year-ask-title" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        {year.posters.length > 0 && (
          <div className="year-fan" aria-hidden="true">
            {year.posters.slice(0, 3).map((p) => (
              <img key={p} src={p} alt="" />
            ))}
          </div>
        )}
        <p className="year-kicker">
          {me.name} · {year.year}
        </p>
        <h2 id="year-ask-title" className="year-ask-title">
          Your year in film is ready
        </h2>
        <p className="year-ask-teaser">{teaser(year)}. About a minute to watch.</p>
        <div className="year-ask-actions">
          <button className="btn primary big" onClick={() => answer(true)}>
            See my year
          </button>
          <button className="btn ghost big" onClick={() => answer(false)}>
            Later
          </button>
        </div>
        <p className="year-ask-note">Later keeps it on Home until 31 January.</p>
      </div>
    </div>
  );
}

/** On Home once asked, until 31 January: opens the story, as often as wanted. */
export function YearCard({ year }: { year: YearInFilm }) {
  const open = useOpenYear();
  return (
    <button className="year-card" onClick={open}>
      <span className="year-card-year">{year.year}</span>
      <span className="year-card-text">
        <b>Your year in film</b>
        <span>Ready until 31 January</span>
      </span>
      <IconRight />
    </button>
  );
}
