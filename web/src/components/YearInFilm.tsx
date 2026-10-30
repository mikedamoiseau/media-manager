import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useLocation, useSearch } from 'wouter';
import { api } from '../api.ts';
import { useStore, library, prefs, useProfile, yearAsked, yearStore } from '../store.ts';
import { displayTitle } from '../search.ts';
import { coveredLine, daysLine, hourLabel, primeLine, storyCards, teaser, type CardKey } from '../yearInFilm.ts';
import { Avatar } from './WhosWatching.tsx';
import { IconClose, IconRight } from './icons.tsx';
import type { Profile, YearInFilm, YearTitle } from '../types.ts';

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

// ---------- the story ----------

/** Each card moves on after this; numbers count up over COUNT_MS. */
const CARD_MS = 6000;
const COUNT_MS = 1500;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** An animation's delay (see .story-in and the other story animations). */
const after = (ms: number) => ({ '--d': `${ms}ms` }) as CSSProperties;
const plural = (n: number, word: string) => `${word}${n === 1 ? '' : 's'}`;
/** `n` items going round `list` again as often as needed (none: none). */
const cycle = <T,>(list: T[], n: number): T[] => (list.length ? Array.from({ length: n }, (_, i) => list[i % list.length]!) : []);
const initials = (name: string) => {
  const w = name.split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] ?? '') + (w.length > 1 ? w.at(-1)![0] : '')).toUpperCase();
};

