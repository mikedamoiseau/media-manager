import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { isLanBlock } from './net.ts';

// Kodi only announces events (such as its on-screen keyboard opening) to clients that stay connected:
// JSON-RPC over TCP on port 9090, which needs "Allow remote control from applications on other systems".
// HTTP calls can't receive them, so one connection is kept open here.

/** Kodi's keyboard waiting for text: what for (keyboard, password, number, ip, date, time…) and what it holds. */
export interface KodiInput {
  /** new for each time the keyboard opens */
  id: number;
  type: string;
  title: string;
  value: string;
}

/** Kodi started or stopped playing: the film or episode of its library (none for other videos), and whether it reached its end. */
export interface PlayerEvent {
  kind: 'play' | 'stop' | 'pause' | 'resume';
  item?: { type: string; id: number };
  ended?: boolean;
}

export interface Pipe {
  write(text: string): void;
  close(): void;
}
export type Opener = (host: string, port: number, on: { data(text: string): void; end(err?: Error): void }) => Pipe;

export const openTcp: Opener = (host, port, on) => {
  const s = connect({ host, port });
  s.setEncoding('utf8');
  s.on('data', (d: string) => on.data(d));
  s.on('error', (e) => on.end(e));
  s.on('close', () => on.end());
  return { write: (t) => void s.write(t), close: () => s.destroy() };
};

/** Through Apple's /usr/bin/nc, which macOS lets reach the LAN when it blocks node (as curl for HTTP). */
export const openNc: Opener = (host, port, on) => {
  const child = spawn('/usr/bin/nc', ['--', host, String(port)]);
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => on.data(d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  child.stdin.on('error', () => {}); // EPIPE once nc has exited
  child.on('error', (e) => on.end(e));
  child.on('close', (code) => on.end(new Error(stderr.trim().split('\n')[0] || `nc exited with code ${code}`)));
  return { write: (t) => void child.stdin.write(t), close: () => child.kill() };
};

/** Kodi sends JSON objects back to back on the socket, cut anywhere: hand them over one by one. */
export function jsonSplitter(onJson: (text: string) => void): (chunk: string) => void {
  let buf = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  return (chunk) => {
    let i = buf.length;
    buf += chunk;
    for (; i < buf.length; i++) {
      const c = buf[i];
      if (depth === 0) {
        // Between objects: skip whitespace (and anything else) up to the next one.
        if (c === '{' || c === '[') {
          buf = buf.slice(i);
          i = 0;
          depth = 1;
        }
      } else if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{' || c === '[') depth++;
      else if ((c === '}' || c === ']') && --depth === 0) {
        onJson(buf.slice(0, i + 1));
        buf = buf.slice(i + 1);
        i = -1;
      }
    }
    if (depth === 0) buf = '';
  };
}

const PING = '{"jsonrpc":"2.0","id":"ping","method":"JSONRPC.Ping"}';
const PING_EVERY = 30_000;
// No answer for this long: the box went away without closing the connection (powered off, Wi-Fi).
const DEAD_AFTER = 75_000;
const RETRY_FIRST = 5_000;
const RETRY_MAX = 60_000;

/** The connection to Kodi's event stream: whether it's up, and the keyboard Kodi shows, if any. */
export class KodiEvents {
  live = false;
  error: string | undefined;
  input: KodiInput | null = null;
  private host: string | undefined;
  private pipe: Pipe | undefined;
  private viaNc = false;
  private retry = RETRY_FIRST;
  private retryTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private lastHeard = 0;
  private seq = 0;
  // Bumped whenever a connection is let go, so its late events are ignored.
  private gen = 0;
  private onChange: () => void;
  private open: { tcp: Opener; nc: Opener };
  private port: number;
  private onPlayer: ((e: PlayerEvent) => void) | undefined;

  constructor(onChange: () => void, open = { tcp: openTcp, nc: openNc }, port = 9090, onPlayer?: (e: PlayerEvent) => void) {
    this.onChange = onChange;
    this.open = open;
    this.port = port;
    this.onPlayer = onPlayer;
  }

  /** (Re)connect to Kodi at this host; none: stay disconnected. */
  connect(host: string | undefined): void {
    this.stop();
    this.host = host || undefined;
    this.viaNc = false;
    this.retry = RETRY_FIRST;
    if (this.host) this.dial();
  }

  stop(): void {
    this.hangUp();
    clearTimeout(this.retryTimer);
    this.host = undefined;
    const changed = this.live || !!this.input;
    this.live = false;
    this.input = null;
    this.error = undefined;
    if (changed) this.onChange();
  }

  private hangUp(): void {
    this.gen++;
    clearInterval(this.pingTimer);
    this.pipe?.close();
    this.pipe = undefined;
  }

  private dial(): void {
    const gen = ++this.gen;
    const split = jsonSplitter((text) => gen === this.gen && this.message(text));
    const pipe = (this.viaNc ? this.open.nc : this.open.tcp)(this.host!, this.port, {
      data: (text) => gen === this.gen && split(text),
      end: (err) => gen === this.gen && this.dropped(err),
    });
    if (gen !== this.gen) return pipe.close(); // ended while opening
    this.pipe = pipe;
    this.lastHeard = Date.now();
    pipe.write(PING);
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastHeard > DEAD_AFTER) this.dropped(new Error('Kodi stopped answering'));
      else this.pipe?.write(PING);
    }, PING_EVERY);
  }

  private dropped(err?: Error): void {
    this.hangUp();
    if (!this.viaNc && isLanBlock(err)) {
      this.viaNc = true;
      this.dial();
      return;
    }
    if (this.live) this.retry = RETRY_FIRST;
    this.live = false;
    this.input = null;
    this.error = err?.message ?? 'Connection closed';
    this.onChange();
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.dial(), this.retry);
    this.retry = Math.min(this.retry * 2, RETRY_MAX);
  }

  private message(text: string): void {
    let m: {
      result?: unknown;
      method?: string;
      params?: { data?: { type?: string; title?: string; value?: string; item?: { type?: string; id?: number }; end?: boolean } | null };
    };
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    this.lastHeard = Date.now();
    if (m.result === 'pong') {
      this.retry = RETRY_FIRST;
      if (!this.live) {
        this.live = true;
        this.error = undefined;
        this.onChange();
      }
    } else if (m.method === 'Input.OnInputRequested') {
      const d = m.params?.data ?? {};
      this.input = { id: ++this.seq, type: d.type ?? 'keyboard', title: d.title ?? '', value: d.value ?? '' };
      this.onChange();
    } else if (m.method === 'Input.OnInputFinished' && this.input) {
      this.input = null;
      this.onChange();
    } else if (m.method === 'Player.OnPlay' || m.method === 'Player.OnStop') {
      const it = m.params?.data?.item;
      const item = it?.type && Number.isInteger(it.id) && it.id! > 0 ? { type: it.type, id: it.id! } : undefined;
      if (m.method === 'Player.OnPlay') this.onPlayer?.({ kind: 'play', item });
      else this.onPlayer?.({ kind: 'stop', item, ended: !!m.params?.data?.end });
    } else if (m.method === 'Player.OnPause' || m.method === 'Player.OnResume') {
      this.onPlayer?.({ kind: m.method === 'Player.OnPause' ? 'pause' : 'resume' });
    }
  }
}
