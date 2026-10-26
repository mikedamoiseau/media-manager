import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { api } from '../api.ts';
import { useStore, nowPlaying, nowPlayingError, status, tvChoice, useTv } from '../store.ts';
import type { NowPlaying } from '../types.ts';
import { send } from './Remote.tsx';
import { Sheet } from './Sheet.tsx';
import { IconCheck, IconDown, IconPause, IconPlay, IconTv } from './icons.tsx';

/**
 * The bar above the tabs: this device's TV and what it plays. Tap it for the remote, ▾ for another TV.
 * On the Remote, whose card shows what plays, it is only there to switch TV.
 */
export function TvBar({ onRemote }: { onRemote: boolean }) {
  const st = useStore(status);
  const tv = useTv();
  const np = useStore(nowPlaying);
  const error = useStore(nowPlayingError);
  const [, navigate] = useLocation();
  const [picking, setPicking] = useState(false);
  const several = (st?.tvs.length ?? 0) > 1;
  if (!tv || (onRemote && !several)) return null;
  const active = !onRemote && !!np?.active;
  const playing = active && (np.speed ?? 0) !== 0;
  const pct = active && np.total ? ((np.time ?? 0) / np.total) * 100 : 0;
  const state = onRemote ? '' : error ? 'Not answering' : np ? 'Ready' : '';
  return (
    <>
      <div className="np-bar">
        <button className="np-bar-main" onClick={() => (onRemote ? setPicking(true) : navigate('/remote'))}>
          {active ? <span className="np-live" aria-hidden="true" /> : <IconTv size={18} />}
          <span className="np-bar-text">
            <strong>{active ? np.title : tv.name}</strong>
            {active ? <span>{np.showTitle ? `${tv.name}, ${np.showTitle}` : tv.name}</span> : state && <span>{state}</span>}
          </span>
        </button>
        {active && (
          <button className="icon-btn" onClick={() => void send('playpause')} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <IconPause /> : <IconPlay />}
          </button>
        )}
        {several && (
          <button className="icon-btn" onClick={() => setPicking(true)} aria-label={`Control another TV (now ${tv.name})`}>
            <IconDown />
          </button>
        )}
        {active && <span className="np-bar-progress" style={{ width: `${pct}%` }} />}
      </div>
      {picking && <TvPicker onClose={() => setPicking(false)} />}
    </>
  );
}

/** The TVs, each with what it plays: the one tapped is the one this device controls from now on. */
function TvPicker({ onClose }: { onClose: () => void }) {
  const st = useStore(status);
  const tv = useTv();
  const tvs = st?.tvs ?? [];
  // What each TV plays, asked when the list opens.
  const [now, setNow] = useState<Record<string, NowPlaying | 'off'>>({});
  const ids = tvs.map((t) => t.id).join(',');
  useEffect(() => {
    let live = true;
    for (const id of ids.split(',').filter(Boolean)) {
      api.get<NowPlaying>(`/api/kodi/now?tv=${encodeURIComponent(id)}`).then(
        (np) => live && setNow((m) => ({ ...m, [id]: np })),
        () => live && setNow((m) => ({ ...m, [id]: 'off' })),
      );
    }
    return () => {
      live = false;
    };
  }, [ids]);

  return (
    <Sheet title="Control which TV?" onClose={onClose}>
      <ul className="tracks" role="radiogroup" aria-label="TVs">
        {tvs.map((t) => {
          const np = now[t.id];
          const line = np === undefined ? '' : np === 'off' ? 'Not answering' : np.active ? `Playing ${np.title ?? 'something'}` : 'Ready';
          return (
            <li key={t.id}>
              <button
                className={`track has-icon${np === 'off' ? ' is-off' : ''}`}
                role="radio"
                aria-checked={t.id === tv?.id}
                onClick={() => {
                  tvChoice.set(t.id);
                  onClose();
                }}
              >
                <IconTv size={20} />
                <span className="track-text">
                  <span className="track-label">{t.name}</span>
                  <span className="track-detail">{line || ' '}</span>
                </span>
                {t.id === tv?.id && <IconCheck size={20} className="track-end" />}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="hint">Add, rename or remove TVs in Settings.</p>
    </Sheet>
  );
}
