import { networkInterfaces } from 'node:os';
import { Bonjour } from 'bonjour-service';
import { postLan, HttpError } from './net.ts';
import { pool } from './scanner.ts';

export interface KodiConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
}

export class KodiError extends Error {
  code: 'unreachable' | 'auth' | 'rpc';
  constructor(code: KodiError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

let rpcId = 0;

export async function kodiCall<T = unknown>(cfg: KodiConfig, method: string, params?: unknown, timeoutMs = 5000): Promise<T> {
  if (!cfg.host) throw new KodiError('unreachable', 'Kodi is not configured');
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params === undefined ? {} : { params }) });
  let text: string;
  try {
    text = await postLan(`http://${cfg.host}:${cfg.port}/jsonrpc`, body, {
      auth: cfg.pass ? { user: cfg.user || 'kodi', pass: cfg.pass } : undefined,
      timeoutMs,
    });
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) throw new KodiError('auth', 'Kodi needs a username/password');
    throw new KodiError('unreachable', `Kodi not reachable at ${cfg.host}:${cfg.port} (${(e as Error).message})`);
  }
  const json = JSON.parse(text) as { result?: T; error?: { message: string; data?: unknown } };
  if (json.error) throw new KodiError('rpc', `${method}: ${json.error.message}`);
  return json.result as T;
}

export interface FoundKodi {
  host: string;
  port: number;
  name: string;
  version?: string;
  needsAuth?: boolean;
}

async function probe(host: string, port: number): Promise<FoundKodi | undefined> {
  try {
    const r = await kodiCall<{ name: string; version: { major: number; minor: number } }>(
      { host, port }, 'Application.GetProperties', { properties: ['name', 'version'] }, 1500,
    );
    return { host, port, name: r.name, version: `${r.version.major}.${r.version.minor}` };
  } catch (e) {
    if (e instanceof KodiError && e.code === 'auth') return { host, port, name: 'Kodi', needsAuth: true };
    return undefined;
  }
}

function mdnsBrowse(ms: number): Promise<Array<{ host: string; port: number; name: string }>> {
  return new Promise((resolve) => {
    const found: Array<{ host: string; port: number; name: string }> = [];
    let b: Bonjour | undefined;
    try {
      b = new Bonjour();
      b.find({ type: 'xbmc-jsonrpc-h', protocol: 'tcp' }, (s) => {
        const ip = s.addresses?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? s.host;
        if (ip) found.push({ host: ip, port: s.port, name: s.name });
      });
    } catch {
      /* multicast unavailable */
    }
    setTimeout(() => {
      try {
        b?.destroy();
      } catch {
        /* ignore */
      }
      resolve(found);
    }, ms);
  });
}

function localSubnets(): string[] {
  const prefixes = new Set<string>();
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(a.address)) prefixes.add(a.address.split('.').slice(0, 3).join('.'));
    }
  }
  return [...prefixes];
}

/** Find Kodi boxes like the official remote apps do: Bonjour first, then a sweep of the local /24 on the default port. */
export async function discoverKodi(): Promise<FoundKodi[]> {
  const results = new Map<string, FoundKodi>();
  for (const s of await mdnsBrowse(2500)) {
    const k = await probe(s.host, s.port);
    if (k) results.set(`${k.host}:${k.port}`, { ...k, name: s.name || k.name });
  }
  if (!results.size) {
    const hosts = localSubnets().flatMap((p) => Array.from({ length: 254 }, (_, i) => `${p}.${i + 1}`));
    await pool(hosts, 48, async (h) => {
      const k = await probe(h, 8080);
      if (k) results.set(`${k.host}:${k.port}`, k);
    });
  }
  return [...results.values()];
}

// ---------- paths ----------

/** "multipath://smb%3a%2f%2fhost%2fa%2f/smb%3a.../" → ["smb://host/a/", ...] */
export function expandSourcePath(p: string): string[] {
  if (!p.startsWith('multipath://')) return [p];
  return p
    .slice('multipath://'.length)
    .split('/')
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));
}

/**
 * Work out how Kodi addresses the media root, e.g. "smb://192.168.0.24/video/MEDIA",
 * by matching Kodi's video sources against the top-level folders we see on disk.
 */
