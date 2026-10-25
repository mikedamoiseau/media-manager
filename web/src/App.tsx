import { useEffect, useRef } from 'react';
import { useLocation, useRoute } from 'wouter';
import { Library } from './components/Library.tsx';
import { DetailView } from './components/Detail.tsx';
import { FilmView } from './components/Film.tsx';
import { Review } from './components/Review.tsx';
import { Remote } from './components/Remote.tsx';
import { SettingsView } from './components/Settings.tsx';
import { NowPlayingBar } from './components/NowPlayingBar.tsx';
import { Toasts } from './components/Toasts.tsx';
import { KodiKeyboard } from './components/KodiKeyboard.tsx';
import { IconFilm, IconInbox, IconRemote, IconSettings } from './components/icons.tsx';
import { useStore, status, online } from './store.ts';

type Tab = 'library' | 'review' | 'remote' | 'settings';

const TABS: Array<{ key: Tab; path: string; label: string; Icon: typeof IconFilm }> = [
  { key: 'library', path: '/', label: 'Library', Icon: IconFilm },
  { key: 'review', path: '/review', label: 'To review', Icon: IconInbox },
  { key: 'remote', path: '/remote', label: 'Remote', Icon: IconRemote },
  { key: 'settings', path: '/settings', label: 'Settings', Icon: IconSettings },
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
  const reviewCount = (st?.counts.unmatched ?? 0) + (st?.counts.pending ?? 0);

  const closeDetail = () => {
    if ((history.state as { fromApp?: boolean } | null)?.fromApp) history.back();
    else navigate(TABS.find((t) => t.key === lastTab.current)!.path, { replace: true });
  };

  useEffect(() => {
    document.body.classList.toggle('has-overlay', !!params);
  }, [params]);

  return (
    <div className="app">
      {!isOnline && <div className="offline">Reconnecting to the media server…</div>}
      <main className="pages">
        <section className="page" hidden={tab !== 'library'}>
          <Library active={tab === 'library' && !params} />
        </section>
        <section className="page" hidden={tab !== 'review'}>
          {tab === 'review' && <Review />}
        </section>
        <section className="page" hidden={tab !== 'remote'}>
          {tab === 'remote' && <Remote />}
        </section>
        <section className="page" hidden={tab !== 'settings'}>
          {tab === 'settings' && <SettingsView />}
        </section>
      </main>

      {titleParams && <DetailView key={titleParams.id} id={Number(titleParams.id)} onClose={closeDetail} />}
      {filmParams && <FilmView key={filmParams.id} id={Number(filmParams.id)} onClose={closeDetail} />}

      <footer className="chrome">
        {tab !== 'remote' && <NowPlayingBar />}
        <nav className="tabbar" aria-label="Sections">
          {TABS.map(({ key, path, label, Icon }) => (
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
      <KodiKeyboard />
      <Toasts />
    </div>
  );
}
