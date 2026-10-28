import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useLocation } from 'wouter';
import { api } from '../api.ts';
import { useStore, status, toast, useTv, tvChoice } from '../store.ts';
import { ProfileBadge } from './WhosWatching.tsx';
import { Sheet } from './Sheet.tsx';
import { IconDevice, IconInfo, IconPlay } from './icons.tsx';
import { isIOS, vlcBack, VLC_APP_STORE } from '../vlc.ts';
import { liveView, nowAndNext, gridSpan, gridStart, gridFrom, liveVlcHref, type LiveView } from '../liveTv.ts';
import type { LiveChannel, LiveProgramme } from '../types.ts';

const PX_PER_MIN = 4;
const HALF_HOUR = 30 * 60_000;
/** The grid's window: from half an hour or so before now, a day ahead (what the guide keeps). */
const GRID_SPAN = 25 * 3600_000;
/** Kodi took up to 11 s to start a channel on the Pi (measured): asking sooner says "not playing" for one that's opening. */
const PLAY_CHECK_MS = 13_000;
const VIEW_KEY = 'mm.liveView';

type Override = { view: LiveView; w: number; h: number };
type Open = { ch: LiveChannel; p?: LiveProgramme };

const screenSize = () => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight });

function readOverride(): Override | null {
  try {
    const o = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null') as Override | null;
    return o && (o.view === 'grid' || o.view === 'list') ? o : null;
  } catch {
    return null;
  }
}

function writeOverride(o: Override | null): void {
  try {
    if (o) localStorage.setItem(VIEW_KEY, JSON.stringify(o));
    else localStorage.removeItem(VIEW_KEY);
  } catch {
    /* private mode */
  }
}

const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The rows' height under the grid's sticky time ruler, so a row "at the top" isn't hidden under it. */
const stickyTop = (box: HTMLElement) => box.querySelector<HTMLElement>('.lg-ruler')?.offsetHeight ?? 0;

