import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { useStore, prefs, status, toast } from '../store.ts';
import { displayTitle, plotLang, formatRuntime, formatDay, countryName } from '../search.ts';
import type { FilmDetail } from '../types.ts';
import { Poster } from './Poster.tsx';
import { LangSwitch, Trailer, People } from './Detail.tsx';
import { IconBack, IconYoutube, IconCheck, IconEye, IconEyeOff, IconFilm } from './icons.tsx';
import { useOpenTitle } from '../nav.ts';

const today = () => new Date().toLocaleDateString('sv');

/** Where the film can be seen, when it isn't on the NAS: in cinemas, or not out yet. */
function whereLine(d: FilmDetail): string | null {
  const day = d.cinema?.date ?? d.date;
  if (d.cinema && day) {
    const where = `in ${countryName(d.cinema.country)}`;
    return day > today() ? `In cinemas ${where} from ${formatDay(day)}.` : `In cinemas ${where} since ${formatDay(day)}.`;
  }
  if (day && day > today()) return `Out on ${formatDay(day)}.`;
  return null;
}

/** The page of a film that isn't on the NAS: what it is, its trailer, and whether you want it. */
export function FilmView({ id, onClose }: { id: number; onClose: () => void }) {
  const [d, setD] = useState<FilmDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [trailer, setTrailer] = useState(false);
  const { titleLang } = useStore(prefs);
  const st = useStore(status);
  const openTitle = useOpenTitle();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<FilmDetail>(`/api/films/${id}`)
      .then((r) => alive && setD(r))
      .catch((e: ApiError) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [id]);

  // Focus once on open; Escape goes through a ref so re-renders never move focus (as on the title page).
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const choose = async (pick: FilmDetail['pick'], msg: string) => {
    if (!d) return;
    const before = d.pick;
    setD({ ...d, pick });
    try {
      await api.put(`/api/films/${d.id}/pick`, { pick });
      toast(msg);
    } catch (e) {
      setD((x) => x && { ...x, pick: before });
      toast((e as Error).message, 'error');
    }
  };

  const t = d ? displayTitle(d, titleLang) : null;
  const overviewLang = d ? plotLang(titleLang, d.originalLanguage) : 'fr';
  const overview = d ? (overviewLang === 'fr' ? (d.overviewFr ?? d.overviewEn) : (d.overviewEn ?? d.overviewFr)) : null;
  const where = d ? whereLine(d) : null;

  return (
    <div className="detail" role="dialog" aria-modal="true" aria-label={t?.main ?? 'Film'} ref={ref} tabIndex={-1}>
      <div className="detail-bar">
        <button className="icon-btn on-image" onClick={onClose} aria-label="Back">
          <IconBack />
        </button>
        <LangSwitch />
      </div>

      {err && (
        <div className="empty">
          <h2>Can't open this film</h2>
          <p>{err}</p>
        </div>
      )}

      {d && t && (
        <>
          <div className="detail-backdrop" aria-hidden="true">
            {d.backdrop ? <img src={d.backdrop} alt="" /> : d.poster ? <img src={d.poster} alt="" className="blurred" /> : null}
          </div>

          <div className="detail-hero">
            <div className="detail-poster">
              <Poster src={d.poster} title={t.main} year={d.y} />
            </div>
            <div className="detail-heading">
              <h1 className={`detail-title${t.main.length > 28 ? ' is-long' : ''}`}>{t.main}</h1>
              {t.sub && <p className="detail-sub">{t.sub}</p>}
              <ul className="facts">
                {d.y && <li>{d.y}</li>}
                {d.runtime ? <li>{formatRuntime(d.runtime)}</li> : null}
                {d.r ? (
                  <li className="fact-rating" title={d.votes ? `${d.votes.toLocaleString()} votes on TMDB` : undefined}>
                    {d.r.toFixed(1)}
                    <small>/10</small>
                  </li>
                ) : null}
              </ul>
              {d.ge.length > 0 && <p className="genres">{d.ge.join(', ')}</p>}
            </div>
          </div>

          <div className="detail-actions">
            {d.itemId ? (
              <button className="btn primary big" onClick={() => openTitle(d.itemId!)}>
                <IconFilm size={20} />
                Open in the library
              </button>
            ) : (
              <button
                className={`btn big${d.pick === 'want' ? ' primary' : ''}`}
                aria-pressed={d.pick === 'want'}
                onClick={() => void (d.pick === 'want' ? choose(null, 'Removed from Films to get') : choose('want', 'Added to Films to get'))}
              >
                <IconCheck size={20} />
                {d.pick === 'want' ? 'On your list' : 'Want it'}
              </button>
            )}
            {d.trailer && (
              <button className="btn trailer-btn" aria-expanded={trailer} onClick={() => setTrailer(!trailer)}>
                <IconYoutube size={20} />
                Trailer
              </button>
            )}
          </div>
          {d.itemId ? (
            <p className="hint pad">A copy is on the NAS after all.</p>
          ) : where ? (
            <p className="hint pad">{where}</p>
          ) : null}

          {trailer && d.trailer && <Trailer videoId={d.trailer} onTv={st?.kodi.host ? () => api.post(`/api/films/${d.id}/trailer`) : undefined} />}

          <div className="detail-body">
            {/* TMDB only gives the English tagline: don't mix it with a French plot. */}
            {d.tagline && (overviewLang === 'en' || !d.overviewFr) && <p className="tagline">{d.tagline}</p>}
            {overview && (
              <div className="overview">
                <p>{overview}</p>
              </div>
            )}

            <People directors={d.directors} cast={d.cast} tv={false} />

            <section className="file-tools">
              <h2 className="section-title">Suggestions</h2>
              <div className="tool-row">
                {d.pick === 'skip' ? (
                  <button className="btn small" onClick={() => void choose(null, 'Back in your suggestions')}>
                    <IconEye size={18} /> Suggest it again
                  </button>
                ) : (
                  <button className="btn small" onClick={() => void choose('skip', 'Won’t be suggested again')}>
                    <IconEyeOff size={18} /> Not interested
                  </button>
                )}
              </div>
              <dl className="meta-list">
                <dt>Links</dt>
                <dd className="links">
                  <a href={`https://www.themoviedb.org/movie/${d.id}`} target="_blank" rel="noreferrer">
                    TMDB
                  </a>
                  {d.imdbId && (
                    <a href={`https://www.imdb.com/title/${d.imdbId}/`} target="_blank" rel="noreferrer">
                      IMDb
                    </a>
                  )}
                </dd>
              </dl>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
