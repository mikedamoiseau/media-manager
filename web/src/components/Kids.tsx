import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useStore, nowPlaying, startFastPoll, useTv, status, toast } from '../store.ts';
import { send } from './Remote.tsx';
import { TrackPicker } from './TrackPicker.tsx';
import { ProfileBadge } from './WhosWatching.tsx';
import { languageName } from '../tracks.ts';
import { IconAudio, IconClose, IconMinus, IconPause, IconPlay, IconPlus, IconStop, IconSubtitles, IconVolume } from './icons.tsx';

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/**
 * The parents' code, typed on big keys. `onCode` gets the 4 digits and says whether they were right; a
 * wrong code is cleared to try again.
 */
export function CodePad({ title, onCode, onCancel }: { title: string; onCode: (code: string) => Promise<boolean>; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [wrong, setWrong] = useState(false);
  // Digits typed faster than the screen updates all count: kept here, not read from the last render.
  const typed = useRef('');
  const checking = useRef(false);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  const show = (c: string) => {
    typed.current = c;
    setCode(c);
  };
  const type = async (d: string) => {
    if (checking.current || typed.current.length >= 4) return;
    const next = typed.current + d;
    setWrong(false);
    show(next);
    if (next.length < 4) return;
    checking.current = true;
    const ok = await onCode(next);
    checking.current = false;
    if (!ok) {
      setWrong(true);
      show('');
    }
  };
  const erase = () => !checking.current && show(typed.current.slice(0, -1));
  const keys = useRef({ type, erase });
  keys.current = { type, erase };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) void keys.current.type(e.key);
      else if (e.key === 'Backspace') keys.current.erase();
      else if (e.key === 'Escape') cancel.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="code-pad" role="dialog" aria-modal="true" aria-labelledby="code-title">
      <button className="icon-btn whos-close" onClick={onCancel} aria-label="Cancel">
        <IconClose />
      </button>
      <h1 id="code-title">{title}</h1>
      <div className={`code-dots${wrong ? ' wrong' : ''}`} aria-live="polite" aria-label={wrong ? 'Wrong code' : `${code.length} of 4 digits`}>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={i < code.length ? 'on' : ''} />
        ))}
      </div>
      <p className="code-msg" role="status">{wrong ? 'Wrong code' : ' '}</p>
      <div className="code-keys">
        {DIGITS.map((d) => (
          <button key={d} onClick={() => void type(d)}>
            {d}
          </button>
        ))}
        <span />
        <button onClick={() => void type('0')}>0</button>
        <button onClick={erase} aria-label="Delete">
          ⌫
        </button>
      </div>
    </div>
  );
}

