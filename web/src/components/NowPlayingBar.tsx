import { useLocation } from 'wouter';
import { useStore, nowPlaying } from '../store.ts';
import { send } from './Remote.tsx';
import { IconPause, IconPlay } from './icons.tsx';

/** Slim bar above the tabs while Kodi plays something; tap to open the remote. */
export function NowPlayingBar() {
  const np = useStore(nowPlaying);
  const [, navigate] = useLocation();
  if (!np?.active) return null;
  const pct = np.total ? ((np.time ?? 0) / np.total) * 100 : 0;
  const playing = (np.speed ?? 0) !== 0;
  return (
    <div className="np-bar">
      <button className="np-bar-main" onClick={() => navigate('/remote')}>
        <span className="np-live" aria-hidden="true" />
        <span className="np-bar-text">
          <strong>{np.title}</strong>
          {np.showTitle && <span>{np.showTitle}</span>}
        </span>
      </button>
      <button className="icon-btn" onClick={() => void send('playpause')} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? <IconPause /> : <IconPlay />}
      </button>
      <span className="np-bar-progress" style={{ width: `${pct}%` }} />
    </div>
  );
}
