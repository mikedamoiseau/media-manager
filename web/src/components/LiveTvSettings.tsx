import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { api } from '../api.ts';
import { useStore, status, toast } from '../store.ts';
import { normalize } from '../search.ts';
import { dragMove, guideLabel, inSlots, listName, listsIn, moveKey } from '../liveTv.ts';
import type { CatalogRow } from '../types.ts';
import { Sheet } from './Sheet.tsx';
import { IconCheck, IconClose, IconMenu, IconRefresh } from './icons.tsx';

type GuideChannel = { source: string; id: string; name: string };

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
  // The channel whose sheet is open (its row is read fresh after each save)
  const [sheetFor, setSheetFor] = useState<string | null>(null);
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
  // The owner's channels by category; a channel moves among its category's, the others keep their numbers.
  const ofList = (keys: string[], list: string | undefined) => keys.filter((k) => byKey.get(k)?.list === list);
  const pickLists = listsIn(order.flatMap((k) => byKey.get(k)?.list ?? []));

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
    const { keys, rows } = dragMove(ofList(orderRef.current, byKey.get(d.key)?.list), d.key, e.clientY - d.y, d.h);
    if (!rows) return;
    d.y += rows * d.h;
    d.moved = true;
    show(inSlots(orderRef.current, keys));
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
    const next = inSlots(orderRef.current, moveKey(ofList(orderRef.current, byKey.get(key)?.list), key, e.key === 'ArrowUp' ? -1 : 1));
    if (next !== orderRef.current) save(next);
  };

  return (
    <section className="panel">
      <h2>Live TV</h2>
      <p className="muted">The channels both TVs get, in this order (their numbers on the TV), and the guide each one shows in the app.</p>
      {live?.file === 'not_mounted' && <p className="error-text">The NAS isn't mounted: the TVs keep the old list.</p>}

      <h3 className="field-label">Your channels</h3>
      {rows && !order.length && <p className="muted">No channel yet: add the ones you watch.</p>}
      {pickLists.map((list) => (
        <Fragment key={list}>
          {pickLists.length > 1 && <h4 className="live-list-head">{listName(list)}</h4>}
          <ul className="found live-picks">
            {ofList(order, list).map((key) => {
              const r = byKey.get(key)!;
              const i = order.indexOf(key);
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
                  <RowLogo key={r.logo} row={r} />
                  <button className="live-pick-text" onClick={() => setSheetFor(key)} aria-label={`${r.name}: ${guideLabel(r)}. Change its guide, stream or logo`}>
                    <strong>
                      {i + 1} · {r.name}
                    </strong>
                    <span className={`small${r.listed ? ' muted' : ' error-text'}`}>{guideLabel(r)}</span>
                    <StreamState ok={r.ok} />
                    {r.stream && <span className="muted small">Own stream address</span>}
                    {r.ownLogo && <span className="muted small">Own logo</span>}
                    {r.player && <span className="muted small">Other player on the TVs</span>}
                    {r.kids && <span className="muted small">For kids</span>}
                  </button>
                  <button className="icon-btn" aria-label={`Remove ${r.name}`} onClick={() => save(orderRef.current.filter((k) => k !== key))}>
                    <IconClose />
                  </button>
                </li>
              );
            })}
          </ul>
        </Fragment>
      ))}
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
      {sheetFor && byKey.get(sheetFor) && <ChannelSheet row={byKey.get(sheetFor)!} onSaved={() => void load()} onClose={() => setSheetFor(null)} />}
    </section>
  );
}

function RowLogo({ row }: { row: CatalogRow }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="live-logo" aria-hidden="true">
      {row.logo && !failed ? <img src={row.logo} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <b>{row.name.slice(0, 4)}</b>}
    </span>
  );
}

function StreamState({ ok }: { ok: boolean | null }) {
  return (
    <span className={`live-state${ok === true ? ' is-ok' : ok === false ? ' is-down' : ''}`}>{ok === true ? 'Answers' : ok === false ? "Doesn't answer" : 'Not checked'}</span>
  );
}

/** The channels of the lists, one category at a time, to tick. */
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
            {listName(l)}
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