export function inferPathPrefix(sourcePaths: string[], topFolders: string[], rootName: string): string | undefined {
  const votes = new Map<string, number>();
  const tops = new Set(topFolders.map((f) => f.toLowerCase()));
  for (const raw of sourcePaths.flatMap(expandSourcePath)) {
    if (!/^(smb|nfs|sftp|ftp|dav|davs|https?):\/\//i.test(raw) && !raw.startsWith('/')) continue;
    const p = raw.replace(/\/+$/, '');
    const last = p.slice(p.lastIndexOf('/') + 1);
    let prefix: string | undefined;
    if (tops.has(last.toLowerCase())) prefix = p.slice(0, p.lastIndexOf('/'));
    else if (last.toLowerCase() === rootName.toLowerCase()) prefix = p;
    if (prefix) votes.set(prefix, (votes.get(prefix) ?? 0) + 1);
  }
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Kodi reads the share with its own SMB client, which wants the names as stored (NFC), not macOS's NFD listing. */
export function toKodiPath(prefix: string, rel: string, isDir = false): string {
  return `${prefix.replace(/\/+$/, '')}/${rel}${isDir ? '/' : ''}`.normalize('NFC');
}

/** Kodi file path → path relative to the media root (undefined if outside it). Handles stack:// multi-part files. */
export function fromKodiPath(prefix: string, file: string): string | undefined {
  let f = file;
  if (f.startsWith('stack://')) f = f.slice('stack://'.length).split(' , ')[0]!;
  const pre = prefix.replace(/\/+$/, '') + '/';
  if (!f.toLowerCase().startsWith(pre.toLowerCase())) return undefined;
  return f.slice(pre.length).replace(/\/+$/, '');
}

export async function detectPathPrefix(cfg: KodiConfig, topFolders: string[], rootName: string): Promise<string | undefined> {
  const r = await kodiCall<{ sources?: Array<{ file: string }> }>(cfg, 'Files.GetSources', { media: 'video' });
  return inferPathPrefix((r.sources ?? []).map((s) => s.file), topFolders, rootName);
}

/** Kodi art URL "image://https%3a%2f%2f...jpg/" → "https://...jpg" (TMDB originals downsized to w780). */
export function artUrl(art?: string): string | undefined {
  if (!art?.startsWith('image://')) return undefined;
  const url = decodeURIComponent(art.slice('image://'.length).replace(/\/$/, ''));
  if (!/^https?:\/\//.test(url)) return undefined;
  return url.replace('image.tmdb.org/t/p/original/', 'image.tmdb.org/t/p/w780/');
}

/** "plugin://plugin.video.youtube/play/?video_id=abc" or a YouTube URL → "abc" */
export function youtubeId(trailer?: string): string | undefined {
  if (!trailer) return undefined;
  const m = /(?:video_id=|youtu\.be\/|[?&]v=)([\w-]{6,})/.exec(trailer);
  return m?.[1];
}

// ---------- player ----------

export interface NowPlaying {
  active: boolean;
  playerId?: number;
  type?: string;
  title?: string;
  showTitle?: string;
  season?: number;
  episode?: number;
  year?: number;
  file?: string;
  poster?: string;
  fanart?: string;
  time?: number; // seconds
  total?: number;
  speed?: number;
  volume?: number;
  muted?: boolean;
  subtitlesOn?: boolean;
  subtitle?: SubtitleStream;
  audio?: AudioStream;
}

export interface AudioStream {
  index: number;
  language?: string; // ISO 639-2 as Kodi reports it ("fre", "eng")
  name?: string;
  codec?: string;
  channels?: number;
  isDefault?: boolean;
  isOriginal?: boolean;
  isImpaired?: boolean;
}

export interface SubtitleStream {
  index: number;
  language?: string;
  name?: string;
  isDefault?: boolean;
  isForced?: boolean;
  isImpaired?: boolean;
}

export interface Streams {
  active: boolean;
  audio: AudioStream[];
  subtitles: SubtitleStream[];
  currentAudio?: number;
  currentSubtitle?: number;
  subtitlesOn: boolean;
}

interface KodiAudio {
  index: number; language?: string; name?: string; codec?: string; channels?: number; isdefault?: boolean; isoriginal?: boolean; isimpaired?: boolean;
}
interface KodiSubtitle {
  index: number; language?: string; name?: string; isdefault?: boolean; isforced?: boolean; isimpaired?: boolean;
}

const toAudio = (a: KodiAudio): AudioStream => ({
  index: a.index, language: a.language || undefined, name: a.name || undefined, codec: a.codec || undefined,
  channels: a.channels || undefined, isDefault: a.isdefault, isOriginal: a.isoriginal, isImpaired: a.isimpaired,
});
const toSubtitle = (s: KodiSubtitle): SubtitleStream => ({
  index: s.index, language: s.language || undefined, name: s.name || undefined,
  isDefault: s.isdefault, isForced: s.isforced, isImpaired: s.isimpaired,
});
// Kodi sends an empty object (no index) when there is no current track.
const hasIndex = <T extends { index?: number }>(x?: T | null): x is T & { index: number } => typeof x?.index === 'number';

const secs = (t?: { hours: number; minutes: number; seconds: number }) => (t ? t.hours * 3600 + t.minutes * 60 + t.seconds : 0);

export async function nowPlaying(cfg: KodiConfig): Promise<NowPlaying> {
  const [players, app] = await Promise.all([
    kodiCall<Array<{ playerid: number; type: string }>>(cfg, 'Player.GetActivePlayers'),
    kodiCall<{ volume: number; muted: boolean }>(cfg, 'Application.GetProperties', { properties: ['volume', 'muted'] }),
  ]);
  const p = players.find((x) => x.type === 'video') ?? players[0];
  if (!p) return { active: false, volume: app.volume, muted: app.muted };
  const [item, props] = await Promise.all([
    kodiCall<{ item: { label: string; title?: string; showtitle?: string; season?: number; episode?: number; year?: number; file?: string; art?: Record<string, string> } }>(
      cfg, 'Player.GetItem', { playerid: p.playerid, properties: ['title', 'showtitle', 'season', 'episode', 'year', 'file', 'art'] },
    ),
    kodiCall<{
      time: { hours: number; minutes: number; seconds: number };
      totaltime: { hours: number; minutes: number; seconds: number };
      speed: number;
      subtitleenabled: boolean;
      currentsubtitle?: KodiSubtitle | null;
      currentaudiostream?: KodiAudio | null;
    }>(cfg, 'Player.GetProperties', {
      playerid: p.playerid,
      properties: ['time', 'totaltime', 'speed', 'subtitleenabled', 'currentsubtitle', 'currentaudiostream'],
    }),
  ]);
  const it = item.item;
  return {
    active: true,
    playerId: p.playerid,
    type: p.type,
    title: it.title || it.label,
    showTitle: it.showtitle || undefined,
    season: it.season && it.season >= 0 ? it.season : undefined,
    episode: it.episode && it.episode >= 0 ? it.episode : undefined,
    year: it.year || undefined,
    file: it.file,
    poster: artUrl(it.art?.poster ?? it.art?.['tvshow.poster'] ?? it.art?.thumb),
    fanart: artUrl(it.art?.fanart ?? it.art?.['tvshow.fanart']),
    time: secs(props.time),
    total: secs(props.totaltime),
    speed: props.speed,
    volume: app.volume,
    muted: app.muted,
    subtitlesOn: props.subtitleenabled,
    subtitle: hasIndex(props.currentsubtitle) ? toSubtitle(props.currentsubtitle) : undefined,
    audio: hasIndex(props.currentaudiostream) ? toAudio(props.currentaudiostream) : undefined,
  };
}

/** Every audio and subtitle track of what's playing, for the track pickers. */
export async function streams(cfg: KodiConfig): Promise<Streams> {
  const players = await kodiCall<Array<{ playerid: number; type: string }>>(cfg, 'Player.GetActivePlayers');
  const p = players.find((x) => x.type === 'video');
  if (!p) return { active: false, audio: [], subtitles: [], subtitlesOn: false };
  const r = await kodiCall<{
    audiostreams?: KodiAudio[];
    currentaudiostream?: KodiAudio | null;
    subtitles?: KodiSubtitle[];
    currentsubtitle?: KodiSubtitle | null;
    subtitleenabled: boolean;
  }>(cfg, 'Player.GetProperties', {
    playerid: p.playerid,
    properties: ['audiostreams', 'currentaudiostream', 'subtitles', 'currentsubtitle', 'subtitleenabled'],
  });
  return {
    active: true,
    audio: (r.audiostreams ?? []).map(toAudio),
    subtitles: (r.subtitles ?? []).map(toSubtitle),
    currentAudio: hasIndex(r.currentaudiostream) ? r.currentaudiostream.index : undefined,
    currentSubtitle: hasIndex(r.currentsubtitle) ? r.currentsubtitle.index : undefined,
    subtitlesOn: r.subtitleenabled,
  };
}

export type RemoteAction =
  | 'playpause' | 'stop' | 'next' | 'previous' | 'forward' | 'rewind' | 'seek'
  | 'up' | 'down' | 'left' | 'right' | 'select' | 'back' | 'home' | 'info' | 'menu' | 'osd'
  | 'volume' | 'mute' | 'subtitles' | 'audio';

const INPUT: Partial<Record<RemoteAction, string>> = {
  up: 'Input.Up', down: 'Input.Down', left: 'Input.Left', right: 'Input.Right', select: 'Input.Select',
  back: 'Input.Back', home: 'Input.Home', info: 'Input.Info', menu: 'Input.ContextMenu', osd: 'Input.ShowOSD',
};

export async function remote(cfg: KodiConfig, action: RemoteAction, value?: number): Promise<void> {
  const input = INPUT[action];
  if (input) {
    await kodiCall(cfg, input);
    return;
  }
  if (action === 'volume') {
    await kodiCall(cfg, 'Application.SetVolume', { volume: Math.max(0, Math.min(100, Math.round(value ?? 50))) });
    return;
  }
  if (action === 'mute') {
    await kodiCall(cfg, 'Application.SetMute', { mute: 'toggle' });
    return;
  }
  const players = await kodiCall<Array<{ playerid: number; type: string }>>(cfg, 'Player.GetActivePlayers');
  const playerid = (players.find((x) => x.type === 'video') ?? players[0])?.playerid;
  if (playerid === undefined) return;
  switch (action) {
    case 'playpause':
      await kodiCall(cfg, 'Player.PlayPause', { playerid });
      break;
    case 'stop':
      await kodiCall(cfg, 'Player.Stop', { playerid });
      break;
    case 'next':
    case 'previous':
      await kodiCall(cfg, 'Player.GoTo', { playerid, to: action });
      break;
    case 'forward':
    case 'rewind':
      await kodiCall(cfg, 'Player.Seek', { playerid, value: { seconds: action === 'forward' ? 30 : -10 } });
      break;
    case 'seek':
      await kodiCall(cfg, 'Player.Seek', { playerid, value: { percentage: Math.max(0, Math.min(100, value ?? 0)) } });
      break;
    case 'subtitles':
      // value: a track index, -1 = off, undefined = next track
      if (value === -1) await kodiCall(cfg, 'Player.SetSubtitle', { playerid, subtitle: 'off' });
      else await kodiCall(cfg, 'Player.SetSubtitle', { playerid, subtitle: value ?? 'next', enable: true });
      break;
    case 'audio':
      await kodiCall(cfg, 'Player.SetAudioStream', { playerid, stream: value ?? 'next' });
      break;
  }
}

/** Start playback of a file (path as Kodi sees it), or a library movie by id so Kodi offers to resume. */
export type PowerAction = 'shutdown' | 'reboot';

/** What the box running Kodi allows from the network (LibreELEC: both; a desktop install often neither). */
export async function powerOptions(cfg: KodiConfig): Promise<Record<PowerAction, boolean>> {
  const p = await kodiCall<{ canshutdown?: boolean; canreboot?: boolean }>(cfg, 'System.GetProperties', {
    properties: ['canshutdown', 'canreboot'],
  });
  return { shutdown: !!p.canshutdown, reboot: !!p.canreboot };
}

/** Kodi answers "OK" first, then powers the box down or restarts it. */
export async function power(cfg: KodiConfig, action: PowerAction): Promise<void> {
  await kodiCall(cfg, action === 'shutdown' ? 'System.Shutdown' : 'System.Reboot');
}

export async function play(cfg: KodiConfig, target: { file: string } | { movieid: number } | { episodeid: number }, resume = true): Promise<void> {
  await kodiCall(cfg, 'Player.Open', { item: target, options: { resume } }, 10000);
}

export async function playTrailer(cfg: KodiConfig, youtube: string): Promise<void> {
  await kodiCall(cfg, 'Player.Open', { item: { file: `plugin://plugin.video.youtube/play/?video_id=${encodeURIComponent(youtube)}` } }, 10000);
}

/** Type into Kodi's on-screen keyboard and confirm it, as pressing Done on the TV. */
export async function sendText(cfg: KodiConfig, text: string): Promise<void> {
  await kodiCall(cfg, 'Input.SendText', { text, done: true });
}
