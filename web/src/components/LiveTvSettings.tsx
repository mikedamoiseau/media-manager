import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { api } from '../api.ts';
import { useStore, status, toast } from '../store.ts';
import { normalize } from '../search.ts';
import { dragMove, guideLabel, moveKey } from '../liveTv.ts';
import type { CatalogRow } from '../types.ts';
import { Sheet } from './Sheet.tsx';
import { IconCheck, IconClose, IconMenu, IconRefresh } from './icons.tsx';

type GuideChannel = { source: string; id: string; name: string };

const LISTS: Record<string, string> = { fr: 'France', be: 'Belgium' };

const picksOf = (rows: CatalogRow[]) =>
  rows
    .filter((r) => r.position !== null)
    .sort((a, b) => a.position! - b.position!)
    .map((r) => r.key);

const matches = (q: string, ...texts: string[]) => !q || texts.some((t) => normalize(t).includes(q));

/**
 * Live TV in Settings: the owner's channels in their order (dragged by the handle, with touch too), each one's
 * guide, adding channels from iptv-org's lists, and where the guides come from. Every change is saved at once.
 */
export function LiveTvSettings({ activity, sources, onSources }: { activity: ReactNode; sources: string[]; onSources: (list: string[]) => Promise<boolean> }) {
  const live = useStore(status)?.live;
  const [rows, setRows] = useState<CatalogRow[] | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [guideFor, setGuideFor] = useState<CatalogRow | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  // The order as the owner sees it: pointer events read it before React renders.
  const orderRef = useRef<string[]>([]);
  const drag = useRef<{ key: string; y: number; h: number; moved: boolean } | null>(null);
  const saves = useRef(Promise.resolve());
  const pending = useRef(0);
  const loads = useRef(0);

  const show = (keys: string[]) => {
    orderRef.current = keys;
    setOrder(keys);
  };

  const load = () => {
    // Only the latest answer counts: an earlier one may hold the order from before a save.
    const n = ++loads.current;
    return api.get<{ rows: CatalogRow[] }>('/api/livetv/catalog').then(
      (r) => {
        if (n !== loads.current) return;
        setRows(r.rows);
        // A save on its way, or a drag: the owner's order wins until it's saved.
        if (!pending.current && !drag.current) show(picksOf(r.rows));
      },
      (e: Error) => toast(e.message, 'error'),
    );
  };

  // After each refresh or stream check, even one that failed halfway: whether channels answer, and whether iptv-org still lists them.
  useEffect(() => {
    void load();
  }, [live?.lastAt, live?.running]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Saves the owner's channels, one save after the other, and says where they went. */
  const save = (keys: string[]) => {
    show(keys);
    pending.current++;
    saves.current = saves.current.then(async () => {
      try {
        const r = await api.put<{ file: 'written' | 'same' | 'not_mounted' }>('/api/livetv/channels', { keys });
        if (r.file === 'not_mounted') toast("The NAS isn't mounted: the TVs keep the old list", 'error');
        else toast('Saved on the NAS');
      } catch (e) {
        toast((e as Error).message, 'error');
      } finally {
        pending.current--;
      }
      if (!pending.current) await load();
    });
  };

  const byKey = useMemo(() => new Map((rows ?? []).map((r) => [r.key, r])), [rows]);
  const picked = useMemo(() => new Set(order), [order]);

  const onDown = (e: PointerEvent<HTMLButtonElement>, key: string) => {
    const li = e.currentTarget.closest('li');
    if (!li) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { key, y: e.clientY, h: li.getBoundingClientRect().height + 8, moved: false };
    setDragging(key);
  };
  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    // A row per row-height travelled (a fast drag crosses several between two events).
    const { keys, rows } = dragMove(orderRef.current, d.key, e.clientY - d.y, d.h);
    if (!rows) return;
    d.y += rows * d.h;
    d.moved = true;
    show(keys);
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(null);
    if (d?.moved) save(orderRef.current);
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, key: string) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const next = moveKey(orderRef.current, key, e.key === 'ArrowUp' ? -1 : 1);
    if (next !== orderRef.current) save(next);
  };

  return (
    <section className="panel">
      <h2>Live TV</h2>
      <p className="muted">The channels both TVs get, in this order (their numbers on the TV), and the guide each one shows in the app.</p>
      {live?.file === 'not_mounted' && <p className="error-text">The NAS isn't mounted: the TVs keep the old list.</p>}

      <h3 className="field-label">Your channels</h3>
      {rows && !order.length && <p className="muted">No channel yet: add the ones you watch.</p>}
      {order.length > 0 && (
        <ul className="found live-picks">
          {order.map((key, i) => {
            const r = byKey.get(key);
            if (!r) return null;
            return (
              <li key={key} className={dragging === key ? 'is-dragging' : undefined}>
                <button
                  className="icon-btn live-handle"
                  aria-label={`Move ${r.name} (arrow keys)`}
                  onPointerDown={(e) => onDown(e, key)}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onPointerCancel={onUp}
                  onKeyDown={(e) => onKey(e, key)}
                >
                  <IconMenu />
                </button>
                <RowLogo row={r} />
                <button className="live-pick-text" onClick={() => setGuideFor(r)} aria-label={`${r.name}: ${guideLabel(r)}. Change the guide`}>
                  <strong>
                    {i + 1} · {r.name}
                  </strong>
                  <span className={`small${r.listed ? ' muted' : ' error-text'}`}>{guideLabel(r)}</span>
                  <StreamState ok={r.ok} />
                </button>
                <button className="icon-btn" aria-label={`Remove ${r.name}`} onClick={() => save(orderRef.current.filter((k) => k !== key))}>
                  <IconClose />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="tool-row">
        <button className="btn primary" disabled={!rows} onClick={() => setAdding(true)}>
          Add channels
        </button>
      </div>
      <p className="hint">The TVs see changes after Kodi restarts or rereads its channel list (every hour).</p>

      <h3 className="field-label">Lists and guides</h3>
      {activity}
      <div className="tool-row">
        <button className="btn" disabled={live?.running} onClick={() => api.post('/api/livetv/refresh').then(() => toast('Reading the channel lists and guides'), (e: Error) => toast(e.message, 'error'))}>
          <IconRefresh size={18} /> Refresh now
        </button>
        <button className="btn" disabled={live?.running} onClick={() => api.post('/api/livetv/check').then(() => toast('Checking every channel: a minute or two'), (e: Error) => toast(e.message, 'error'))}>
          Check streams
        </button>
      </div>
      <GuideSources key={sources.join('\n')} sources={sources} onSave={onSources} />

      {adding && rows && (
        <AddChannels rows={rows} picked={picked} onToggle={(key) => save(picked.has(key) ? orderRef.current.filter((k) => k !== key) : [...orderRef.current, key])} onClose={() => setAdding(false)} />
      )}
      {guideFor && <GuidePick row={guideFor} onPicked={() => void load()} onClose={() => setGuideFor(null)} />}
    </section>
  );
}

function RowLogo({ row }: { row: CatalogRow }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="live-logo" aria-hidden="true">
      {row.logo && !failed ? <img src={row.logo} alt="" loading="lazy" onError={() => setFailed(true)} /> : <b>{row.name.slice(0, 4)}</b>}
    </span>
  );
}

function StreamState({ ok }: { ok: boolean | null }) {
  return (
    <span className={`live-state${ok === true ? ' is-ok' : ok === false ? ' is-down' : ''}`}>{ok === true ? 'Answers' : ok === false ? "Doesn't answer" : 'Not checked'}</span>
  );
}

/** iptv-org's channels, one list at a time, to tick. */
function AddChannels({ rows, picked, onToggle, onClose }: { rows: CatalogRow[]; picked: Set<string>; onToggle: (key: string) => void; onClose: () => void }) {
  const lists = [...new Set(rows.map((r) => r.list))];
  const [list, setList] = useState(lists[0] ?? 'fr');
  const [q, setQ] = useState('');
  const nq = normalize(q);
  const shown = rows.filter((r) => r.list === list && (r.listed || picked.has(r.key)) && matches(nq, r.name, r.group));
  return (
    <Sheet title="Add channels" onClose={onClose} wide>
      <div className="segmented" role="radiogroup" aria-label="List">
        {lists.map((l) => (
          <button key={l} role="radio" aria-checked={list === l} onClick={() => setList(l)}>
            {LISTS[l] ?? l}
          </button>
        ))}
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search channels" aria-label="Search channels" autoComplete="off" />
      <ul className="live-add">
        {shown.map((r) => (
          <li key={r.key}>
            <button className="live-add-row" aria-pressed={picked.has(r.key)} onClick={() => onToggle(r.key)}>
              <RowLogo row={r} />
              <span className="live-pick-text">
                <strong>{r.name}</strong>
                <span className="muted small">{r.group}</span>
                <StreamState ok={r.ok} />
              </span>
              <span className="live-tick" aria-hidden="true">
                {picked.has(r.key) && <IconCheck size={18} />}
              </span>
            </button>
          </li>
        ))}
        {!shown.length && <li className="muted">No channel matches.</li>}
      </ul>
    </Sheet>
  );
}

/** A channel's guide: found automatically, none, or one picked from the guides' channels. */
function GuidePick({ row, onPicked, onClose }: { row: CatalogRow; onPicked: () => void; onClose: () => void }) {
  const [all, setAll] = useState<GuideChannel[] | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    api.get<{ channels: GuideChannel[] }>('/api/livetv/guide-channels').then(
      (r) => setAll(r.channels),
      (e: Error) => toast(e.message, 'error'),
    );
  }, []);
  const pick = async (guide: { source: string; id: string } | 'none' | null) => {
    try {
      await api.put(`/api/livetv/channels/${encodeURIComponent(row.key)}/guide`, { guide });
      toast('Guide saved');
      onPicked();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const nq = normalize(q);
  const shown = nq ? (all ?? []).filter((g) => matches(nq, g.name, g.id)).slice(0, 60) : [];
  const host = (url: string) => new URL(url).hostname.replace(/^www\./, '');
  const mine = (g: GuideChannel) => row.guide.mode === 'manual' && row.guide.source === g.source && row.guide.id === g.id;
  return (
    <Sheet title={`Guide for ${row.name}`} onClose={onClose} wide>
      <p className="muted">Now: {guideLabel(row)}</p>
      <div className="tool-row">
        <button className="btn small" aria-pressed={row.guide.mode === 'auto'} onClick={() => void pick(null)}>
          Automatic
        </button>
        <button className="btn small" aria-pressed={row.guide.mode === 'none'} onClick={() => void pick('none')}>
          No guide
        </button>
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search the guides, e.g. ${row.name}`} aria-label="Search the guides" autoComplete="off" />
      {!all && <p className="hint">Loading the guides' channels…</p>}
      <ul className="found">
        {shown.map((g) => (
          <li key={`${g.source}\t${g.id}`}>
            <span>
              <strong>{g.name}</strong>
              <br />
              <span className="muted small">
                {g.id} · {host(g.source)}
              </span>
            </span>
            <button className="btn small primary" disabled={mine(g)} onClick={() => void pick({ source: g.source, id: g.id })}>
              {mine(g) ? 'Picked' : 'Pick'}
            </button>
          </li>
        ))}
        {all && nq && !shown.length && <li className="muted">No guide channel matches.</li>}
      </ul>
    </Sheet>
  );
}

/** The guides (XMLTV addresses), one per line: for a channel in several, the first one wins. */
function GuideSources({ sources, onSave }: { sources: string[]; onSave: (list: string[]) => Promise<boolean> }) {
  const [text, setText] = useState(sources.join('\n'));
  return (
    <form
      className="live-sources"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(
          text
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
        );
      }}
    >
      <label className="field-label" htmlFor="live-sources">
        Guide sources, one address per line (for a channel in several, the first one wins)
      </label>
      <textarea id="live-sources" rows={3} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} autoComplete="off" />
      <button className="btn" disabled={text === sources.join('\n')}>
        Save sources
      </button>
    </form>
  );
}
