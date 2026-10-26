import type { NowPlaying } from './types.ts';

const nav = globalThis.navigator as { userAgent?: string; maxTouchPoints?: number } | undefined;
const ua = nav?.userAgent ?? '';

/** iPhone, iPod, or iPad (which reports itself as a Mac with a touch screen). */
export const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1);

/** An iPad (iPadOS reports itself as a Mac with a touch screen). */
export const isTablet = /iPad/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1);

/**
 * The original file, served with byte ranges so the player can seek. The name is only what VLC shows;
 * the profile, whose progress VLC makes.
 */
export function mediaUrl(origin: string, kind: 'item' | 'episode', id: number, name: string, profile?: number): string {
  return new URL(`/api/media/${kind}/${id}/${encodeURIComponent(name)}${profile ? `?p=${profile}` : ''}`, origin).href;
}

/**
 * The playlist that hands a video over to VLC (see server/media.ts vlcPlaylist): where to start, the
 * tracks, and a key new each time, so VLC treats it as an address it has never seen.
 */
export function handoffUrl(
  origin: string,
  kind: 'item' | 'episode',
  id: number,
  o: { start: number; audio?: number; sub?: number | 'off'; tv?: string; profile?: number },
  key: string,
  name: string,
): string {
  const parts = [`t${Math.max(0, Math.floor(o.start))}`];
  if (o.audio !== undefined) parts.push(`a${o.audio}`);
  if (o.sub !== undefined) parts.push(o.sub === 'off' ? 'soff' : `s${o.sub}`);
  if (o.tv) parts.push(`v${o.tv}`);
  if (o.profile) parts.push(`p${o.profile}`);
  parts.push(`k${key}`);
  return new URL(`/api/handoff/${kind}/${id}/${parts.join('-')}/${encodeURIComponent(name)}.m3u`, origin).href;
}

/**
 * Hand a video to VLC for iOS (x-callback-url "stream": plays without asking to download).
 * `back` is the page VLC reopens when you tap Done.
 */
export function vlcLink(url: string, back: string | null): string {
  return `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(url)}${back ? `&x-success=${encodeURIComponent(back)}` : ''}`;
}

/** What VLC shows for an episode: "Show S01E05.mkv", or the file name when it has no number. */
export function episodeName(show: string, e: { name: string; season: number | null; episode: number | null }): string {
  const ext = /\.[^./]+$/.exec(e.name)?.[0] ?? '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const num = e.season != null && e.episode != null ? ` S${pad(e.season)}E${pad(e.episode)}` : e.episode != null ? ` E${pad(e.episode)}` : '';
  return num ? `${show}${num}${ext}` : e.name;
}

// Back a little when taking over on the phone, to pick up the thread.
const HANDOFF_REWIND = 5;

/**
 * VLC on the phone taking over from the TV: a few seconds before where the TV is, with its audio and
 * subtitle tracks, named like the episode or the film. The TV stops once VLC loads the playlist, so
 * nothing stops when VLC doesn't open. `key`: new for each link; `tv`: the TV to stop; `profile`: whose
 * progress VLC makes. Null when Kodi plays no file of the library.
 */
export function handoffLink(origin: string, np: NowPlaying, back: string | null, key: string, tv?: string, profile?: number): string | null {
  const m = np.media;
  if (!m) return null;
  const name =
    m.kind === 'episode' && np.showTitle
      ? episodeName(np.showTitle, { name: `${np.showTitle} - ${np.title ?? 'Episode'}${m.ext}`, season: np.season ?? null, episode: np.episode ?? null })
      : `${np.title ?? 'Video'}${m.ext}`;
  const sub: number | 'off' | undefined = np.subtitlesOn === false ? 'off' : np.subtitlesOn && np.subtitle ? np.subtitle.index : undefined;
  const o = { start: (np.time ?? 0) - HANDOFF_REWIND, audio: np.audio?.index, sub, tv, profile };
  return vlcLink(handoffUrl(origin, m.kind, m.id, o, key, name), back);
}

/**
 * Where VLC's Done button returns: this page in Safari. Not from the home-screen app, where the
 * link would open Safari instead of the app.
 */
export function vlcBack(): string | null {
  const g = globalThis as { matchMedia?: (q: string) => { matches: boolean }; location?: { href: string } };
  const standalone = g.matchMedia?.('(display-mode: standalone)').matches || (nav as { standalone?: boolean } | undefined)?.standalone === true;
  return standalone ? null : (g.location?.href ?? null);
}

export const VLC_APP_STORE = 'https://apps.apple.com/app/id650377962';
