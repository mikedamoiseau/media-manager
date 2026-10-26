import type { KodiTv } from './db.ts';

/** A TV that can't be saved as asked: the message says why. */
export class TvError extends Error {}

export type TvInput = Partial<Omit<KodiTv, 'id'>>;

/** Its number: tv3 is 3. */
export function tvNumber(id: string): number {
  return Number(/^tv(\d+)$/.exec(id)?.[1] ?? 0);
}

/** The TV a request is for: the one asked, else the first (also when the one asked was removed since). */
export function pickTv(tvs: KodiTv[], id: string | undefined): KodiTv | undefined {
  return tvs.find((t) => t.id === id) ?? tvs[0];
}

/** The TV a VLC handoff stops: the one its link names, none if removed since; links without one, the first. */
export function handoffTv(tvs: KodiTv[], id: string | undefined): KodiTv | undefined {
  return id === undefined ? tvs[0] : tvs.find((t) => t.id === id);
}

/**
 * One more TV: a name and an address, Kodi's defaults for the rest. Its id comes after the highest given
 * (`last`, removed TVs included): a phone still set to a removed TV must not get a new one in its place.
 */
export function addTv(tvs: KodiTv[], input: TvInput, last = 0): KodiTv[] {
  const n = Math.max(last, ...tvs.map((t) => tvNumber(t.id)));
  const tv = checked(tvs, { id: `tv${n + 1}`, name: '', host: '', port: 8080, user: 'kodi', pass: '', pathPrefix: '', ...defined(input) });
  return [...tvs, tv];
}

/**
 * A TV changed: the password shown hidden ("••••") stays as it was. Another address with the media path
 * left as it was: that path is worked out again, from the Kodi at the new address.
 */
export function editTv(tvs: KodiTv[], id: string, patch: TvInput): KodiTv[] {
  const tv = tvs.find((t) => t.id === id);
  if (!tv) throw new TvError('TV not found');
  const { pass, ...rest } = defined(patch);
  const next = checked(tvs, { ...tv, ...rest, ...(pass !== undefined && pass !== '••••' ? { pass } : {}) });
  if (next.host !== tv.host && next.pathPrefix === tv.pathPrefix) next.pathPrefix = '';
  return tvs.map((t) => (t.id === id ? next : t));
}

export function removeTv(tvs: KodiTv[], id: string): KodiTv[] {
  return tvs.filter((t) => t.id !== id);
}

/** For the app: passwords hidden. */
export function publicTvs(tvs: KodiTv[]): KodiTv[] {
  return tvs.map((t) => ({ ...t, pass: t.pass ? '••••' : '' }));
}

function defined(input: TvInput): TvInput {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
}

function checked(tvs: KodiTv[], tv: KodiTv): KodiTv {
  const t = { ...tv, name: tv.name.trim(), host: tv.host.trim(), user: tv.user.trim(), pathPrefix: tv.pathPrefix.trim(), port: Number(tv.port) || 8080 };
  if (!t.name) throw new TvError('Give the TV a name');
  if (!t.host) throw new TvError("Type the Kodi box's address");
  const same = tvs.find((o) => o.id !== t.id && o.host === t.host && o.port === t.port);
  if (same) throw new TvError(`This Kodi box is already saved as ${same.name}`);
  return t;
}

/** The library syncs from the first TV: again when that is another TV, or one reached another way. */
export function firstTvChanged(before: KodiTv[], after: KodiTv[]): boolean {
  const [a, b] = [before[0], after[0]];
  if (!b) return false;
  if (!a || a.id !== b.id) return true;
  return a.host !== b.host || a.port !== b.port || a.user !== b.user || a.pass !== b.pass || a.pathPrefix !== b.pathPrefix;
}

/** No TV was ever set up: look for a Kodi box on the network. Not once the TVs were all removed. */
export function firstRun(s: { kodiTvs: KodiTv[]; kodiTvLast: number }): boolean {
  return !s.kodiTvs.length && !s.kodiTvLast;
}
