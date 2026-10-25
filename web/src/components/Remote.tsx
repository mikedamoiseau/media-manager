import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { useStore, nowPlaying, status, toast, startFastPoll, pollNowPlaying, typingForKodi } from '../store.ts';
import { formatClock } from '../search.ts';
import { languageName } from '../tracks.ts';
import { TrackPicker } from './TrackPicker.tsx';
import { isIOS, handoffLink, vlcBack } from '../vlc.ts';
import { sliderKey } from '../sliderKeys.ts';
import { PowerMenu } from './PowerMenu.tsx';
import {
  IconUp, IconDown, IconLeft, IconRight, IconBack, IconHome, IconInfo, IconMenu, IconPlay, IconPause, IconStop,
  IconSkipBack, IconSkipFwd, IconVolume, IconMute, IconSubtitles, IconAudio, IconTv, IconPower, IconKeyboard, IconPhone,
} from './icons.tsx';

export async function send(action: string, value?: number) {
  try {
    await api.post('/api/kodi/remote', { action, value });
    if (navigator.vibrate) navigator.vibrate(8);
    setTimeout(() => void pollNowPlaying(), 250);
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

const KEYS: Record<string, string> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'select', Backspace: 'back', Escape: 'back',
  ' ': 'playpause', i: 'info', c: 'menu', h: 'home',
};

export function Remote() {
  const np = useStore(nowPlaying);
  const st = useStore(status);
  const [picker, setPicker] = useState<'audio' | 'subtitles' | null>(null);
  const [powerMenu, setPowerMenu] = useState(false);

  useEffect(() => startFastPoll(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Keys belong to an open sheet (track picker), not to the TV.
      if ((e.target as HTMLElement).tagName === 'INPUT' || document.querySelector('[aria-modal="true"]')) return;
      const a = KEYS[e.key];
      if (a) {
        e.preventDefault();
        void send(a);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!st?.kodi.host) {
    return (
      <div className="scroller">
        <header className="page-head">
          <h1>Remote</h1>
        </header>
        <div className="empty">
          <IconTv size={40} />
          <h2>No Kodi connected</h2>
          <p>Open Settings and tap “Find Kodi”. In Kodi, “Allow remote control via HTTP” must be on (Settings › Services › Control).</p>
        </div>
      </div>
    );
  }

  const active = np?.active;
  const playing = active && (np.speed ?? 0) !== 0;
  // The link is ready before the tap: Safari opens VLC only straight from a tap.
  const handoff = isIOS && active ? handoffLink(location.origin, np, vlcBack(), Date.now().toString(36)) : null;

  return (
    <>
      <div className="scroller remote">
        <section className={`np-card${active ? '' : ' is-idle'}`}>
          {active && np.fanart && <img className="np-fanart" src={`/api/img?w=780&u=${encodeURIComponent(np.fanart)}`} alt="" aria-hidden="true" />}
          <div className="np-inner">
            {active ? (
              <>
                <p className="np-label">{np.showTitle ? `${np.showTitle}${np.season ? `, season ${np.season}` : ''}${np.episode ? ` episode ${np.episode}` : ''}` : 'Now playing'}</p>
                <h1 className="np-title">{np.title}</h1>
                <TouchSlider
                  value={np.time ?? 0}
                  max={np.total ?? 0}
                  label="Position"
                  valueText={(t) => `${formatClock(t)} of ${formatClock(np.total)}`}
                  tip={formatClock}
                  steps={{ back: 10, forward: 30 }}
                  onPick={(t) => send('seek', (t / (np.total || 1)) * 100)}
                >
                  {(t) => (
                    <div className="np-times">
                      <span>{formatClock(t)}</span>
                      <span>-{formatClock((np.total ?? 0) - t)}</span>
                    </div>
                  )}
                </TouchSlider>
                {handoff && (
                  <a className="btn np-handoff" href={handoff}>
                    <IconPhone size={18} />
                    Continue on this device
                  </a>
                )}
              </>
            ) : (
              <>
                <p className="np-label">{st.kodi.connected ? 'Kodi is ready' : 'Kodi is not answering'}</p>
                <h1 className="np-title">Nothing playing</h1>
                <p className="muted small">Pick something in the library and press Play on TV.</p>
              </>
            )}
          </div>
          {st.kodi.connected && (
            <button className="icon-btn on-image np-power" onClick={() => setPowerMenu(true)} aria-label="Shut down or restart the Kodi box">
              <IconPower />
            </button>
          )}
        </section>

        <div className="transport" aria-label="Playback">
          <button className="round" onClick={() => void send('rewind')} aria-label="Back 10 seconds" disabled={!active}>
            <IconSkipBack />
          </button>
          <button className="round big" onClick={() => void send('playpause')} aria-label={playing ? 'Pause' : 'Play'} disabled={!active}>
            {playing ? <IconPause size={30} /> : <IconPlay size={30} />}
          </button>
          <button className="round" onClick={() => void send('forward')} aria-label="Forward 30 seconds" disabled={!active}>
            <IconSkipFwd />
          </button>
          <button className="round" onClick={() => void send('stop')} aria-label="Stop" disabled={!active}>
            <IconStop />
          </button>
        </div>

        <div className="dpad" aria-label="Navigation">
          <button className="dpad-up" onClick={() => void send('up')} aria-label="Up">
            <IconUp size={30} />
          </button>
          <button className="dpad-left" onClick={() => void send('left')} aria-label="Left">
            <IconLeft size={30} />
          </button>
          <button className="dpad-ok" onClick={() => void send('select')}>
            OK
          </button>
          <button className="dpad-right" onClick={() => void send('right')} aria-label="Right">
            <IconRight size={30} />
          </button>
          <button className="dpad-down" onClick={() => void send('down')} aria-label="Down">
            <IconDown size={30} />
          </button>
        </div>

        <div className="remote-keys">
          <button onClick={() => void send('back')}>
            <IconBack /> <span>Back</span>
          </button>
          <button onClick={() => void send('home')}>
            <IconHome /> <span>Home</span>
          </button>
          <button onClick={() => void send('info')}>
            <IconInfo /> <span>Info</span>
          </button>
          <button onClick={() => void send(active ? 'osd' : 'menu')}>
            <IconMenu /> <span>{active ? 'Menu' : 'Options'}</span>
          </button>
        </div>

        <div className="remote-keys">
          <button onClick={() => setPicker('subtitles')} disabled={!active}>
            <IconSubtitles />{' '}
            <span>{active && np.subtitlesOn && np.subtitle ? languageName(np.subtitle.language) : active ? 'Subtitles off' : 'Subtitles'}</span>
          </button>
          <button onClick={() => setPicker('audio')} disabled={!active}>
            <IconAudio /> <span>{active && np.audio ? languageName(np.audio.language) : 'Audio'}</span>
          </button>
          <button onClick={() => typingForKodi.set(true)}>
            <IconKeyboard /> <span>Keyboard</span>
          </button>
        </div>

        <div className="volume">
          <button className="icon-btn" onClick={() => void send('mute')} aria-label={np?.muted ? 'Unmute' : 'Mute'}>
            {np?.muted ? <IconMute /> : <IconVolume />}
          </button>
          <TouchSlider
            value={np?.volume ?? 0}
            max={100}
            label="Volume"
            valueText={(v) => String(Math.round(v))}
            steps={{ back: 5, forward: 5 }}
            onPick={(v) => send('volume', Math.round(v))}
          >
            {(v) => <span className="vol-num">{Math.round(v)}</span>}
          </TouchSlider>
        </div>
      </div>
      {/* Outside .remote: its children are width-capped, the sheet backdrop must cover the screen. */}
      {picker && <TrackPicker kind={picker} onClose={() => setPicker(null)} />}
      {powerMenu && <PowerMenu playing={!!active} onClose={() => setPowerMenu(false)} />}
    </>
  );
}

/**
 * A bar to tap or drag along, for the position and the volume. Not the browser's slider: on the iPhone
 * that one moves only by its small knob, and a tap on the bar does nothing. `onPick` runs once, when you
 * let go (or press a key); the picked value stays shown until Kodi reports it. `children`: what goes
 * with the bar, drawn with the value shown.
 */
function TouchSlider({ value, max, label, valueText, tip, steps, onPick, children }: {
  value: number;
  max: number;
  label: string;
  valueText: (v: number) => string;
  tip?: (v: number) => string;
  steps: { back: number; forward: number };
  onPick: (v: number) => Promise<void>;
  children: (v: number) => ReactNode;
}) {
  // While dragging, and for a moment after, until Kodi reports it.
  const [to, setTo] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const touch = useRef(0);
  const at = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * max : 0;
  };
  const shown = Math.min(max, to ?? value);
  const pick = (v: number) => {
    const n = ++touch.current;
    setTo(v);
    // send() polls Kodi 250 ms after: show the pick until then, not the old value.
    void onPick(v).finally(() =>
      setTimeout(() => {
        if (touch.current === n) setTo(null);
      }, 1000),
    );
  };

  return (
    <>
      <div
        className={`slider${dragging ? ' is-dragging' : ''}`}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={Math.round(max)}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={valueText(shown)}
        style={{ '--pct': `${max ? (shown / max) * 100 : 0}%` } as React.CSSProperties}
        onPointerDown={(e) => {
          if (!max || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          touch.current++;
          setDragging(true);
          setTo(at(e));
        }}
        onPointerMove={(e) => {
          if (dragging) setTo(at(e));
        }}
        onPointerUp={(e) => {
          if (!dragging) return;
          setDragging(false);
          pick(at(e));
        }}
        onPointerCancel={() => {
          touch.current++;
          setDragging(false);
          setTo(null);
        }}
        onKeyDown={(e) => {
          // The bar's keys, not Kodi's cursor (the Remote's keys listen on window).
          const v = max ? sliderKey(e.key, shown, { max, ...steps }) : null;
          if (v === null) return;
          e.preventDefault();
          e.stopPropagation();
          pick(v);
        }}
      >
        <span className="slider-fill" />
        <span className="slider-knob" />
        {dragging && tip && <span className="slider-tip">{tip(shown)}</span>}
      </div>
      {children(shown)}
    </>
  );
}
