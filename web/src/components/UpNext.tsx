import { useMemo } from 'react';
import { api } from '../api.ts';
import { useStore, library, prefs, toast, pollNowPlaying } from '../store.ts';
import { displayTitle } from '../search.ts';
import type { Card, TvStatus, UpNextEntry } from '../types.ts';
import { entryLabel, sleepLabel } from '../upNext.ts';
import { Poster } from './Poster.tsx';
import { Sheet } from './Sheet.tsx';
import { IconClose } from './icons.tsx';

/** A film, or an episode (the one Play would pick unless given), at the end of this device's TV's Up next. */
export async function addToUpNext(tvName: string, itemId: number, episodeId?: number) {
  try {
    const r = await api.post<{ added: { season: number | null; episode: number | null } | null }>('/api/upnext', episodeId ? { itemId, episodeId } : { itemId });
    const label = r.added && entryLabel(r.added);
    toast(`Added ${label ? `${label} ` : ''}to Up next on ${tvName}`);
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

/** Each entry's card in the library (its title and poster), as the title language says. */
export function useEntryTitles() {
  const { items } = useStore(library);
  const { titleLang } = useStore(prefs);
  const cards = useMemo(() => new Map(items.map((c) => [c.id, c])), [items]);
  return (e: UpNextEntry): { card: Card | undefined; title: string } => {
    const card = cards.get(e.itemId);
    return { card, title: card ? displayTitle(card, titleLang).main : (e.episodeTitle ?? 'A title') };
  };
}

const run = (p: Promise<unknown>) => p.catch((e: Error) => toast(e.message, 'error'));

/** The Remote's list of what plays next on this TV: tap to play one now, or take it out. */
export function UpNextList({ tv }: { tv: TvStatus }) {
  const titleOf = useEntryTitles();
  const playNow = async (e: UpNextEntry, title: string) => {
    try {
      await api.post(`/api/upnext/${e.id}/play`, {});
      toast(`Playing ${title} on the TV`);
      setTimeout(() => void pollNowPlaying(), 1500);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <section className="up-next" aria-label="Up next">
      <div className="up-next-head">
        <h2 className="section-title">Up next</h2>
        {tv.upNext.length > 0 && (
          <button className="btn ghost small" onClick={() => void run(api.del('/api/upnext'))}>
            Clear
          </button>
        )}
      </div>
      {tv.upNext.length ? (
        <ol className="up-next-list">
          {tv.upNext.map((e) => {
            const { card, title } = titleOf(e);
            const detail = [entryLabel(e), e.episodeTitle].filter(Boolean).join(' · ');
            return (
              <li key={e.id}>
                <button className="up-next-row" onClick={() => void playNow(e, title)} aria-label={`Play ${title}${detail ? `, ${detail}` : ''} now`}>
                  <Poster src={card?.p ?? null} title={title} year={card?.y} className="up-next-poster" />
                  <span className="up-next-text">
                    <span className="up-next-title">{title}</span>
                    {detail && <span className="up-next-detail">{detail}</span>}
                  </span>
                </button>
                <button className="icon-btn" onClick={() => void run(api.del(`/api/upnext/${e.id}`))} aria-label={`Remove ${title} from Up next`}>
                  <IconClose size={18} />
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="muted small">Add films and episodes from their pages; they play here one after another.</p>
      )}
    </section>
  );
}

const MINUTES = [15, 30, 45, 60, 90];

/** Stop after what plays now, or in so many minutes; or turn the timer off. */
export function SleepSheet({ tv, active, episode, onClose }: { tv: TvStatus; active: boolean; episode: boolean; onClose: () => void }) {
  const set = async (body: { minutes: number } | { afterThis: true } | null) => {
    try {
      if (body) await api.put('/api/kodi/sleep', body);
      else await api.del('/api/kodi/sleep');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const now = sleepLabel(tv.sleep, Date.now(), episode);
  const choices: Array<{ label: string; body: { minutes: number } | { afterThis: true } }> = [
    ...(active ? [{ label: `After this ${episode ? 'episode' : 'film'}`, body: { afterThis: true } as const }] : []),
    ...MINUTES.map((m) => ({ label: `In ${m} minutes`, body: { minutes: m } })),
  ];
  return (
    <Sheet title="Sleep timer" onClose={onClose}>
      <p className="muted">{now ? `${now}. ` : ''}What plays on {tv.name} stops; nothing starts after it.</p>
      <ul className="tracks">
        {choices.map((c) => (
          <li key={c.label}>
            <button className="track" onClick={() => void set(c.body)}>
              <span className="track-text">
                <span className="track-label">{c.label}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {tv.sleep && (
        <div className="sheet-actions">
          <button className="btn ghost" onClick={() => void set(null)}>
            Turn off
          </button>
        </div>
      )}
    </Sheet>
  );
}