/** The story's numbers count up (at once with reduced motion). */
function useCount(target: number, still: boolean): number {
  const [n, setN] = useState(still ? target : 0);
  useEffect(() => {
    if (still) return setN(target);
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / COUNT_MS);
      setN(Math.round(target * (1 - (1 - k) ** 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, still]);
  return n;
}

/** A title as the library names it on this device (its title language), else as the server does. */
function useNames(): (t: YearTitle) => string {
  const { items } = useStore(library);
  const { titleLang } = useStore(prefs);
  const byId = useMemo(() => new Map(items.map((c) => [c.id, c])), [items]);
  return (t) => {
    const c = byId.get(t.itemId);
    return c ? displayTitle(c, titleLang).main : t.name;
  };
}

function Poster({ src, className, style }: { src: string | null | undefined; className?: string; style?: CSSProperties }) {
  return <span className={`story-poster${className ? ` ${className}` : ''}`} style={style}>{src && <img src={src} alt="" />}</span>;
}

type CardProps = { y: YearInFilm; me: Profile; still: boolean; name: (t: YearTitle) => string };

function OpenCard({ y, me }: CardProps) {
  const covered = coveredLine(y, Date.now());
  const pics: Array<string | null> = y.posters.length ? y.posters : [null];
  return (
    <>
      <div className="story-columns" aria-hidden="true">
        {[0, 1, 2].map((c) => {
          // Every third poster, so no column repeats its neighbour's.
          const own = pics.filter((_, i) => i % 3 === c);
          const col = cycle(own.length ? own : pics, 6);
          return (
            <div key={c} className={`story-column${c === 1 ? ' down' : ''}`}>
              {[...col, ...col].map((p, i) => (
                <Poster key={i} src={p} />
              ))}
            </div>
          );
        })}
      </div>
      <div className="story-fade" />
      <div className="story-open">
        <span className="story-in story-who" style={after(200)}>
          <Avatar profile={me} />
          {me.name}
        </span>
        <span className="story-in story-year" style={after(450)}>
          {y.year}
        </span>
        <span className="story-in story-headline" style={after(750)}>
          Your year in film
        </span>
        {covered && (
          <span className="story-in story-muted" style={after(1000)}>
            {covered}
          </span>
        )}
      </div>
      <span className="story-in story-hint" style={after(1800)}>
        Tap to go on
      </span>
    </>
  );
}

function CountCard({ y, still }: CardProps) {
  const films = y.films > 0;
  const big = useCount(films ? y.films : y.episodes, still);
  return (
    <div className="story-body story-count">
      <div className="story-wall" aria-hidden="true">
        {cycle(y.posters.length ? y.posters : [null], 12).map((p, i) => (
          <Poster key={i} src={p} className="story-pop" style={after(i * 60)} />
        ))}
      </div>
      <span className="story-in story-lead" style={after(700)}>
        You watched
      </span>
      <span className="story-figure">
        <span className="story-number">{big}</span>
        <span className="story-in story-unit" style={after(900)}>
          {films ? plural(y.films, 'film') : plural(y.episodes, 'episode')}
        </span>
      </span>
      {films && y.episodes > 0 && (
        <span className="story-in story-lead" style={after(1700)}>
          and {y.episodes} {plural(y.episodes, 'episode')}.
        </span>
      )}
    </div>
  );
}

function HoursCard({ y, still }: CardProps) {
  const n = useCount(y.hours, still);
  const days = daysLine(y.hours);
  const strip = cycle(y.posters, 8);
  return (
    <>
      <div className="story-body">
        <span className="story-in story-lead">{y.estimated ? "That's about" : "That's"}</span>
        <span className="story-figure">
          <span className="story-number">{n}</span>
          <span className="story-in story-unit" style={after(300)}>
            {plural(y.hours, 'hour')}
          </span>
        </span>
        {days && (
          <span className="story-in story-lead" style={after(1600)}>
            {days}.
          </span>
        )}
      </div>
      {strip.length > 0 && (
        <div className="story-in story-strip" style={after(200)} aria-hidden="true">
          <div className="story-strip-run">
            {[...strip, ...strip].map((p, i) => (
              <Poster key={i} src={p} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function GenresCard({ y }: CardProps) {
  const top = y.genres[0]!;
  return (
    <div className="story-body">
      <span className="story-in story-lead">Mostly</span>
      <span className="story-in story-big" style={after(250)}>
        {top.name}
      </span>
      <span className="story-in story-line" style={after(500)}>
        {top.n} of the {y.titles} films and series you watched.
      </span>
      <div className="story-bars">
        {y.genres.map((g, i) => (
          <div key={g.name} className="story-bar-row">
            <span className="story-in" style={after(700 + i * 180)}>
              {g.name}
            </span>
            <span className="story-bar">
              <span className={`story-grow${i === 0 ? ' top' : ''}`} style={{ ...after(700 + i * 180), width: `${(g.n / top.n) * 100}%` }} />
            </span>
            <span className="story-in story-bar-n" style={after(700 + i * 180)}>
              {g.n}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActorCard({ y, name }: CardProps) {
  const a = y.actor!;
  const [first, second, third] = a.titles;
  return (
    <div className="story-body story-center">
      <div className="story-fan" aria-hidden="true">
        {second && <Poster src={second.poster} className="story-fan-left" />}
        {third && <Poster src={third.poster} className="story-fan-right" />}
        {first && <Poster src={first.poster} className="story-pop" />}
      </div>
      <span className="story-photo story-pop" style={after(900)} role="img" aria-label={`Photo of ${a.name}`}>
        {a.photo ? <img src={a.photo} alt="" /> : initials(a.name)}
      </span>
      <span className="story-in story-lead" style={after(1100)}>
        You kept coming back to
      </span>
      <span className="story-in story-name" style={after(1300)}>
        {a.name}
      </span>
      <span className="story-in story-line" style={after(1700)}>
        {a.n} {a.onlyFilms ? 'films' : 'titles'}: {a.titles.map(name).join(', ')}
        {a.n > a.titles.length ? '…' : '.'}
      </span>
      {a.tie && (
        <span className="story-in story-muted" style={after(2200)}>
          Tied with {a.tie}.
        </span>
      )}
    </div>
  );
}

function SeriesCard({ y, still, name }: CardProps) {
  const [top, ...more] = y.series;
  const n = useCount(top!.episodes, still);
  return (
    <>
      <div className="story-backdrop" role="img" aria-label={`Backdrop of ${name(top!)}`}>
        {top!.backdrop && <img className="story-zoom" src={top!.backdrop} alt="" />}
      </div>
      <div className="story-body story-below">
        <span className="story-in story-kicker">Your series</span>
        <span className="story-figure">
          <span className="story-number">{n}</span>
          <span className="story-in story-unit" style={after(300)}>
            {plural(top!.episodes, 'episode')} of
          </span>
        </span>
        <span className="story-in story-name plain" style={after(500)}>
          {name(top!)}
        </span>
        <div className="story-list">
          {more.slice(0, 3).map((s, i) => (
            <div key={s.itemId} className="story-in" style={after(900 + i * 200)}>
              <span>{name(s)}</span>
              <b>{s.episodes}</b>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function PrimeCard({ y }: CardProps) {
  const h = y.primeHour!;
  const max = Math.max(...y.hours24, 1);
  return (
    <div className="story-body">
      <span className="story-in story-kicker">Prime time</span>
      <span className="story-in story-big" style={after(200)}>
        {hourLabel(h)}
      </span>
      <span className="story-in story-line" style={after(500)}>
        {primeLine(y)}
        {y.afterMidnight > 0 && ` ${y.afterMidnight} after midnight.`}
      </span>
      <div className="story-chart" role="img" aria-label={`Plays by hour of the day, highest at ${hourLabel(h)}`}>
        {y.hours24.map((n, i) => (
          <span key={i} className={`story-rise${i === h ? ' top' : ''}`} style={{ ...after(700 + i * 40), height: `${Math.max(2, (n / max) * 100)}%` }} />
        ))}
      </div>
      <div className="story-axis" aria-hidden="true">
        <span>midnight</span>
        <span>6 am</span>
        <span>noon</span>
        <span>6 pm</span>
      </div>
    </div>
  );
}

function TvsCard({ y }: CardProps) {
  const { rows, since } = y.tvs!;
  const top = rows[0]!;
  const d = new Date(since);
  return (
    <div className="story-body">
      <span className="story-in story-kicker">Where you watched</span>
      <span className="story-in story-big" style={after(250)}>
        {top.name}
      </span>
      <div className="story-bars">
        {rows.map((r, i) => (
          <div key={r.name} className="story-bar-row">
            <span className="story-in" style={after(600 + i * 180)}>
              {r.name}
            </span>
            <span className="story-bar">
              <span className={`story-grow${i === 0 ? ' top' : ''}`} style={{ ...after(600 + i * 180), width: `${(r.n / top.n) * 100}%` }} />
            </span>
            <span className="story-in story-bar-n" style={after(600 + i * 180)}>
              {r.n}
            </span>
          </div>
        ))}
      </div>
      {since > y.from && (
        <span className="story-in story-muted" style={after(1400)}>
          Since {d.getDate()} {MONTHS[d.getMonth()]}
        </span>
      )}
    </div>
  );
}

function SummaryCard({ y, me, name, onAgain, onDone }: CardProps & { onAgain: () => void; onDone: () => void }) {
  const cells: Array<[string, ReactNode]> = [
    ['Films', y.films],
    ['Episodes', y.episodes],
    ['Hours', y.estimated ? `About ${y.hours}` : y.hours],
  ];
  if (y.primeHour !== null) cells.push(['Prime time', hourLabel(y.primeHour)]);
  if (y.genres[0]) cells.push(['Top genre', y.genres[0].name]);
  if (y.series[0]) cells.push(['Top series', name(y.series[0])]);
  return (
    <div className="story-summary">
      <div className="story-pop story-panel">
        <span className="story-panel-head">
          <span className="story-who plain">
            <Avatar profile={me} />
            {me.name}
          </span>
          <span className="story-panel-year">{y.year}</span>
        </span>
        <span className="story-headline small">Your year in film</span>
        <div className="story-cells">
          {cells.map(([label, value], i) => (
            <div key={label} className="story-in" style={after(300 + i * 100)}>
              <span className="story-label">{label}</span>
              <span className="story-value">{value}</span>
            </div>
          ))}
        </div>
        {(y.actor || y.oldest) && (
          <div className="story-in story-more" style={after(1100)}>
            {y.actor && (
              <div>
                <span className="story-label">Your actor</span>
                <span className="story-value">{y.actor.name}</span>
              </div>
            )}
            {y.oldest && (
              <div>
                <span className="story-label">Oldest film</span>
                <span className="story-oldest">
                  {name(y.oldest)}, {y.oldest.year}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="story-actions">
        <button className="btn primary big" onClick={onAgain}>
          Watch again
        </button>
        <button className="btn ghost big" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

const CARDS: Record<Exclude<CardKey, 'summary'>, (p: CardProps) => ReactNode> = {
  open: OpenCard,
  count: CountCard,
  hours: HoursCard,
  genres: GenresCard,
  actor: ActorCard,
  series: SeriesCard,
  prime: PrimeCard,
  tvs: TvsCard,
};

/** The year, card by card: each moves on by itself; tap the right to go on, the left to go back. */
function Story({ y, me, onClose }: { y: YearInFilm; me: Profile; onClose: () => void }) {
  const cards = useMemo(() => storyCards(y), [y]);
  const [i, setI] = useState(0);
  const [still] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  const name = useNames();
  const ref = useRef<HTMLDivElement>(null);
  const key = cards[i]!;
  const last = i === cards.length - 1;
  const go = (d: number) => setI((n) => Math.max(0, Math.min(cards.length - 1, n + d)));
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (last) return;
    const t = setTimeout(() => go(1), CARD_MS);
    return () => clearTimeout(t);
  }, [i]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const props: CardProps = { y, me, still, name };
  const Card = key === 'summary' ? null : CARDS[key];
  return (
    <div ref={ref} className="story" role="dialog" aria-modal="true" aria-label={`Your year in film, ${y.year}`} tabIndex={-1}>
      <div key={i} className="story-card">
        {Card ? <Card {...props} /> : <SummaryCard {...props} onAgain={() => setI(0)} onDone={onClose} />}
      </div>
      {!last && (
        <>
          <button className="story-tap prev" aria-label="Previous" onClick={() => go(-1)} />
          <button className="story-tap next" aria-label="Next" onClick={() => go(1)} />
        </>
      )}
      <div className="story-progress" aria-hidden="true">
        {cards.map((c, n) => (
          <span key={c}>
            {n < i || (n === i && last) ? <span className="done" /> : n === i && <span key={i} className="now" style={{ animationDuration: `${CARD_MS}ms` }} />}
          </span>
        ))}
      </div>
      <button className="icon-btn story-close" aria-label="Close" onClick={onClose}>
        <IconClose />
      </button>
    </div>
  );
}

/** Your year in film, full screen over everything. `?year=` in its address shows that year (a preview, for checks). */
export function YearStory({ onClose }: { onClose: () => void }) {
  const me = useProfile();
  const stored = useStore(yearStore);
  const preview = new URLSearchParams(useSearch()).get('year');
  // An answer counts only for the profile and year it was asked for.
  const asked = `${me?.id}:${preview}`;
  const [fetched, setFetched] = useState<{ asked: string; y: YearInFilm | null }>();
  useEffect(() => {
    if (!preview && stored) return;
    let live = true;
    api.get<YearInFilm>(`/api/year${preview ? `?year=${encodeURIComponent(preview)}` : ''}`).then(
      (y) => live && setFetched({ asked, y }),
      () => live && setFetched({ asked, y: null }),
    );
    return () => {
      live = false;
    };
  }, [asked, stored]); // eslint-disable-line react-hooks/exhaustive-deps
  const got = fetched?.asked === asked ? fetched.y : undefined;
  const y = preview ? got : (stored ?? got);
  if (!me || y === undefined) return <div className="story" />;
  if (!y) {
    return (
      <div className="story story-nothing" role="dialog" aria-modal="true" aria-label="Your year in film">
        <p>Nothing to show yet.</p>
        <button className="btn ghost big" onClick={onClose}>
          Back
        </button>
      </div>
    );
  }
  return <Story key={`${me.id}:${y.year}`} y={y} me={me} onClose={onClose} />;
}
