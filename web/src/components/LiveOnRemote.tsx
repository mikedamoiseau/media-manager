import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { tvChoice } from '../store.ts';
import { nowAndNext, zapTarget, hm } from '../liveTv.ts';
import { playChannel } from '../livePlay.ts';
import { ChannelLogo } from './LiveTv.tsx';
import { IconMinus, IconPlus } from './icons.tsx';
import type { LiveChannel } from '../types.ts';

/** Taps on − and + add up: the TV is told this long after the last one. */
const ZAP_WAIT_MS = 700;
/** A channel just asked for is counted from until the TV reports it, or this long (Kodi takes seconds to switch). */
const ASKED_MS = 15_000;

/** A live channel's backdrop on the Remote's card: the picture of the programme on now, from the guide. */
export function LiveBackdrop({ live }: { live: LiveChannel }) {
  const icon = nowAndNext(live.programmes, Date.now()).now?.icon;
  return icon ? <img key={icon} className="np-fanart" src={icon} alt="" aria-hidden="true" onError={(e) => (e.currentTarget.hidden = true)} /> : null;
}

/** The Remote's card while one of the owner's channels plays: the channel, what's on and how far in, what's next. */
export function LiveCard({ live }: { live: LiveChannel }) {
  const { now: on, next, progress } = nowAndNext(live.programmes, Date.now());
  return (
    <>
      <p className="np-label np-channel">
        <ChannelLogo ch={live} />
        {live.number} · {live.name}
      </p>
      <h1 className="np-title">{on?.title ?? live.name}</h1>
      {on?.sub && <p className="np-sub">{on.sub}</p>}
      {on && (
        <p className="np-prog">
          <span className="ll-bar">
            <i style={{ width: `${progress * 100}%` }} />
          </span>
          {hm(on.start)} – {hm(on.stop)}
        </p>
      )}
      {on?.descr && <p className="np-descr">{on.descr}</p>}
      {next && (
        <p className="np-next">
          Next: {hm(next.start)} · {next.title}
        </p>
      )}
    </>
  );
}

/**
 * CH − and +, as on a TV remote: one channel along the owner's numbering per tap, round past either end. Taps add
 * up, the row shows where they lead, and the TV changes once, after the last. Page Up and Page Down do the same.
 */
export function ChannelZap({ live, tvName }: { live: LiveChannel; tvName?: string }) {
  const [channels, setChannels] = useState<LiveChannel[] | null>(null);
  const [to, setTo] = useState<LiveChannel | null>(null);
  const toRef = useRef<LiveChannel | null>(null);
  const asked = useRef<{ key: string; at: number } | null>(null);
  const timer = useRef(0);

  // The owner's channels with what's on, the next hour (it holds what's on until the next load): where the taps lead.
  useEffect(() => {
    let gone = false;
    const load = () => {
      const now = Date.now();
      api.get<{ channels: LiveChannel[] }>(`/api/livetv/guide?from=${now}&to=${now + 3_600_000}`).then(
        (r) => !gone && setChannels(r.channels),
        () => {},
      );
    };
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => {
      gone = true;
      clearInterval(t);
    };
  }, []);
  // Taps not yet sent go with the row (the Remote left, or nothing plays any more).
  useEffect(() => () => clearTimeout(timer.current), []);

  // Taps right after a switch count from the channel asked for, not the one the TV still shows.
  const a = asked.current;
  const from = a && a.key !== live.key && Date.now() - a.at < ASKED_MS ? a.key : live.key;

  // Not sent when this device took another TV meanwhile: the taps were for the first.
  const tap = (step: 1 | -1) => {
    const next = channels && zapTarget(channels, toRef.current?.key ?? from, step);
    if (!next) return;
    const onTv = tvChoice.get();
    toRef.current = next;
    setTo(next);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      toRef.current = null;
      setTo(null);
      // All the way round: already there.
      if (next.key === from || tvChoice.get() !== onTv) return;
      asked.current = { key: next.key, at: Date.now() };
      void playChannel(next, tvName).then((ok) => {
        if (!ok && asked.current?.key === next.key) asked.current = null;
      });
    }, ZAP_WAIT_MS);
  };
  const tapRef = useRef(tap);
  tapRef.current = tap;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || document.querySelector('[aria-modal="true"]')) return;
      const step = e.key === 'PageUp' ? 1 : e.key === 'PageDown' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      tapRef.current(step);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const shown = to ?? channels?.find((c) => c.key === from) ?? live;
  return (
    <div className="zap" role="group" aria-label="Channels">
      <button className="round" onClick={() => tap(-1)} aria-label="Previous channel" disabled={!channels}>
        <IconMinus />
      </button>
      <div className={`zap-to${to ? ' is-pending' : ''}`} aria-live="polite">
        <span className="zap-num">
          <span className="zap-label">CH</span> {shown.number}
        </span>
        {to && (
          <>
            <span className="zap-name">{to.name}</span>
            <span className="zap-on">{nowAndNext(to.programmes, Date.now()).now?.title ?? ''}</span>
          </>
        )}
      </div>
      <button className="round" onClick={() => tap(1)} aria-label="Next channel" disabled={!channels}>
        <IconPlus />
      </button>
    </div>
  );
}