/** Kids mode's remote: what plays on this phone's TV, if it is one of the kid's titles, and the few controls kids need. */
export function KidsPlaying() {
  const np = useStore(nowPlaying);
  const tv = useTv();
  const [picker, setPicker] = useState<'audio' | 'subtitles' | null>(null);
  useEffect(() => startFastPoll(), []);

  const mine = !!tv && !!np?.active && !np.hidden;
  const playing = mine && (np.speed ?? 0) !== 0;
  const volume = np?.volume ?? 0;
  const audio = np?.audio ? languageName(np.audio.language) : 'Language';
  const subtitles = np?.subtitlesOn && np.subtitle ? languageName(np.subtitle.language) : 'Off';

  return (
    <>
      <div className="scroller remote kids-playing">
        <div className="remote-top">
          <ProfileBadge />
        </div>
        <section className={`np-card${mine ? '' : ' is-idle'}`}>
          {mine && np.fanart && <img className="np-fanart" src={`/api/img?w=780&u=${encodeURIComponent(np.fanart)}`} alt="" aria-hidden="true" />}
          <div className="np-inner">
            {mine ? (
              <>
                <p className="np-label">{np.showTitle ? `${np.showTitle}${np.episode ? `, episode ${np.episode}` : ''}` : 'Now playing'}</p>
                <h1 className="np-title">{np.title}</h1>
              </>
            ) : !tv ? (
              <>
                <h1 className="np-title">No TV</h1>
                <p className="muted small">Ask a grown-up to connect the TV.</p>
              </>
            ) : np?.hidden ? (
              <h1 className="np-title">Something else is playing on {tv.name}</h1>
            ) : (
              <>
                <p className="np-label">{tv.name}</p>
                <h1 className="np-title">Nothing playing</h1>
                <p className="muted small">Pick something in the library and press Play on TV.</p>
              </>
            )}
          </div>
        </section>

        {mine && (
          <>
            <div className="kids-keys" aria-label="Playback">
              <button className="round big" onClick={() => void send('playpause')} aria-label={playing ? 'Pause' : 'Play'}>
                {playing ? <IconPause size={40} /> : <IconPlay size={40} />}
              </button>
              <button className="round big stop" onClick={() => void send('stop')} aria-label="Stop">
                <IconStop size={34} />
              </button>
            </div>
            <div className="kids-volume" aria-label="Volume">
              <button className="round" onClick={() => void send('volume', Math.max(0, Math.round(volume) - 10))} aria-label="Quieter">
                <IconMinus />
              </button>
              <span className="kids-vol">
                <IconVolume size={20} />
                <output aria-live="polite">{Math.round(volume)}</output>
              </span>
              <button className="round" onClick={() => void send('volume', Math.min(100, Math.round(volume) + 10))} aria-label="Louder">
                <IconPlus />
              </button>
            </div>
            <div className="kids-tracks">
              <button className="btn big" onClick={() => setPicker('audio')} aria-label={`Language: ${audio}`}>
                <IconAudio /> {audio}
              </button>
              <button className="btn big" onClick={() => setPicker('subtitles')} aria-label={`Subtitles: ${subtitles}`}>
                <IconSubtitles /> {subtitles}
              </button>
            </div>
          </>
        )}
      </div>
      {picker && <TrackPicker kind={picker} onClose={() => setPicker(null)} />}
    </>
  );
}

type ForKids = { override: 'ok' | 'no' | null; kids: Array<{ id: number; name: string; allowed: boolean }> };

const CALLS: Array<{ value: ForKids['override']; label: string }> = [
  { value: null, label: 'Automatic' },
  { value: 'ok', label: 'OK for kids' },
  { value: 'no', label: 'Not for kids' },
];

/** A title's page, for parents: their call on it for every kids profile, and who can watch it. */
export function KidsForTitle({ id }: { id: number }) {
  const [state, setState] = useState<ForKids | null>(null);
  // A kid's age limit changed, or a kid was added: who can watch it again.
  const kidsShape = JSON.stringify(useStore(status)?.profiles.filter((p) => p.kids).map((p) => [p.id, p.name, p.maxAge]) ?? []);
  useEffect(() => {
    let alive = true;
    api.get<ForKids>(`/api/kids/items/${id}`).then(
      (r) => alive && setState(r),
      () => alive && setState(null),
    );
    return () => {
      alive = false;
    };
  }, [id, kidsShape]);
  if (!state) return null;

  const pick = async (value: ForKids['override']) => {
    try {
      setState(await api.put<ForKids>(`/api/kids/items/${id}`, { value }));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <section className="for-kids">
      <h2 className="section-title">For kids</h2>
      <div className="segmented" role="radiogroup" aria-label="For kids">
        {CALLS.map((c) => (
          <button key={c.label} role="radio" aria-checked={state.override === c.value} onClick={() => void pick(c.value)}>
            {c.label}
          </button>
        ))}
      </div>
      <ul>
        {state.kids.map((k) => (
          <li key={k.id} className={k.allowed ? 'is-ok' : ''}>
            {k.name}: {k.allowed ? 'can watch it' : "can't watch it"}
          </li>
        ))}
      </ul>
    </section>
  );
}
