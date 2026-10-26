import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { useStore, prefs, status, toast, pollNowPlaying, library, profileChoice } from '../store.ts';
import { displayTitle, plotLang, categoryLabel, formatRuntime, formatSize, groupCards, setLineup, setName, splitSet } from '../search.ts';
import type { Detail, Episode, SetPart, TitleLang } from '../types.ts';
import { Poster } from './Poster.tsx';
import { MatchDialog } from './MatchDialog.tsx';
import { PosterPicker } from './PosterPicker.tsx';
import { IconBack, IconPlay, IconYoutube, IconTv, IconCheck, IconImage, IconLink, IconEye, IconEyeOff, IconDevice, IconThumbUp, IconThumbDown } from './icons.tsx';
import { isIOS, mediaUrl, vlcLink, vlcBack, episodeName, VLC_APP_STORE } from '../vlc.ts';
import { TitleTile, MissingTile } from './Library.tsx';
import { useOpenTitle, useOpenSet, useShowPerson } from '../nav.ts';

export const LANGS: Array<{ key: TitleLang; label: string; hint: string }> = [
  { key: 'fr', label: 'FR', hint: 'French titles and plots' },
  { key: 'en', label: 'EN', hint: 'English titles and plots' },
  { key: 'original', label: 'VO', hint: 'Original titles, plots in the original language when French or English' },
];

export function LangSwitch() {
  const p = useStore(prefs);
  return (
    <div className="segmented" role="radiogroup" aria-label="Language">
      {LANGS.map((l) => (
        <button key={l.key} role="radio" aria-checked={p.titleLang === l.key} title={l.hint} onClick={() => prefs.set({ ...p, titleLang: l.key })}>
          {l.label}
        </button>
      ))}
    </div>
  );
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    localStorage.setItem(key, '1');
  } catch {
    /* private mode */
  }
}

