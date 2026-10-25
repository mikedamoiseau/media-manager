import { useEffect, useState } from 'react';
import { useLocation, useRoute } from 'wouter';
import { api } from '../api.ts';
import { useStore, status, toast, prefs } from '../store.ts';
import type { Settings, TaskStatus } from '../types.ts';
import { LangSwitch } from './Detail.tsx';
import { IconRefresh, IconTv } from './icons.tsx';
import { DuplicatesReport, SetsReport, WantedReport } from './Reports.tsx';

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
  if (!s) return <div className="scroller"><div className="empty"><p>Loading settings…</p></div></div>;

  return (
    <div className="scroller">
      <header className="page-head">
        <h1>Settings</h1>
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
        <p className="muted">To tidy up the NAS, complete your sets, and get the films you want.</p>
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
        </div>
        {p.showCinema && (
          <label className="field-inline">
            <span>Cinemas in</span>
            <select
              value={s.cinemaCountry}
              disabled={saving || countries.length === 0}
              onChange={(e) => void save({ cinemaCountry: e.target.value }, `Showing cinemas in ${countries.find((c) => c.code === e.target.value)?.name ?? e.target.value}`)}
            >
              {countries.length === 0 && <option value={s.cinemaCountry}>{s.cinemaCountry}</option>}
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

      <section className="panel">
        <h2>Kodi</h2>
        <p className="muted">
          {st?.kodi.connected ? `Connected to ${s.kodiHost}:${s.kodiPort}.` : s.kodiHost ? `Set to ${s.kodiHost}:${s.kodiPort}, not answering right now.` : 'Not set up yet.'}
          {st?.kodi.connected &&
            (st.kodi.keyboard
              ? ' When Kodi shows its keyboard, you can type on the phone.'
              : ' To type on the phone when Kodi shows its keyboard, turn on Settings › Services › Control › “Allow remote control from applications on other systems” in Kodi.')}
          {st?.kodi.transport === 'curl' && ' macOS is blocking local network access for Node, so calls go through curl (works, slightly slower). Allow your terminal app under System Settings › Privacy & Security › Local Network to fix it.'}
        </p>
        <div className="tool-row">
          <button className="btn" onClick={() => void discover()} disabled={searching}>
            {searching ? 'Searching the network…' : 'Find Kodi'}
          </button>
        </div>
        {found && found.length === 0 && <p className="error-text">No Kodi found. In Kodi, turn on Settings › Services › Control › “Allow remote control via HTTP”.</p>}
        {found && found.length > 0 && (
          <ul className="found">
            {found.map((k) => (
              <li key={`${k.host}:${k.port}`}>
                <span>
                  <strong>{k.name}</strong> {k.version && <span className="muted">v{k.version}</span>}
                  <br />
                  <span className="muted small">
                    {k.host}:{k.port}
                    {k.needsAuth ? ', needs a password' : ''}
                  </span>
                </span>
                <button className="btn small primary" onClick={() => void save({ kodiHost: k.host, kodiPort: k.port, kodiPathPrefix: '' }, 'Kodi connected')}>
                  Use this one
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          key={`${s.kodiHost}|${s.kodiPort}|${s.kodiUser}|${s.kodiPathPrefix}`}
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void save({
              kodiHost: String(f.get('host')).trim(),
              kodiPort: Number(f.get('port')) || 8080,
              kodiUser: String(f.get('user')).trim(),
              kodiPass: String(f.get('pass')),
              kodiPathPrefix: String(f.get('prefix')).trim(),
            });
          }}
        >
          <label>
            <span>Address</span>
            <input name="host" defaultValue={s.kodiHost} placeholder="192.168.0.20" />
          </label>
          <label>
            <span>Port</span>
            <input name="port" defaultValue={s.kodiPort} inputMode="numeric" />
          </label>
          <label>
            <span>User</span>
            <input name="user" defaultValue={s.kodiUser} autoComplete="off" />
          </label>
          <label>
            <span>Password</span>
            <input name="pass" type="password" defaultValue={s.kodiPass} autoComplete="off" />
          </label>
          <label className="span-2">
            <span>How Kodi sees the media folder</span>
            <input name="prefix" defaultValue={s.kodiPathPrefix} placeholder="smb://192.168.0.24/video/MEDIA" />
          </label>
          <button className="btn span-2" disabled={saving}>
            Save Kodi settings
          </button>
        </form>
      </section>

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
