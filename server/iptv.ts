/**
 * iptv-org's channel lists (M3U) in, and out: the one list both TVs read from the NAS, and the one-channel
 * playlist VLC gets for a channel that needs request headers.
 */

export interface M3uEntry {
  /** tvg-id with its feed: TF1.fr@SD */
  key: string;
  name: string;
  logo: string;
  group: string;
  /** The #EXTVLCOPT / #KODIPROP lines (user agent, referrer…), as written */
  opts: string[];
  url: string;
}

/** The attributes and the name of an #EXTINF line: the name starts after the first comma outside quotes. */
function splitInfo(info: string): { attrs: Record<string, string>; name: string } {
  let quoted = false;
  let i = 0;
  for (; i < info.length; i++) {
    if (info[i] === '"') quoted = !quoted;
    else if (info[i] === ',' && !quoted) break;
  }
  const attrs = Object.fromEntries([...info.slice(0, i).matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
  return { attrs, name: info.slice(i + 1) };
}

/** iptv-org's entries; one without a tvg-id is left out (it has no key to be picked by). */
export function parseM3u(text: string): M3uEntry[] {
  const out: M3uEntry[] = [];
  let info: string | null = null;
  let opts: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF')) {
      info = line;
      opts = [];
    } else if (info && (line.startsWith('#EXTVLCOPT') || line.startsWith('#KODIPROP'))) {
      opts.push(line);
    } else if (info && line && !line.startsWith('#')) {
      const { attrs, name } = splitInfo(info);
      if (attrs['tvg-id']) {
        out.push({ key: attrs['tvg-id'], name: cleanName(name), logo: attrs['tvg-logo'] ?? '', group: attrs['group-title'] ?? '', opts, url: line });
      }
      info = null;
      opts = [];
    }
  }
  return out;
}

/** "M6 HD (1080p)" is "M6 HD", "Joe FM (720p) [Not 24/7]" is "Joe FM". */
export function cleanName(raw: string): string {
  let s = raw.trim();
  for (let prev = ''; s !== prev; ) {
    prev = s;
    s = s.replace(/\s*(\(\d+[pi]\)|\[[^\]]*\])$/i, '').trim();
  }
  return s;
}

/** Names told apart: the second "LCI" is "LCI 2". The TVs find a channel by its name. */
export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  const count = new Map<string, number>();
  return names.map((n) => {
    let k = count.get(n) ?? 0;
    let name: string;
    do {
      k++;
      name = k === 1 ? n : `${n} ${k}`;
    } while (used.has(name));
    count.set(n, k);
    used.add(name);
    return name;
  });
}

// Kodi's M3U reader has no escaping: a quote or a line break would cut the entry.
const value = (s: string) => s.replace(/["\r\n]/g, '').trim();
const line = (s: string) => s.replace(/[\r\n]/g, '').trim();

/** The list both TVs read: numbered in this order (tvg-chno), under the names given. */
export function buildM3u(channels: Array<{ entry: M3uEntry; name: string }>): string {
  const lines = ['#EXTM3U'];
  channels.forEach(({ entry: e, name }, i) => {
    const n = value(name);
    lines.push(`#EXTINF:-1 tvg-id="${value(e.key)}" tvg-chno="${i + 1}" tvg-name="${n}" tvg-logo="${value(e.logo)}" group-title="${value(e.group)}",${n}`);
    lines.push(...e.opts.map(line), line(e.url));
  });
  return `${lines.join('\n')}\n`;
}

/** One channel for VLC on the phone, with the option lines a bare link can't carry. */
export function channelPlaylist(name: string, entry: M3uEntry): string {
  return `${['#EXTM3U', `#EXTINF:-1,${value(name)}`, ...entry.opts.map(line), line(entry.url)].join('\n')}\n`;
}
