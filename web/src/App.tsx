import { useEffect, useRef } from 'react';
import { useLocation, useRoute } from 'wouter';
import { Library } from './components/Library.tsx';
import { DetailView } from './components/Detail.tsx';
import { FilmView } from './components/Film.tsx';
import { Review } from './components/Review.tsx';
import { Remote } from './components/Remote.tsx';
import { SettingsView } from './components/Settings.tsx';
import { LiveTv } from './components/LiveTv.tsx';
import { TvBar } from './components/TvBar.tsx';
import { Toasts } from './components/Toasts.tsx';
import { KodiKeyboard } from './components/KodiKeyboard.tsx';
import { WhosWatching } from './components/WhosWatching.tsx';
import { KidsPlaying } from './components/Kids.tsx';
import { IconFilm, IconInbox, IconPlay, IconRemote, IconSettings, IconTv } from './components/icons.tsx';
import { useStore, status, online, profileChoice, useProfile } from './store.ts';
import { rowOf } from './rows.ts';

type Tab = 'library' | 'live' | 'review' | 'remote' | 'settings';

const TABS: Array<{ key: Tab; path: string; label: string; Icon: typeof IconFilm }> = [
  { key: 'library', path: '/', label: 'Library', Icon: IconFilm },
  { key: 'live', path: '/live', label: 'Live TV', Icon: IconTv },
  { key: 'review', path: '/review', label: 'To review', Icon: IconInbox },
  { key: 'remote', path: '/remote', label: 'Remote', Icon: IconRemote },
  { key: 'settings', path: '/settings', label: 'Settings', Icon: IconSettings },
];
// Kids mode: the library and what plays, nothing else.
const KIDS_TABS: typeof TABS = [
  { key: 'library', path: '/', label: 'Library', Icon: IconFilm },
  { key: 'remote', path: '/remote', label: 'Playing', Icon: IconPlay },
];

function tabFor(path: string): Tab | null {
  if (path.startsWith('/title/') || path.startsWith('/film/')) return null;
  return TABS.find((t) => t.path !== '/' && path.startsWith(t.path))?.key ?? 'library';
}

export function App() {
  const [location, navigate] = useLocation();
  const [, titleParams] = useRoute('/title/:id');
  const [, filmParams] = useRoute('/film/:id');
  const params = titleParams ?? filmParams;
  const lastTab = useRef<Tab>('library');
  const current = tabFor(location);
  if (current) lastTab.current = current;
  const tab = current ?? lastTab.current;
  const st = useStore(status);
  const isOnline = useStore(online);
  const choice = useStore(profileChoice);
  const me = useProfile();
  const kids = !!me?.kids;
  const tabs = kids ? KIDS_TABS : TABS;
  const reviewCount = (st?.counts.unmatched ?? 0) + (st?.counts.pending ?? 0);

  const closeDetail = () => {
    if ((history.state as { fromApp?: boolean } | null)?.fromApp) history.back();
    else navigate((tabs.find((t) => t.key === lastTab.current) ?? tabs[0]!).path, { replace: true });
  };

  useEffect(() => {
    document.body.classList.toggle('has-overlay', !!params);
  }, [params]);

  // Kids mode has no Live TV, To review, Settings, film pages (films not on the NAS), sets' pages or the rows of other films: back to the library.
  const offLimits =
    kids && (tab === 'live' || tab === 'review' || tab === 'settings' || !!filmParams || location.startsWith('/set/') || (location.startsWith('/row/') && !rowOf(location, true)));
  useEffect(() => {
    if (offLimits) navigate('/', { replace: true });
  }, [offLimits]); // eslint-disable-line react-hooks/exhaustive-deps

  // No one picked on this device yet, or the one picked was removed: ask first.
  if (!choice || (st && !me)) {
    return (
      <>
        <WhosWatching />
        <Toasts />
      </>
    );
  }

  return (
    <div className={`app${kids ? ' is-kids' : ''}`}>
      {!isOnline && <div className="offline">Reconnecting to the media server…</div>}
      <main className="pages">
        <section className="page" hidden={tab !== 'library'}>
          <Library active={tab === 'library' && !params} />
        </section>
        <section className="page" hidden={tab !== 'live'}>
          {tab === 'live' && !kids && <LiveTv />}
        </section>
        <section className="page" hidden={tab !== 'review'}>
          {tab === 'review' && !kids && <Review />}
        </section>
        <section className="page" hidden={tab !== 'remote'}>
          {tab === 'remote' && (kids ? <KidsPlaying /> : <Remote />)}
        </section>
        <section className="page" hidden={tab !== 'settings'}>
          {tab === 'settings' && !kids && <SettingsView />}
        </section>
      </main>

      {titleParams && <DetailView key={`${titleParams.id}-${choice}`} id={Number(titleParams.id)} onClose={closeDetail} />}
      {filmParams && !kids && <FilmView key={filmParams.id} id={Number(filmParams.id)} onClose={closeDetail} />}

      <footer className="chrome">
        {!kids && <TvBar onRemote={tab === 'remote'} />}
        <nav className="tabbar" aria-label="Sections">
          {tabs.map(({ key, path, label, Icon }) => (
            <button
              key={key}
              className="tab"
              aria-current={tab === key && !params ? 'page' : undefined}
              onClick={() => {
                if (tab === key && !params && location === path) {
                  // Second tap on the active tab scrolls back to the top, like iOS.
                  document.querySelector(`.page:not([hidden]) .scroller`)?.scrollTo({ top: 0, behavior: 'smooth' });
                } else navigate(path);
              }}
            >
              <Icon />
              <span>{label}</span>
              {key === 'review' && reviewCount > 0 && <b className="tab-badge">{reviewCount > 999 ? '999+' : reviewCount}</b>}
            </button>
          ))}
        </nav>
      </footer>
      {!kids && <KodiKeyboard />}
      <Toasts />
    </div>
  );
}
