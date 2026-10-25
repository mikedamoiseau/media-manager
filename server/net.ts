import { execFile } from 'node:child_process';

// macOS "Local Network" privacy can block a Homebrew node binary from reaching LAN hosts (EHOSTUNREACH),
// while Apple-signed /usr/bin/curl is allowed. LAN calls (Kodi) therefore fall back to curl when that happens.

let useCurl = false;
let curlSince = 0;
const RETRY_FETCH_MS = 5 * 60_000;

export interface PostOptions {
  auth?: { user: string; pass: string };
  timeoutMs?: number;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function isLanBlock(e: unknown): boolean {
  const code = (e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code;
  return code === 'EHOSTUNREACH' || code === 'ENETUNREACH';
}

async function viaFetch(url: string, body: string, opts: PostOptions): Promise<string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.auth?.pass) headers.authorization = 'Basic ' + Buffer.from(`${opts.auth.user}:${opts.auth.pass}`).toString('base64');
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 5000) });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`);
  return text;
}

function viaCurl(url: string, body: string, opts: PostOptions): Promise<string> {
  const secs = String((opts.timeoutMs ?? 5000) / 1000);
  const args = ['-sS', '-X', 'POST', '-H', 'content-type: application/json', '--data-binary', '@-', '--max-time', secs,
    '--connect-timeout', String(Math.min(Number(secs), 2)), '-w', '\n%{http_code}', url];
  if (opts.auth?.pass) args.unshift('-u', `${opts.auth.user}:${opts.auth.pass}`);
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/curl', args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      // Never surface err.message: it contains the full command line, password included.
      if (err) return reject(new Error(stderr.trim().split('\n')[0] || `curl exited with code ${err.code ?? '?'}`));
      const nl = stdout.lastIndexOf('\n');
      const status = Number(stdout.slice(nl + 1));
      if (status < 200 || status >= 300) return reject(new HttpError(status, `HTTP ${status}`));
      resolve(stdout.slice(0, nl));
    });
    child.stdin?.end(body);
  });
}

/** POST a JSON body to a LAN host and return the response text. */
export async function postLan(url: string, body: string, opts: PostOptions = {}): Promise<string> {
  if (useCurl && Date.now() - curlSince > RETRY_FETCH_MS) useCurl = false;
  if (useCurl) return viaCurl(url, body, opts);
  try {
    return await viaFetch(url, body, opts);
  } catch (e) {
    if (!isLanBlock(e)) throw e;
    useCurl = true;
    curlSince = Date.now();
    return viaCurl(url, body, opts);
  }
}

export function lanTransport(): 'fetch' | 'curl' {
  return useCurl ? 'curl' : 'fetch';
}
