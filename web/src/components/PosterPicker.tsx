import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { toast } from '../store.ts';
import type { Detail } from '../types.ts';
import { Sheet } from './Sheet.tsx';
import { IconUpload } from './icons.tsx';

/** Choose artwork: another TMDB poster, or an image from the phone/computer. */
export function PosterPicker({ item, onClose, onDone }: { item: Detail; onClose: () => void; onDone: (d: Detail) => void }) {
  const [posters, setPosters] = useState<Array<{ url: string; lang?: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .get<{ posters: Array<{ url: string; lang?: string }> }>(`/api/items/${item.id}/posters`)
      .then((r) => setPosters(r.posters))
      .catch(() => setPosters([]));
  }, [item.id]);

  const apply = async (fn: () => Promise<Detail>, msg: string) => {
    setBusy(true);
    try {
      onDone(await fn());
      toast(msg);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <Sheet title="Poster" onClose={onClose} wide>
      <div className="tool-row">
        <button className="btn" disabled={busy} onClick={() => file.current?.click()}>
          <IconUpload size={18} /> Upload an image
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => void apply(() => api.post<Detail>(`/api/items/${item.id}/poster`, { reset: true }), 'Poster reset')}>
          Use the default
        </button>
        <input
          ref={file}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void apply(() => api.upload<Detail>(`/api/items/${item.id}/poster`, f), 'Poster updated');
          }}
        />
      </div>
      {posters === null && <p className="muted">Loading posters from TMDB…</p>}
      {posters?.length === 0 && (
        <p className="muted">{item.tmdbId ? 'TMDB has no other posters for this title.' : 'Match the file to a title to choose among TMDB posters, or upload your own.'}</p>
      )}
      {posters && posters.length > 0 && (
        <ul className="poster-choices">
          {posters.map((p) => (
            <li key={p.url}>
              <button disabled={busy} onClick={() => void apply(() => api.post<Detail>(`/api/items/${item.id}/poster`, { url: p.url }), 'Poster updated')}>
                <img src={`/api/img?w=342&u=${encodeURIComponent(p.url)}`} alt="" loading="lazy" />
                {p.lang && <span className="badge">{p.lang.toUpperCase()}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