export async function playOnKodi(itemId: number, episodeId?: number, label?: string) {
  try {
    await api.post(`/api/items/${itemId}/play`, episodeId ? { episodeId } : {});
    toast(label ? `Playing ${label} on the TV` : 'Playing on the TV');
    setTimeout(() => void pollNowPlaying(), 1500);
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

/** The YouTube trailer, shown under the actions. onTv plays it on Kodi instead. */
export function Trailer({ videoId, onTv }: { videoId: string; onTv?: () => Promise<unknown> }) {
  return (
    <div className="trailer">
      <iframe
        src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&playsinline=1&rel=0`}
        title="Trailer"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
      />
      <div className="trailer-links">
        <a className="btn ghost small" href={`https://www.youtube.com/watch?v=${videoId}`} target="_blank" rel="noreferrer">
          Open in YouTube
        </a>
        {onTv && (
          <button
            className="btn ghost small"
            onClick={() =>
              onTv().then(
                () => toast('Trailer playing on the TV'),
                (e: Error) => toast(e.message, 'error'),
              )
            }
          >
            <IconTv size={18} /> Play trailer on TV
          </button>
        )}
      </div>
    </div>
  );
}

/** Liked or not, for a film you watched: suggestions follow. Tapping the chosen one clears it. */
function Rating({ itemId, value, onChange }: { itemId: number; value: 1 | -1 | null; onChange: (v: 1 | -1 | null) => void }) {
  const set = async (v: 1 | -1) => {
    const next = value === v ? null : v;
    onChange(next);
    try {
      await api.put(`/api/items/${itemId}/rating`, { value: next });
      toast(next === 1 ? 'Liked: suggestions will lean this way' : next === -1 ? 'Noted: fewer films like this one' : 'Rating removed');
    } catch (e) {
      onChange(value);
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="segmented rate" role="group" aria-label="Your rating">
      <button aria-pressed={value === 1} aria-label="I liked it" title="I liked it" onClick={() => void set(1)}>
        <IconThumbUp size={20} />
      </button>
      <button aria-pressed={value === -1} aria-label="Not for me" title="Not for me" onClick={() => void set(-1)}>
        <IconThumbDown size={20} />
      </button>
    </div>
  );
}

/** Directors and cast; tap a name for the library's titles with them. */
export function People({ directors, cast, tv }: { directors: string[]; cast: Array<{ name: string; character?: string }>; tv: boolean }) {
  const showPerson = useShowPerson();
  if (!directors.length && !cast.length) return null;
  return (
    <section className="people">
      {directors.length > 0 && (
        <p>
          <span className="muted">{tv ? 'Created by' : 'Directed by'}</span>{' '}
          {directors.map((n, i) => (
            <Fragment key={n}>
              {i > 0 && ', '}
              <button className="person" onClick={() => showPerson(n)}>
                {n}
              </button>
            </Fragment>
          ))}
        </p>
      )}
      {cast.length > 0 && (
        <ul className="cast">
          {cast.map((c) => (
            <li key={c.name + c.character}>
              <button className="person" onClick={() => showPerson(c.name)}>
                <strong>{c.name}</strong>
              </button>
              {c.character && <span>{c.character}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function DetailView({ id, onClose }: { id: number; onClose: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [trailer, setTrailer] = useState(false);
  const [dialog, setDialog] = useState<'match' | 'poster' | null>(null);
  const { titleLang } = useStore(prefs);
  // What you look at steers the suggestions (the server ignores repeats within minutes).
  const noteActivity = (kind: 'open' | 'trailer') => void api.post(`/api/items/${id}/activity`, { kind }).catch(() => {});
  useEffect(() => noteActivity('open'), [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useStore(status);
  const libVersion = useStore(library).version;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<Detail>(`/api/items/${id}`)
      .then((r) => alive && setD(r))
      .catch((e: ApiError) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
    // Refresh when the library changes underneath (e.g. metadata arrived).
  }, [id, libVersion]);

  // Focus once on open; Escape goes through refs so re-renders never move focus (see Sheet).
  const close = useRef(onClose);
  close.current = onClose;
  const dialogOpen = useRef(dialog);
  dialogOpen.current = dialog;
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !dialogOpen.current) close.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const t = d ? displayTitle(d, titleLang) : null;
  const overviewLang = d ? plotLang(titleLang, d.originalLanguage) : 'fr';
  const overview = d ? (overviewLang === 'fr' ? (d.overviewFr ?? d.overviewEn) : (d.overviewEn ?? d.overviewFr)) : null;
  const kodiReady = !!st?.tvs.length;
  const present = d?.versions.some((v) => v.present);
  // The episodes listed are this copy's: playable only when this copy is on the NAS.
  const episodesHere = !!d?.versions.find((v) => v.id === d.id)?.present;
  // The copy VLC gets: this one when it is on the NAS, else another copy that is.
  const phoneCopy = d?.versions.find((v) => v.id === d.id && v.present) ?? d?.versions.find((v) => v.present);
  const phoneName = phoneCopy && d ? `${displayTitle(d, titleLang).main}${phoneCopy.isDir ? '' : phoneCopy.path.slice(phoneCopy.path.lastIndexOf('.'))}` : '';
  const [vlcSeen, setVlcSeen] = useState(() => readFlag('mm.vlcOpened'));
  // VLC opening hides this page; once it has, the "needs the VLC app" hint is no longer needed.
  const watchVlcLaunch = () => {
    const onHide = () => {
      if (document.visibilityState !== 'hidden') return;
      writeFlag('mm.vlcOpened');
      setVlcSeen(true);
      document.removeEventListener('visibilitychange', onHide);
    };
    document.addEventListener('visibilitychange', onHide);
    setTimeout(() => document.removeEventListener('visibilitychange', onHide), 60000);
  };

  return (
    <div className="detail" role="dialog" aria-modal="true" aria-label={t?.main ?? 'Title'} ref={ref} tabIndex={-1}>
      <div className="detail-bar">
        <button className="icon-btn on-image" onClick={onClose} aria-label="Back">
          <IconBack />
        </button>
        <LangSwitch />
      </div>

      {err && (
        <div className="empty">
          <h2>Can't open this title</h2>
          <p>{err}</p>
        </div>
      )}

      {d && t && (
        <>
          <div className="detail-backdrop" aria-hidden="true">
            {d.backdrop ? <img src={d.backdrop} alt="" /> : d.poster ? <img src={d.poster} alt="" className="blurred" /> : null}
          </div>

          <div className="detail-hero">
            <button className="detail-poster" onClick={() => setDialog('poster')} aria-label="Change the poster">
              <Poster key={d.poster ?? 'none'} src={d.poster} title={t.main} year={d.y} />
            </button>
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
                <li>{categoryLabel(d.c)}</li>
              </ul>
              {d.ge.length > 0 && <p className="genres">{d.ge.join(', ')}</p>}
            </div>
          </div>

          <div className="detail-actions">
            {present && (
              <button className="btn primary big" disabled={!kodiReady} onClick={() => void playOnKodi(d.id, undefined, t.main)}>
                <IconPlay size={20} />
                {d.d && d.episodes.length ? 'Play next episode' : d.versions.some((v) => v.resume && v.resume > 0.02) ? 'Resume on TV' : 'Play on TV'}
              </button>
            )}
            {isIOS && phoneCopy && (
              <a className="btn big" href={vlcLink(mediaUrl(location.origin, 'item', phoneCopy.id, phoneName, profileChoice.get() ?? undefined), vlcBack())} onClick={watchVlcLaunch}>
                <IconDevice size={20} />
                Play in VLC
              </a>
            )}
            {d.trailer && (
              <button
                className="btn trailer-btn"
                aria-expanded={trailer}
                onClick={() => {
                  if (!trailer) noteActivity('trailer');
                  setTrailer(!trailer);
                }}
              >
                <IconYoutube size={20} />
                Trailer
              </button>
            )}
            {d.canRate && <Rating itemId={d.id} value={d.rating} onChange={(rating) => setD((x) => x && { ...x, rating })} />}
          </div>
          {present && !kodiReady && <p className="hint pad">Kodi isn't connected yet. Open Settings to find it on your network.</p>}
          {isIOS && phoneCopy && !vlcSeen && (
            <p className="hint pad">
              Play in VLC plays {d.episodes.length ? 'episodes' : 'the film'} on this device with all their audio and subtitle tracks. It needs the free{' '}
              <a href={VLC_APP_STORE} target="_blank" rel="noreferrer">
                VLC app
              </a>
              .
            </p>
          )}
          {!present && <p className="hint pad">This one is in your sheet but its file isn't on the NAS anymore.</p>}

          {trailer && d.trailer && <Trailer videoId={d.trailer} onTv={kodiReady ? () => api.post(`/api/items/${d.id}/trailer`) : undefined} />}

          <div className="detail-body">
            {/* TMDB only gives the English tagline: don't mix it with a French plot. */}
            {d.tagline && (overviewLang === 'en' || !d.overviewFr) && <p className="tagline">{d.tagline}</p>}
            {overview && (
              <div className="overview">
                <p>{overview}</p>
              </div>
            )}
            {!overview && d.m !== 'matched' && d.m !== 'manual' && (
              <div className="callout">
                <p>
                  {d.m === 'none'
                    ? 'Marked as not on TMDB: shown with a frame from the video.'
                    : st?.tmdbConfigured
                      ? "This file isn't matched to a film or series yet."
                      : 'Add a TMDB key in Settings to fetch posters, plots and trailers for files Kodi doesn’t know.'}
                </p>
                <button className="btn small" onClick={() => setDialog('match')}>
                  Find the right title
                </button>
              </div>
            )}

            {d.episodes.length > 0 && (
              <Episodes
                itemId={d.id}
                episodes={d.episodes}
                kodiReady={kodiReady && episodesHere}
                vlc={isIOS && episodesHere ? { show: t.main, onOpen: watchVlcLaunch } : null}
              />
            )}

            {d.collection && <SetRow name={d.collection} itemId={d.id} />}

            <People directors={d.directors} cast={d.cast} tv={d.mediaType === 'tv'} />

            <Versions d={d} kodiReady={kodiReady} title={t.main} />

            <section className="file-tools">
              <h2 className="section-title">Library</h2>
              <div className="tool-row">
                <button className="btn small" onClick={() => setDialog('match')}>
                  <IconLink size={18} /> {d.tmdbId ? 'Wrong title? Rematch' : 'Match to a title'}
                </button>
                <button className="btn small" onClick={() => setDialog('poster')}>
                  <IconImage size={18} /> Change poster
                </button>
                <button
                  className="btn small"
                  onClick={async () => {
                    const r = await api.patch<Detail>(`/api/items/${d.id}`, { hidden: !d.h });
                    setD(r);
                    toast(r.h ? 'Hidden from the library' : 'Back in the library');
                  }}
                >
                  {d.h ? <IconEye size={18} /> : <IconEyeOff size={18} />} {d.h ? 'Show in library' : 'Hide from library'}
                </button>
              </div>
              <dl className="meta-list">
                <dt>Info from</dt>
                <dd>{sourceLabel(d)}</dd>
                {d.sheet && (
                  <>
                    <dt>In your sheet as</dt>
                    <dd>{[d.sheet.fr, d.sheet.en !== d.sheet.fr ? d.sheet.en : null, d.sheet.year].filter(Boolean).join(' / ')}</dd>
                  </>
                )}
                {d.tmdbId && (
                  <>
                    <dt>Links</dt>
                    <dd className="links">
                      <a href={`https://www.themoviedb.org/${d.mediaType}/${d.tmdbId}`} target="_blank" rel="noreferrer">
                        TMDB
                      </a>
                      {d.imdbId && (
                        <a href={`https://www.imdb.com/title/${d.imdbId}/`} target="_blank" rel="noreferrer">
                          IMDb
                        </a>
                      )}
                    </dd>
                  </>
                )}
              </dl>
            </section>
          </div>

          {dialog === 'match' && (
            <MatchDialog
              item={d}
              onClose={() => setDialog(null)}
              onDone={(r) => {
                setD(r);
                setDialog(null);
              }}
            />
          )}
          {dialog === 'poster' && (
            <PosterPicker
              item={d}
              onClose={() => setDialog(null)}
              onDone={(r) => {
                setD(r);
                setDialog(null);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

function sourceLabel(d: Detail): string {
  if (d.m === 'none') return 'Not on TMDB (frame from the video)';
  if (!d.tmdbId) return d.sheet ? 'Your sheet and the file name' : 'The file name';
  const how = d.versions.find((v) => v.id === d.id)?.matchSource;
  const by = how === 'kodi' ? 'matched by Kodi' : how === 'manual' ? 'matched by you' : 'matched automatically';
  return `TMDB, ${by}${d.metaSource === 'kodi' ? ' (details from Kodi)' : ''}`;
}

function Versions({ d, kodiReady, title }: { d: Detail; kodiReady: boolean; title: string }) {
  return (
    <section className="versions">
      <h2 className="section-title">{d.versions.length > 1 ? `${d.versions.length} copies` : 'File'}</h2>
      <ul>
        {d.versions.map((v) => {
          const name = v.path.startsWith('sheet:') ? v.path.split(':').slice(2).join(':') : v.path.slice(v.path.lastIndexOf('/') + 1);
          return (
            <li key={v.id} className={v.present ? '' : 'is-missing'}>
              <div className="version-main">
                <div className="badges">
                  {v.quality.map((q) => (
                    <span key={q} className="badge">
                      {q}
                    </span>
                  ))}
                  {v.watched && (
                    <span className="badge watched">
                      <IconCheck size={12} strokeWidth={3} /> Watched
                    </span>
                  )}
                  {v.resume && v.resume > 0.02 ? <span className="badge">{Math.round(v.resume * 100)}% seen</span> : null}
                </div>
                <p className="file-name" title={v.path}>
                  {name}
                </p>
                <p className="muted small">
                  {v.present ? `${v.folder || 'MEDIA'}${v.isDir && v.fileCount ? `, ${v.fileCount} files` : ''}` : 'Not on the NAS'}
                  {v.size ? `, ${formatSize(v.size)}` : ''}
                </p>
              </div>
              {v.present && d.versions.length > 1 && (
                <button className="icon-btn play-small" disabled={!kodiReady} onClick={() => void playOnKodi(v.id, undefined, title)} aria-label={`Play this copy on the TV`}>
                  <IconPlay size={18} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The film's set (TMDB collection): every film in release order, this one outlined, missing ones greyed. */
function SetRow({ name, itemId }: { name: string; itemId: number }) {
  const { items } = useStore(library);
  const { titleLang } = useStore(prefs);
  const openTitle = useOpenTitle();
  const openSet = useOpenSet();
  const row = useRef<HTMLDivElement>(null);
  const [parts, setParts] = useState<SetPart[]>([]);
  useEffect(() => {
    // Without TMDB the row keeps the library's films of the set.
    api.get<{ parts: SetPart[] }>(`/api/set?name=${encodeURIComponent(name)}`).then((r) => setParts(r.parts), () => {});
  }, [name]);
  const groups = useMemo(() => groupCards(items), [items]);
  const lineup = useMemo(() => setLineup(name, parts, groups), [name, parts, groups]);
  const { onNas, released } = useMemo(() => splitSet(name, parts, [], groups), [name, parts, groups]);
  const current = lineup.findIndex((e) => e.group?.items.some((c) => c.id === itemId));

  // Long sets (James Bond): bring this film to the middle of the row.
  useLayoutEffect(() => {
    const el = row.current;
    const tile = el?.children[current] as HTMLElement | undefined;
    if (el && tile) el.scrollLeft = tile.offsetLeft - el.offsetLeft - (el.clientWidth - tile.offsetWidth) / 2;
  }, [current, lineup.length]);

  if (lineup.length < 2) return null;
  return (
    <section className="detail-set" aria-labelledby="detail-set-title">
      <div className="detail-set-head">
        <div>
          <h2 className="section-title" id="detail-set-title">
            {setName(name)}
          </h2>
          <p className="muted">
            {released ? `Set of ${released} films, ${onNas === released ? 'all' : onNas} on the NAS` : `Set of ${lineup.length} films`}
          </p>
        </div>
        <button className="btn ghost small" onClick={() => openSet(name)}>
          Open the set
        </button>
      </div>
      <div className="shelf-row detail-set-row" ref={row}>
        {lineup.map(({ part, group }, i) =>
          group ? (
            <TitleTile key={group.key} g={group} lang={titleLang} onOpen={openTitle} current={i === current} />
          ) : (
            <MissingTile key={part!.id} part={part!} lang={titleLang} />
          ),
        )}
      </div>
    </section>
  );
}

function Episodes({
  itemId,
  episodes,
  kodiReady,
  vlc,
}: {
  itemId: number;
  episodes: Episode[];
  kodiReady: boolean;
  /** each episode can also go to VLC on the phone */
  vlc: { show: string; onOpen: () => void } | null;
}) {
  const seasons = useMemo(() => {
    const m = new Map<string, { order: number; eps: Episode[] }>();
    for (const e of episodes) {
      const k = e.season === 0 ? 'Extras' : e.season != null ? `Season ${e.season}` : (e.dir ?? 'Episodes');
      // Real seasons in order, then loose folders, extras last.
      const order = e.season === 0 ? 10_000 : e.season ?? 5_000;
      const g = m.get(k) ?? { order, eps: [] };
      g.eps.push(e);
      m.set(k, g);
    }
    return [...m.entries()].sort((a, b) => a[1].order - b[1].order).map(([k, g]) => [k, g.eps] as const);
  }, [episodes]);
  const [sel, setSel] = useState(0);
  const list = seasons[Math.min(sel, seasons.length - 1)]?.[1] ?? [];
  return (
    <section className="episodes">
      <h2 className="section-title">{episodes.length} episodes</h2>
      {seasons.length > 1 && (
        <div className="chips">
          {seasons.map(([k, eps], i) => (
            <button key={k} className="chip" aria-selected={i === sel} onClick={() => setSel(i)}>
              {k}
              <span className="chip-count">{eps.length}</span>
            </button>
          ))}
        </div>
      )}
      <ol className="episode-list">
        {list.map((e) => (
          <li key={e.id} className={e.watched ? 'is-watched' : ''}>
            <button className="episode" disabled={!kodiReady} onClick={() => void playOnKodi(itemId, e.id, e.title ?? undefined)}>
              <span className="ep-num">{e.episode ?? '·'}</span>
              <span className="ep-text">
                <span className="ep-title">{e.title ?? e.name.replace(/\.[^.]+$/, '')}</span>
                {e.title && <span className="ep-file">{e.name}</span>}
              </span>
              {e.watched ? <IconCheck size={16} className="ep-check" /> : <IconPlay size={16} className="ep-play" />}
            </button>
            {vlc && (
              <a
                className="ep-vlc"
                href={vlcLink(mediaUrl(location.origin, 'episode', e.id, episodeName(vlc.show, e), profileChoice.get() ?? undefined), vlcBack())}
                onClick={vlc.onOpen}
                aria-label={`Play ${e.title ?? e.name} in VLC`}
              >
                <IconDevice size={20} />
              </a>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