/** The owner's channels with what's on: a grid on a wide screen, a list on a narrow one. A tap on a channel starts it on the TV. */
export function LiveTv() {
  const [, navigate] = useLocation();
  const lastAt = useStore(status)?.live.lastAt;
  const tv = useTv();
  const [channels, setChannels] = useState<LiveChannel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState(() => gridStart(Date.now()));
  const [now, setNow] = useState(Date.now);
  const [size, setSize] = useState(screenSize);
  const [override, setOverride] = useState(readOverride);
  const [open, setOpen] = useState<Open | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const anchor = useRef<string | null>(null);
  const frame = useRef(0);
  const plays = useRef(0);
  const shownFrom = useRef(from);
  const view = liveView(size, override);

  // The guide: now, every 5 minutes, and after each refresh of the lists and guides.
  useEffect(() => {
    let gone = false;
    const load = () =>
      api.get<{ channels: LiveChannel[] }>(`/api/livetv/guide?from=${from}`).then(
        (r) => {
          if (gone) return;
          setChannels(r.channels);
          setError(null);
        },
        (e: Error) => !gone && setError(e.message),
      );
    void load();
    const t = setInterval(load, 5 * 60_000);
    return () => {
      gone = true;
      clearInterval(t);
    };
  }, [from, lastAt]);

  // The now line and progress move; a page left open for hours moves its window on (and reloads the guide for it).
  useEffect(() => {
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      setFrom((f) => gridFrom(f, n));
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  // The grid's window moved on: the times in view stay in view.
  useLayoutEffect(() => {
    const box = scroller.current;
    if (box && from !== shownFrom.current) box.scrollLeft -= ((from - shownFrom.current) / 60_000) * PX_PER_MIN;
    shownFrom.current = from;
  }, [from]);

  // A new screen shape (rotating, resizing) ends the switch: back to the view that fits.
  useEffect(() => {
    const onResize = () => {
      const n = screenSize();
      setSize((s) => (s.w === n.w && s.h === n.h ? s : n));
      setOverride((o) => {
        if (!o || (o.w === n.w && o.h === n.h)) return o;
        writeOverride(null);
        return null;
      });
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  /** The first channel in view, kept so a change of view or of screen shows the same channels. */
  const noteAnchor = () => {
    const box = scroller.current;
    if (!box) return;
    const top = box.getBoundingClientRect().top + stickyTop(box);
    for (const row of box.querySelectorAll<HTMLElement>('[data-key]')) {
      if (row.getBoundingClientRect().bottom > top + 1) {
        anchor.current = row.dataset.key ?? null;
        return;
      }
    }
  };
  const onScroll = () => {
    if (!frame.current)
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        noteAnchor();
      });
  };
  useLayoutEffect(() => {
    const box = scroller.current;
    const key = anchor.current;
    if (!box || !key) return;
    const row = box.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    if (row) box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top - stickyTop(box);
  }, [view, size.w, size.h]);

  const flip = (v: LiveView) => {
    noteAnchor();
    const s = screenSize();
    const o = { view: v, ...s };
    setSize(s);
    setOverride(o);
    writeOverride(o);
  };

  const play = async (ch: LiveChannel) => {
    const n = ++plays.current;
    const onTv = tvChoice.get();
    try {
      await api.post(`/api/livetv/${encodeURIComponent(ch.key)}/play`);
    } catch (e) {
      toast((e as Error).message, 'error');
      return;
    }
    toast(`Starting ${ch.name} on ${tv?.name ?? 'the TV'}`);
    // Kodi keeps a player while a stream fails: ask the TV whether it really plays, unless another play came since.
    setTimeout(() => {
      if (n !== plays.current || onTv !== tvChoice.get()) return;
      api.get<{ playing: boolean }>(`/api/livetv/${encodeURIComponent(ch.key)}/playing`).then(
        (r) => !r.playing && n === plays.current && toast(`${ch.name} didn't start: its stream may be down`, 'error'),
        () => {},
      );
    }, PLAY_CHECK_MS);
  };

  let body;
  if (!channels) body = error ? <p className="error-text pad">{error}</p> : <p className="hint pad">Loading the guide…</p>;
  else if (!channels.length)
    body = (
      <div className="empty">
        <h2>No channels yet</h2>
        <p>Pick the channels you watch in Settings, and they show here with what's on.</p>
        <button className="btn primary" onClick={() => navigate('/settings')}>
          Open Settings
        </button>
      </div>
    );
  else if (view === 'grid') body = <Grid channels={channels} from={from} now={now} onPlay={play} onOpen={(ch, p) => setOpen({ ch, p })} />;
  else body = <List channels={channels} now={now} onPlay={play} onOpen={(ch, p) => setOpen({ ch, p })} />;

  return (
    <div className="live">
      <header className="page-head live-head">
        <div className="head-row">
          <h1>Live TV</h1>
          <div className="live-head-tools">
            <div className="segmented" role="radiogroup" aria-label="View">
              {(['grid', 'list'] as const).map((v) => (
                <button key={v} role="radio" aria-checked={view === v} onClick={() => flip(v)}>
                  {v === 'grid' ? 'Grid' : 'List'}
                </button>
              ))}
            </div>
            <ProfileBadge />
          </div>
        </div>
      </header>
      <div className={`scroller live-scroll live-${view}`} ref={scroller} onScroll={onScroll}>
        {body}
      </div>
      {open && <Details {...open} now={now} onPlay={play} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ChannelLogo({ ch }: { ch: LiveChannel }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="live-logo" aria-hidden="true">
      {ch.logo && !failed ? <img src={ch.logo} alt="" loading="lazy" onError={() => setFailed(true)} /> : <b>{ch.name.slice(0, 4)}</b>}
    </span>
  );
}

type ViewProps = { channels: LiveChannel[]; now: number; onPlay: (ch: LiveChannel) => void; onOpen: (ch: LiveChannel, p?: LiveProgramme) => void };

/** Channels down the left (pinned), time across from `from`, a red line for now. */
function Grid({ channels, from, now, onPlay, onOpen }: ViewProps & { from: number }) {
  const to = from + GRID_SPAN;
  const px = (t: number) => ((t - from) / 60_000) * PX_PER_MIN;
  const marks: number[] = [];
  for (let t = from; t < to; t += HALF_HOUR) marks.push(t);
  return (
    <div className="lg" style={{ '--lg-w': `${px(to)}px` } as CSSProperties}>
      <div className="lg-ruler">
        <div className="lg-corner" />
        <div className="lg-times">
          {marks.map((t) => (
            <span key={t} style={{ left: px(t) }}>
              {hm(t)}
            </span>
          ))}
        </div>
      </div>
      <div className="lg-body">
        {channels.map((ch) => (
          <div className="lg-row" key={ch.key} data-key={ch.key}>
            <button className="lg-ch" title={`Watch ${ch.name} on TV`} onClick={() => onPlay(ch)}>
              <ChannelLogo ch={ch} />
              <span className="lg-name">{ch.name}</span>
            </button>
            <div className="lg-progs">
              {ch.programmes.length === 0 ? (
                <button className="lg-none" onClick={() => onOpen(ch)}>
                  No guide for this channel
                </button>
              ) : (
                ch.programmes.map((p) => {
                  const s = gridSpan(p, from, to, PX_PER_MIN);
                  if (!s) return null;
                  const when = p.stop <= now ? ' past' : p.start <= now ? ' on' : '';
                  return (
                    <button key={p.start} className={`lg-prog${when}`} style={{ left: s.left, width: Math.max(s.width - 3, 1) }} onClick={() => onOpen(ch, p)}>
                      <b>{p.title}</b>
                      <span>{hm(p.start)}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        ))}
        <div className="lg-now" style={{ left: `calc(var(--lg-ch) + ${px(now)}px)` }} />
      </div>
    </div>
  );
}

/** One row per channel: what's on, how far in, until when, and what's next. */
function List({ channels, now, onPlay, onOpen }: ViewProps) {
  return (
    <ul className="ll">
      {channels.map((ch) => {
        const { now: on, next, progress } = nowAndNext(ch.programmes, now);
        return (
          <li className="ll-row" key={ch.key} data-key={ch.key}>
            <button className="ll-main" title={`Watch ${ch.name} on TV`} onClick={() => onPlay(ch)}>
              <ChannelLogo ch={ch} />
              <span className="ll-text">
                <span className="ll-ch">
                  {ch.number} · {ch.name}
                </span>
                <b className={`ll-title${on ? '' : ' muted'}`}>{on?.title ?? (ch.programmes.length ? 'Nothing in the guide now' : 'No guide for this channel')}</b>
                {on && (
                  <span className="ll-progress">
                    <span className="ll-bar">
                      <i style={{ width: `${progress * 100}%` }} />
                    </span>
                    until {hm(on.stop)}
                  </span>
                )}
                {next && (
                  <span className="ll-next">
                    {hm(next.start)} · {next.title}
                  </span>
                )}
              </span>
            </button>
            <button className="icon-btn ll-info" aria-label={`About ${on?.title ?? ch.name}`} onClick={() => onOpen(ch, on)}>
              <IconInfo />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** A programme (or a channel without one): what it is, and watching it when it's on now. */
function Details({ ch, p, now, onPlay, onClose }: Open & { now: number; onPlay: (ch: LiveChannel) => void; onClose: () => void }) {
  const onNow = !p || (p.start <= now && now < p.stop);
  return (
    <Sheet title={p?.title ?? ch.name} onClose={onClose}>
      {p?.icon && <img className="live-pic" src={p.icon} alt="" onError={(e) => (e.currentTarget.hidden = true)} />}
      {p?.sub && <p className="live-sub">{p.sub}</p>}
      <p className="muted">
        {ch.number} · {ch.name}
        {p && ` · ${hm(p.start)} – ${hm(p.stop)}`}
        {p?.category && ` · ${p.category}`}
      </p>
      {!p && <p className="muted">{ch.programmes.length ? 'Nothing in the guide now.' : 'No guide for this channel.'}</p>}
      {p?.descr && <p className="live-descr">{p.descr}</p>}
      {onNow && (
        <div className="live-actions">
          <button
            className="btn primary big"
            onClick={() => {
              onClose();
              void onPlay(ch);
            }}
          >
            <IconPlay size={20} />
            Watch on TV
          </button>
          {isIOS && (
            <a className="btn big" href={liveVlcHref(location.origin, ch, vlcBack())}>
              <IconDevice size={20} />
              Watch on phone
            </a>
          )}
        </div>
      )}
      {onNow && isIOS && (
        <p className="hint">
          Watch on phone plays the channel in the free{' '}
          <a href={VLC_APP_STORE} target="_blank" rel="noreferrer">
            VLC app
          </a>
          , straight from its source.
        </p>
      )}
    </Sheet>
  );
}
