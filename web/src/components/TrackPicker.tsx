import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { toast, pollNowPlaying } from '../store.ts';
import type { Streams } from '../types.ts';
import { languageName, audioDetail, subtitleDetail } from '../tracks.ts';
import { Sheet } from './Sheet.tsx';
import { IconCheck } from './icons.tsx';

interface Row {
  index: number;
  label: string;
  detail: string;
}

/** Pick an audio or subtitle track directly instead of cycling through them on the TV. */
export function TrackPicker({ kind, onClose }: { kind: 'audio' | 'subtitles'; onClose: () => void }) {
  const [data, setData] = useState<Streams | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    api.get<Streams>('/api/kodi/streams').then(setData, (e: Error) => setError(e.message));
  }, []);

  const rows: Row[] = !data
    ? []
    : kind === 'audio'
      ? data.audio.map((a) => ({ index: a.index, label: languageName(a.language), detail: audioDetail(a) }))
      : [
          { index: -1, label: 'Off', detail: '' },
          ...data.subtitles.map((s) => ({ index: s.index, label: languageName(s.language), detail: subtitleDetail(s) })),
        ];
  const current = !data ? undefined : kind === 'audio' ? data.currentAudio : data.subtitlesOn ? data.currentSubtitle : -1;

  const choose = async (index: number) => {
    if (index === current) return onClose();
    setBusy(index);
    try {
      await api.post('/api/kodi/remote', { action: kind, value: index });
      void pollNowPlaying();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(null);
    }
  };

  const title = kind === 'audio' ? 'Audio track' : 'Subtitles';
  const empty = data && (kind === 'audio' ? data.audio.length === 0 : data.subtitles.length === 0);

  return (
    <Sheet title={title} onClose={onClose}>
      {error && <p className="error-text">{error}</p>}
      {!data && !error && <p className="muted">Asking Kodi…</p>}
      {data && !data.active && <p className="muted">Nothing is playing.</p>}
      {data?.active && empty && <p className="muted">{kind === 'audio' ? 'This video has no selectable audio tracks.' : 'This video has no subtitles.'}</p>}
      {data?.active && !(empty && kind === 'audio') && (
        <ul className="tracks" role="radiogroup" aria-label={title}>
          {rows.map((r) => (
            <li key={r.index}>
              <button
                className="track"
                role="radio"
                aria-checked={r.index === current}
                disabled={busy !== null}
                onClick={() => void choose(r.index)}
              >
                <span className="track-text">
                  <span className="track-label">{r.label}</span>
                  {r.detail && <span className="track-detail">{r.detail}</span>}
                </span>
                {busy === r.index ? <span className="track-busy" aria-label="Switching" /> : r.index === current ? <IconCheck size={20} /> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
