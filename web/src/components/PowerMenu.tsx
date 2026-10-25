import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { toast, pollNowPlaying } from '../store.ts';
import { Sheet } from './Sheet.tsx';
import { IconPower, IconRefresh } from './icons.tsx';

type PowerAction = 'shutdown' | 'reboot';

const ACTIONS: Record<PowerAction, { label: string; detail: string; question: string; done: string; Icon: typeof IconPower }> = {
  shutdown: {
    label: 'Shut down',
    detail: 'Turns the box off. Switch it back on with its remote or power button.',
    question: 'Shut down the Kodi box?',
    done: 'The Kodi box is shutting down',
    Icon: IconPower,
  },
  reboot: {
    label: 'Restart',
    detail: 'Kodi is back after a minute or two.',
    question: 'Restart the Kodi box?',
    done: 'The Kodi box is restarting',
    Icon: IconRefresh,
  },
};

/** Shut down or restart the box running Kodi; only what Kodi says it allows, and always confirmed. */
export function PowerMenu({ playing, onClose }: { playing: boolean; onClose: () => void }) {
  const [options, setOptions] = useState<Record<PowerAction, boolean> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PowerAction | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Record<PowerAction, boolean>>('/api/kodi/power').then(setOptions, (e: Error) => setError(e.message));
  }, []);

  const run = async (action: PowerAction) => {
    setBusy(true);
    try {
      await api.post('/api/kodi/power', { action });
      toast(ACTIONS[action].done);
      setTimeout(() => void pollNowPlaying(), 2000);
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };

  const available = options ? (Object.keys(ACTIONS) as PowerAction[]).filter((a) => options[a]) : [];

  if (confirm) {
    const a = ACTIONS[confirm];
    return (
      <Sheet title={a.question} onClose={onClose}>
        <p className="muted">
          {a.detail}
          {playing && ' What is playing now stops.'}
        </p>
        <div className="sheet-actions">
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn danger" onClick={() => void run(confirm)} disabled={busy}>
            {busy ? 'Sending…' : a.label}
          </button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title="Kodi box" onClose={onClose}>
      {error && <p className="error-text">{error}</p>}
      {!options && !error && <p className="muted">Asking Kodi…</p>}
      {options && !available.length && <p className="muted">This Kodi box can't be shut down or restarted from the network.</p>}
      {available.length > 0 && (
        <ul className="tracks">
          {available.map((key) => {
            const { label, detail, Icon } = ACTIONS[key];
            return (
              <li key={key}>
                <button className="track has-icon" onClick={() => setConfirm(key)}>
                  <Icon />
                  <span className="track-text">
                    <span className="track-label">{label}</span>
                    <span className="track-detail wraps">{detail}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}