/** One of the owner's channels: where its stream comes from, its logo, and its guide (found automatically, none, or one picked from the guides' channels). */
function ChannelSheet({ row, onSaved, onClose }: { row: CatalogRow; onSaved: () => void; onClose: () => void }) {
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
      onSaved();
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
    <Sheet title={row.name} onClose={onClose} wide>
      <OwnStream key={row.stream ?? ''} row={row} onSaved={onSaved} />
      <OwnLogo key={row.ownLogo ?? ''} row={row} onSaved={onSaved} />
      <TvPlayer row={row} onSaved={onSaved} />
      <ForKids row={row} onSaved={onSaved} />
      <h3 className="field-label">Guide</h3>
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

/** The player the TVs open a channel with: their usual one, or ffmpegdirect for a channel that crashes or stalls it. */
function TvPlayer({ row, onSaved }: { row: CatalogRow; onSaved: () => void }) {
  const save = async (player: 'ffmpegdirect' | null) => {
    try {
      const r = await api.put<{ file: 'written' | 'same' | 'not_mounted' }>(`/api/livetv/channels/${encodeURIComponent(row.key)}/player`, { player });
      if (r.file === 'not_mounted') toast("Saved, but the NAS isn't mounted: the TVs keep the old list", 'error');
      else toast(player ? 'The TVs will open it with the other player' : 'Back to the usual player');
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <>
      <h3 className="field-label">Player on the TVs</h3>
      <p className="muted small">Try the other player (ffmpegdirect) if Kodi crashes or stalls on this channel. The TVs see it when they reread the list.</p>
      <div className="tool-row">
        <button className="btn small" aria-pressed={!row.player} onClick={() => void save(null)}>
          Usual
        </button>
        <button className="btn small" aria-pressed={row.player === 'ffmpegdirect'} onClick={() => void save('ffmpegdirect')}>
          Other player
        </button>
      </div>
    </>
  );
}

/** A channel made for kids: in the TVs' Kids group, and the kids profiles can watch it. */
function ForKids({ row, onSaved }: { row: CatalogRow; onSaved: () => void }) {
  const save = async (kids: boolean) => {
    try {
      const r = await api.put<{ file: 'written' | 'same' | 'not_mounted' }>(`/api/livetv/channels/${encodeURIComponent(row.key)}/kids`, { kids });
      if (r.file === 'not_mounted') toast("Saved, but the NAS isn't mounted: the TVs keep the old list", 'error');
      else toast(kids ? 'For kids: the kids profiles can watch it' : 'Not for kids any more');
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <>
      <h3 className="field-label">Kids</h3>
      <p className="muted small">A channel for kids is in the TVs' Kids group, and the kids profiles can watch it.</p>
      <div className="tool-row">
        <button className="btn small" aria-pressed={!row.kids} onClick={() => void save(false)}>
          Not for kids
        </button>
        <button className="btn small" aria-pressed={row.kids} onClick={() => void save(true)}>
          For kids
        </button>
      </div>
    </>
  );
}

/** Where a channel's stream comes from: iptv-org's address, or one the owner found that works (sent without request headers). */
function OwnStream({ row, onSaved }: { row: CatalogRow; onSaved: () => void }) {
  const [url, setUrl] = useState(row.stream ?? '');
  const [busy, setBusy] = useState(false);
  const save = async (next: string | null) => {
    setBusy(true);
    try {
      const r = await api.put<{ file: 'written' | 'same' | 'not_mounted'; ok: boolean }>(`/api/livetv/channels/${encodeURIComponent(row.key)}/stream`, { url: next });
      if (r.file === 'not_mounted') toast("Saved, but the NAS isn't mounted: the TVs keep the old list", 'error');
      else if (!r.ok) toast("Saved on the NAS, but this stream doesn't answer", 'error');
      else toast('Saved on the NAS: the stream answers');
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="live-sources"
      onSubmit={(e) => {
        e.preventDefault();
        void save(url.trim());
      }}
    >
      <label className="field-label" htmlFor="live-own">
        Stream address
      </label>
      <p className="muted small">{row.stream ? 'Your own address, sent without request headers.' : "iptv-org's address. Paste another one if it stops working."}</p>
      <input id="live-own" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/master.m3u8" inputMode="url" autoComplete="off" spellCheck={false} />
      <div className="tool-row">
        <button className="btn small primary" disabled={busy || !url.trim() || url.trim() === row.stream}>
          Use this address
        </button>
        {row.stream && (
          <button type="button" className="btn small" disabled={busy} onClick={() => void save(null)}>
            Back to iptv-org's
          </button>
        )}
      </div>
    </form>
  );
}

/** A channel's logo: iptv-org's, or one the owner found that shows (on the TVs and here). */
function OwnLogo({ row, onSaved }: { row: CatalogRow; onSaved: () => void }) {
  const [url, setUrl] = useState(row.ownLogo ?? '');
  const [busy, setBusy] = useState(false);
  const save = async (next: string | null) => {
    setBusy(true);
    try {
      const r = await api.put<{ file: 'written' | 'same' | 'not_mounted' }>(`/api/livetv/channels/${encodeURIComponent(row.key)}/logo`, { url: next });
      if (r.file === 'not_mounted') toast("Saved, but the NAS isn't mounted: the TVs keep the old list", 'error');
      else toast(next ? 'Logo saved on the NAS' : "Back to iptv-org's logo");
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  // What it would look like: the address being typed, else the logo it has.
  const shown = url.trim() || row.logo;
  return (
    <form
      className="live-sources"
      onSubmit={(e) => {
        e.preventDefault();
        void save(url.trim());
      }}
    >
      <label className="field-label" htmlFor="live-logo">
        Logo
      </label>
      <p className="muted small">{row.ownLogo ? 'Your own logo.' : "iptv-org's logo. Paste another image address if it doesn't show."} A PNG or JPEG: the TVs don't show SVG.</p>
      <input id="live-logo" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/logo.png" inputMode="url" autoComplete="off" spellCheck={false} />
      <div className="tool-row">
        <RowLogo key={shown} row={{ ...row, logo: shown }} />
        <button className="btn small primary" disabled={busy || !url.trim() || url.trim() === row.ownLogo}>
          Use this logo
        </button>
        {row.ownLogo && (
          <button type="button" className="btn small" disabled={busy} onClick={() => void save(null)}>
            Back to iptv-org's
          </button>
        )}
      </div>
    </form>
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
