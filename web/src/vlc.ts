const nav = globalThis.navigator as { userAgent?: string; maxTouchPoints?: number } | undefined;
const ua = nav?.userAgent ?? '';

/** iPhone, iPod, or iPad (which reports itself as a Mac with a touch screen). */
export const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1);

/** The original file, served with byte ranges so the player can seek. The name is only what VLC shows. */
export function mediaUrl(origin: string, kind: 'item' | 'episode', id: number, name: string): string {
  return new URL(`/api/media/${kind}/${id}/${encodeURIComponent(name)}`, origin).href;
}

/**
 * Hand a video to VLC for iOS (x-callback-url "stream": plays without asking to download).
 * `back` is the page VLC reopens when you tap Done.
 */
export function vlcLink(url: string, back: string | null): string {
  return `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(url)}${back ? `&x-success=${encodeURIComponent(back)}` : ''}`;
}

export const VLC_APP_STORE = 'https://apps.apple.com/app/id650377962';
