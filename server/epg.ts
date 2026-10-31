/**
 * TV guides in XMLTV, the standard format: read while they download (the biggest, xmltvfr's, is 135 MB unpacked),
 * and matched to the channels of the playlist.
 */

export interface GuideChannel {
  id: string;
  name: string;
}

export interface Programme {
  channel: string;
  start: number;
  stop: number;
  title: string;
  sub?: string;
  category?: string;
  descr?: string;
  icon?: string;
}

/** A source's channel ids, by their lower-case spelling (ids are compared without case). */
export interface GuideIds {
  source: string;
  ids: Map<string, string>;
}

/** "20261028120000 +0100" as a time; without an offset, UTC. */
export function xmltvTime(s: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(?:([+-])(\d{2})(\d{2}))?/.exec(s.trim());
  if (!m) return NaN;
  const utc = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  const offset = m[7] ? (m[7] === '-' ? -1 : 1) * (+m[8]! * 60 + +m[9]!) : 0;
  return utc - offset * 60_000;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function entities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] !== '#') return ENTITIES[e] ?? all;
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });
}

/** XML text as it reads: entities decoded, except inside CDATA, which is taken as written. */
function decode(s: string): string {
  return s
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map((part, i) => (i % 2 ? part.slice(9, -3) : entities(part)))
    .join('');
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? decode(m[1] ?? m[2] ?? '') : undefined;
}

/** The text of the first <tag> in an element; none when missing or empty. */
function text(el: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(el);
  const t = m ? decode(m[1]!).trim() : '';
  return t || undefined;
}

function channelOf(el: string): GuideChannel | null {
  const id = attr(el.slice(0, el.indexOf('>')), 'id');
  return id ? { id, name: text(el, 'display-name') ?? id } : null;
}

function programmeOf(el: string): Programme | null {
  const head = el.slice(0, el.indexOf('>'));
  const channel = attr(head, 'channel');
  const start = xmltvTime(attr(head, 'start') ?? '');
  const stop = xmltvTime(attr(head, 'stop') ?? '');
  const title = text(el, 'title');
  if (!channel || !title || Number.isNaN(start) || Number.isNaN(stop)) return null;
  const p: Programme = { channel, start, stop, title };
  const sub = text(el, 'sub-title');
  const category = text(el, 'category');
  const descr = text(el, 'desc');
  const icon = /<icon\s[^>]*src=(?:"([^"]*)"|'([^']*)')/.exec(el);
  if (sub) p.sub = sub;
  if (category) p.category = category;
  if (descr) p.descr = descr;
  if (icon) p.icon = decode(icon[1] ?? icon[2] ?? '');
  return p;
}

/**
 * Hands over each channel and programme as soon as its element is complete, keeping only what is not read yet:
 * the whole file is never in memory. Programmes without a channel, a time or a title are skipped. True when the
 * document ends (`</tv>`): a download cut short gives false.
 */
export async function readXmltv(
  text: AsyncIterable<string>,
  on: { channel(c: GuideChannel): void; programme(p: Programme): void },
): Promise<boolean> {
  const open = /<!--|<(channel|programme)[\s>]/g;
  let buf = '';
  let ended = false;
  for await (const chunk of text) {
    buf += chunk;
    let pos = 0;
    for (;;) {
      open.lastIndex = pos;
      const m = open.exec(buf);
      // Nothing begins here: keep a tail long enough to hold the start of the next element. Text between
      // elements is where the document's own end can be (not one quoted in a comment or a description).
      if (!m) {
        if (buf.includes('</tv>', pos)) ended = true;
        pos = Math.max(pos, buf.length - 16);
        break;
      }
      // A comment: what it holds is not read, even when it looks like an element.
      if (!m[1]) {
        const end = buf.indexOf('-->', m.index + 4);
        if (end < 0) {
          pos = m.index;
          break;
        }
        pos = end + 3;
        continue;
      }
      const close = `</${m[1]}>`;
      const end = buf.indexOf(close, m.index);
      if (end < 0) {
        pos = m.index;
        break;
      }
      const el = buf.slice(m.index, end + close.length);
      if (m[1] === 'channel') {
        const c = channelOf(el);
        if (c) on.channel(c);
      } else {
        const p = programmeOf(el);
        if (p) on.programme(p);
      }
      pos = end + close.length;
    }
    buf = buf.slice(pos);
  }
  return ended;
}

// Characters XML 1.0 can't hold, even as entities (a guide's text may bring them along).
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;
const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s: string) => s.replace(NOT_XML, '').replace(/[&<>"]/g, (c) => XML_ESCAPES[c]!);
const utcTime = (t: number) => `${new Date(t).toISOString().slice(0, 19).replace(/\D/g, '')} +0000`;

/** The owner's channels as a guide for Kodi (XMLTV), under the ids the TVs' list gives them (`key`: its tvg-id). */
export function guideXml(channels: Array<{ key: string; name: string; logo: string; programmes: Array<Omit<Programme, 'channel'>> }>): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="Cinematheque">'];
  for (const c of channels) {
    out.push(`<channel id="${esc(c.key)}"><display-name>${esc(c.name)}</display-name>${c.logo ? `<icon src="${esc(c.logo)}"/>` : ''}</channel>`);
  }
  for (const c of channels) {
    for (const p of c.programmes) {
      const parts = [`<title>${esc(p.title)}</title>`];
      if (p.sub) parts.push(`<sub-title>${esc(p.sub)}</sub-title>`);
      if (p.descr) parts.push(`<desc>${esc(p.descr)}</desc>`);
      if (p.category) parts.push(`<category>${esc(p.category)}</category>`);
      if (p.icon) parts.push(`<icon src="${esc(p.icon)}"/>`);
      out.push(`<programme start="${utcTime(p.start)}" stop="${utcTime(p.stop)}" channel="${esc(c.key)}">${parts.join('')}</programme>`);
    }
  }
  out.push('</tv>');
  return `${out.join('\n')}\n`;
}

/** Channels the guide still lists under their old names (playlist id without its feed, lower case → guide id). */
export const GUIDE_ALIASES: Record<string, string> = {
  'tfx.fr': 'NT1.fr',
  'lcp.fr': 'LaChaineParlementaire.fr',
  'rmcstory.fr': 'Numero23.fr',
  'lequipe.fr': 'LEquipe21.fr',
};

/**
 * The guide channel of a playlist channel, sources in their order: its tvg-id without the feed ("TF1.fr@SD" is
 * "TF1.fr"), then an old name, then a Pluto TV or Samsung TV Plus id read from its stream address ("…/plu-<id>.m3u8",
 * "…/stvp-<id>").
 */
export function matchGuide(entry: { key: string; url: string }, guides: GuideIds[]): { source: string; id: string } | null {
  const candidates = guideCandidates(entry);
  for (const g of guides) {
    for (const k of candidates) {
      const id = g.ids.get(k);
      if (id) return { source: g.source, id };
    }
  }
  return null;
}

/** The guide ids a playlist channel may have, lower case, in the order they are tried. */
export function guideCandidates(entry: { key: string; url: string }): string[] {
  const base = entry.key.replace(/@.*$/, '').toLowerCase();
  const alias = GUIDE_ALIASES[base]?.toLowerCase();
  const pluto = /plu-([0-9a-f]{24})/.exec(entry.url)?.[1];
  const samsung = /stvp-([A-Za-z0-9]+)/.exec(entry.url)?.[1]?.toLowerCase();
  return [base, alias, pluto, samsung].filter((k): k is string => !!k);
}
