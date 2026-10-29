import { useEffect, useState } from 'react';
import { useLocation, useRoute } from 'wouter';
import { api } from '../api.ts';
import { useStore, status, toast, prefs } from '../store.ts';
import type { KodiTv, Settings, TaskStatus } from '../types.ts';
import { LangSwitch } from './Detail.tsx';
import { IconRefresh, IconTv } from './icons.tsx';
import { DuplicatesReport, EpisodesReport, SetsReport, WantedReport } from './Reports.tsx';
import { ProfileBadge, ProfilesPanel } from './WhosWatching.tsx';
import { LiveTvSettings } from './LiveTvSettings.tsx';

function ago(ts?: number): string {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

function TaskLine({ label, t }: { label: string; t?: TaskStatus }) {
  if (!t) return null;
  return (
    <div className="task">
      <span className={`task-dot${t.running ? ' is-running' : t.error ? ' is-error' : !t.lastAt ? ' is-idle' : ''}`} aria-hidden="true" />
      <div>
        <p>
          <strong>{label}</strong>{' '}
          <span className="muted">{t.running ? (t.progress ? `${t.progress.done} of ${t.progress.total}` : 'running') : ago(t.lastAt)}</span>
        </p>
        {t.error ? <p className="error-text">{t.error}</p> : t.message ? <p className="muted small">{t.message}</p> : null}
      </div>
    </div>
  );
}

export function SettingsView() {
  const st = useStore(status);
  const p = useStore(prefs);
  const [s, setS] = useState<Settings | null>(null);
  const [tmdbKey, setTmdbKey] = useState('');
  const [found, setFound] = useState<Array<{ host: string; port: number; name: string; version?: string; needsAuth?: boolean }> | null>(null);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<KodiTv | null>(null);
  const [saving, setSaving] = useState(false);
  const [, navigate] = useLocation();
  const [, report] = useRoute('/settings/:report');
  const [countries, setCountries] = useState<Array<{ code: string; name: string }>>([]);

  useEffect(() => {
    api.get<Settings>('/api/settings').then(setS, (e: Error) => toast(e.message, 'error'));
    api.get<{ countries: typeof countries }>('/api/countries').then((r) => setCountries(r.countries), () => {});
  }, []);

  const save = async (patch: Partial<Settings>, msg = 'Saved') => {
    setSaving(true);
    try {
      setS(await api.put<Settings>('/api/settings', patch));
      toast(msg);
      return true;
    } catch (e) {
      toast((e as Error).message, 'error');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const discover = async () => {
    setSearching(true);
    setFound(null);
    try {
      setFound((await api.post<{ found: NonNullable<typeof found> }>('/api/kodi/discover')).found);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSearching(false);
    }
  };

  if (report?.report === 'duplicates') return <DuplicatesReport />;
  if (report?.report === 'sets') return <SetsReport />;
  if (report?.report === 'wanted') return <WantedReport />;
  if (report?.report === 'episodes') return <EpisodesReport />;
  if (!s) return <div className="scroller"><div className="empty"><p>Loading settings…</p></div></div>;

  return (
    <div className="scroller">
      <header className="page-head">
        <div className="head-row">
          <h1>Settings</h1>
          <ProfileBadge />
        </div>
      </header>

      <section className="panel">
        <h2>Activity</h2>
        {st && (
          <>
            {!st.nas.mounted && <p className="error-text">The NAS folder {st.nas.root} isn't mounted on the Mac. Open it in Finder to reconnect.</p>}
            <TaskLine label="NAS scan" t={st.scan} />
            <TaskLine label="Kodi library" t={st.kodi} />
            <TaskLine label="TMDB matching" t={st.metadata} />
            <TaskLine label="Google Sheet import" t={st.sheet} />
          </>
        )}
        <div className="tool-row">
          <button className="btn" onClick={() => api.post('/api/scan').then(() => toast('Scanning the NAS'))}>
            <IconRefresh size={18} /> Scan the NAS now
          </button>
          <button className="btn" onClick={() => api.post('/api/kodi/sync').then(() => toast('Syncing with Kodi and TMDB'))}>
            <IconTv size={18} /> Sync with Kodi
          </button>
        </div>
        <p className="hint">New files are picked up automatically every {s.scanIntervalMin} minutes: titles, posters and trailers follow on their own.</p>
      </section>

      <section className="panel">
        <h2>Lists</h2>
        <p className="muted">To tidy up the NAS, complete your sets and series, and get the films you want.</p>
        <div className="tool-row">
          <button className="btn" onClick={() => navigate('/settings/duplicates', { state: { fromApp: true } })}>
            Films with several copies
          </button>
          <button className="btn" onClick={() => navigate('/settings/sets', { state: { fromApp: true } })}>
            Sets with missing films
          </button>
          <button className="btn" onClick={() => navigate('/settings/wanted', { state: { fromApp: true } })}>
            Films to get
          </button>
          <button className="btn" onClick={() => navigate('/settings/episodes', { state: { fromApp: true } })}>
            Episodes to get
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Language</h2>
        <p className="muted">Language of titles and plots. Search always finds French, English and original titles.</p>
        <LangSwitch />
      </section>

      <section className="panel">
        <h2>Library</h2>
        <p className="muted">Rows above your films. Tap to show or hide each one; the choice is kept on this device.</p>
        <div className="chips wrap">
          <button className="chip" aria-pressed={p.showContinue} onClick={() => prefs.set({ ...p, showContinue: !p.showContinue })}>
            Continue watching
          </button>
          <button className="chip" aria-pressed={p.showSuggested} onClick={() => prefs.set({ ...p, showSuggested: !p.showSuggested })}>
            Suggested for you
          </button>
          <button className="chip" aria-pressed={p.showElsewhere} onClick={() => prefs.set({ ...p, showElsewhere: !p.showElsewhere })}>
            Not on the NAS
          </button>
          <button className="chip" aria-pressed={p.showCinema} onClick={() => prefs.set({ ...p, showCinema: !p.showCinema })}>
            At the cinema
          </button>
          <button className="chip" aria-pressed={p.showSoon} onClick={() => prefs.set({ ...p, showSoon: !p.showSoon })}>
            Coming soon
          </button>
        </div>
        {(p.showCinema || p.showSoon) && (
          <label className="field-inline">
            <span>Cinemas in</span>
            <select
              value={s.cinemaCountry}
              disabled={saving || countries.length === 0}
              onChange={(e) => void save({ cinemaCountry: e.target.value }, `Showing cinemas in ${countries.find((c) => c.code === e.target.value)?.name ?? e.target.value}`)}
            >
              {!s.cinemaCountry && <option value="">Pick a country</option>}
              {countries.length === 0 && s.cinemaCountry && <option value={s.cinemaCountry}>{s.cinemaCountry}</option>}
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      <section className="panel">
        <h2>TMDB</h2>
        <p className="muted">
          Kodi already knows most of your films. For the rest (and for French titles) the app uses TMDB. Create a free account, then copy the
          “API Read Access Token” from{' '}
          <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">
            themoviedb.org/settings/api
          </a>
          .
        </p>
        <form
          className="field-row"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await save({ tmdbKey }, 'Key saved: matching starts now')) setTmdbKey('');
          }}
        >
          <input
            type="password"
            autoComplete="off"
            placeholder={s.tmdbKey ? `Current key ${s.tmdbKey}` : 'Paste the token or API key'}
            value={tmdbKey}
            onChange={(e) => setTmdbKey(e.target.value)}
            aria-label="TMDB key"
          />
          <button className="btn primary" disabled={!tmdbKey || saving}>
            Save key
          </button>
        </form>
      </section>

      <ProfilesPanel />

      <section className="panel">
        <h2>TVs</h2>
        <p className="muted">
          {s.kodiTvs.length
            ? 'Each phone or iPad picks the TV it controls in the bar above the tabs. Watched marks come from the first TV.'
            : 'No TV yet: find your Kodi boxes on the network.'}
          {st?.kodi.transport === 'curl' && ' macOS is blocking local network access for Node, so calls go through curl (works, slightly slower). Allow your terminal app under System Settings › Privacy & Security › Local Network to fix it.'}
        </p>
        {s.kodiTvs.length > 0 && (
          <ul className="found">
            {s.kodiTvs.map((t) => (
              <SavedTv key={t.id} tv={t} live={!!st?.tvs.find((x) => x.id === t.id)?.keyboard} onSaved={setS} />
            ))}
          </ul>
        )}
        <div className="tool-row">
          <button className="btn" onClick={() => void discover()} disabled={searching}>
            {searching ? 'Searching the network…' : 'Find TVs'}
          </button>
          <button className="btn" onClick={() => setAdding({ ...NEW_TV })}>
            Add by address
          </button>
        </div>
        {found && found.length === 0 && <p className="error-text">No Kodi found. In Kodi, turn on Settings › Services › Control › “Allow remote control via HTTP”.</p>}
        {found && found.length > 0 && (
          <ul className="found">
            {found.map((k) => {
              const saved = s.kodiTvs.find((t) => t.host === k.host && t.port === k.port);
              return (
                <li key={`${k.host}:${k.port}`}>
                  <span>
                    <strong>{k.name}</strong> {k.version && <span className="muted">v{k.version}</span>}
                    <br />
                    <span className="muted small">
                      {k.host}:{k.port}
                      {k.needsAuth ? ', needs a password' : ''}
                    </span>
                  </span>
                  {saved ? (
                    <span className="muted small">Saved as {saved.name}</span>
                  ) : (
                    <button className="btn small primary" onClick={() => setAdding({ ...NEW_TV, host: k.host, port: k.port })}>
                      Add…
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {adding && (
          <TvForm
            key={`${adding.host}:${adding.port}`}
            tv={adding}
            onDone={(next) => {
              setAdding(null);
              if (next) setS(next);
            }}
          />
        )}
      </section>

      <LiveTvSettings activity={<TaskLine label="Channel lists and guides" t={st?.live} />} sources={s.liveGuides} onSources={(liveGuides) => save({ liveGuides }, 'Guide sources saved')} />

      <section className="panel">
        <h2>Files and sheet</h2>
        <form
          key={`${s.mediaRoot}|${s.scanIntervalMin}|${s.sheetId}`}
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void save({ mediaRoot: String(f.get('root')).trim(), scanIntervalMin: Number(f.get('interval')) || 10, sheetId: String(f.get('sheet')).trim() });
          }}
        >
          <label className="span-2">
            <span>Media folder on this Mac</span>
            <input name="root" defaultValue={s.mediaRoot} />
          </label>
          <label>
            <span>Check for new files every (minutes)</span>
            <input name="interval" defaultValue={s.scanIntervalMin} inputMode="numeric" />
          </label>
          <label className="span-2">
            <span>Google Sheet (link or id)</span>
            <input name="sheet" defaultValue={s.sheetId} placeholder="https://docs.google.com/spreadsheets/d/…" autoComplete="off" />
          </label>
          <button className="btn" disabled={saving}>
            Save
          </button>
        </form>
        <p className="muted">
          Optional: titles from a Google Sheet (shared as “Anyone with the link can view”) help identify files. The sheet is only read, never changed.
          {s.sheetId && <> Last import: {ago(s.sheetImportedAt)}.</>}
        </p>
        {s.sheetId && (
          <div className="tool-row">
            <button className="btn" onClick={() => api.post('/api/sheet/import').then(() => toast('Reading the sheet'))}>
              Import the sheet again
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

const NEW_TV: KodiTv = { id: '', name: '', host: '', port: 8080, user: 'kodi', pass: '', pathPrefix: '' };

/** A saved TV: its address, Edit, and Remove (a second tap removes it). */
function SavedTv({ tv, live, onSaved }: { tv: KodiTv; live: boolean; onSaved: (s: Settings) => void }) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const remove = async () => {
    if (!confirm) return setConfirm(true);
    try {
      onSaved(await api.del<Settings>(`/api/tvs/${encodeURIComponent(tv.id)}`));
      toast(`${tv.name} removed`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  if (editing) {
    return (
      <li className="tv-edit">
        <TvForm
          tv={tv}
          onDone={(next) => {
            setEditing(false);
            if (next) onSaved(next);
          }}
        />
      </li>
    );
  }
  return (
    <li>
      <span>
        <strong>{tv.name}</strong>
        <br />
        <span className="muted small">
          {tv.host}:{tv.port}
          {live ? ', connected' : ', not connected (to type from the phone, turn on “Allow remote control from applications on other systems” in its Kodi)'}
        </span>
      </span>
      <span className="tv-actions">
        <button
          className="btn small"
          onClick={() =>
            // The server may have worked out its media path since: edit what it holds now.
            api.get<Settings>('/api/settings').then(
              (s) => {
                onSaved(s);
                setEditing(true);
              },
              (e: Error) => toast(e.message, 'error'),
            )
          }
        >
          Edit
        </button>
        <button className={`btn small${confirm ? ' danger' : ''}`} onClick={() => void remove()} onBlur={() => setConfirm(false)}>
          {confirm ? `Remove ${tv.name}?` : 'Remove'}
        </button>
      </span>
    </li>
  );
}

/** Add a TV (no id yet) or change one. `onDone`: the settings once saved, or nothing when cancelled. */
function TvForm({ tv, onDone }: { tv: KodiTv; onDone: (s?: Settings) => void }) {
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="form-grid"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const body = {
          name: String(f.get('name')),
          host: String(f.get('host')),
          port: Number(f.get('port')) || 8080,
          user: String(f.get('user')),
          pass: String(f.get('pass')),
          pathPrefix: String(f.get('prefix')),
        };
        setSaving(true);
        try {
          const next = tv.id ? await api.put<Settings>(`/api/tvs/${encodeURIComponent(tv.id)}`, body) : await api.post<Settings>('/api/tvs', body);
          toast(tv.id ? `${body.name.trim()} saved` : `${body.name.trim()} added`);
          onDone(next);
        } catch (err) {
          toast((err as Error).message, 'error');
          setSaving(false);
        }
      }}
    >
      <label className="span-2">
        <span>Name</span>
        <input name="name" defaultValue={tv.name} placeholder="Living room, Bedroom…" autoFocus={!tv.name} />
      </label>
      <label>
        <span>Address</span>
        <input name="host" defaultValue={tv.host} placeholder="192.168.0.20" />
      </label>
      <label>
        <span>Port</span>
        <input name="port" defaultValue={tv.port} inputMode="numeric" />
      </label>
      <label>
        <span>User</span>
        <input name="user" defaultValue={tv.user} autoComplete="off" />
      </label>
      <label>
        <span>Password</span>
        <input name="pass" type="password" defaultValue={tv.pass} autoComplete="off" />
      </label>
      <label className="span-2">
        <span>How this Kodi sees the media folder (worked out on its own when empty)</span>
        <input name="prefix" defaultValue={tv.pathPrefix} placeholder="smb://192.168.0.24/video/MEDIA" />
      </label>
      <button className="btn primary" disabled={saving}>
        {tv.id ? 'Save' : 'Add TV'}
      </button>
      <button type="button" className="btn" onClick={() => onDone()}>
        Cancel
      </button>
    </form>
  );
}
