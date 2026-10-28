import { type KodiConfig, KodiError, kodiCall } from './kodi.ts';
import { KIDS_VIEW } from './kidsTag.ts';

type KodiChannel = { channelid: number; channel: string; channelnumber: number };

/**
 * A channel of the owner's list on a TV: by the name the app wrote, then that name without case; when several
 * share it, the one at its number. Channel ids are each TV's own: never one TV's id on another.
 */
export function findChannel(list: KodiChannel[], want: { name: string; number: number }): number | undefined {
  let same = list.filter((c) => c.channel === want.name);
  if (!same.length) same = list.filter((c) => c.channel.toLowerCase() === want.name.toLowerCase());
  return (same.find((c) => c.channelnumber === want.number) ?? same[0])?.channelid;
}

/** The TV shows its kids view (Lumen's skin setting); undefined when Kodi doesn't answer. */
export async function kidsViewOn(cfg: KodiConfig, call: typeof kodiCall = kodiCall): Promise<boolean | undefined> {
  const setting = `Skin.HasSetting(${KIDS_VIEW})`;
  try {
    const r = await call<Record<string, boolean>>(cfg, 'XBMC.GetInfoBooleans', { booleans: [setting] }, 3000);
    return r[setting] === true;
  } catch {
    return undefined;
  }
}

/**
 * Starts one of the owner's channels on a TV. Never on a TV showing its kids view, nor when that can't be
 * read. A TV without the channel (it hasn't read the new list yet) says so; one that refuses to give its
 * channels (no live TV set up there, or another refusal Kodi doesn't name) says that instead.
 */
export async function startChannel(
  cfg: KodiConfig,
  want: { name: string; number: number },
  call: typeof kodiCall = kodiCall,
): Promise<'started' | 'kids_view' | 'kids_unknown' | 'not_loaded' | 'no_live_tv'> {
  const kids = await kidsViewOn(cfg, call);
  if (kids === undefined) return 'kids_unknown';
  if (kids) return 'kids_view';
  let list: KodiChannel[];
  try {
    list = (await call<{ channels?: KodiChannel[] }>(cfg, 'PVR.GetChannels', { channelgroupid: 'alltv', properties: ['channel', 'channelnumber'] })).channels ?? [];
  } catch (e) {
    // Kodi answers but won't list channels ("Failed to execute method" says no more): most likely no live TV there.
    if (e instanceof KodiError && e.code === 'rpc') return 'no_live_tv';
    throw e;
  }
  const id = findChannel(list, want);
  if (id === undefined) return 'not_loaded';
  await call(cfg, 'Player.Open', { item: { channelid: id } }, 10000);
  return 'started';
}

const ms = (t: { hours: number; minutes: number; seconds: number; milliseconds?: number }) =>
  ((t.hours * 60 + t.minutes) * 60 + t.seconds) * 1000 + (t.milliseconds ?? 0);

/**
 * The TV really plays that channel: Kodi keeps a player while a stream opens and while it fails (BFM TV held
 * one 40 s with nothing on screen, measured on the Pi), so it takes a video codec, the channel's name, and
 * the time moving between two reads `gapMs` apart.
 */
export async function isPlaying(cfg: KodiConfig, name: string, call: typeof kodiCall = kodiCall, gapMs = 1500): Promise<boolean> {
  const labels = await call<Record<string, string>>(cfg, 'XBMC.GetInfoLabels', { labels: ['VideoPlayer.VideoCodec', 'VideoPlayer.ChannelName'] });
  if (!labels['VideoPlayer.VideoCodec'] || labels['VideoPlayer.ChannelName'] !== name) return false;
  const player = (await call<Array<{ playerid: number; type: string }>>(cfg, 'Player.GetActivePlayers')).find((p) => p.type === 'video');
  if (!player) return false;
  const time = async () =>
    ms((await call<{ time: { hours: number; minutes: number; seconds: number; milliseconds?: number } }>(cfg, 'Player.GetProperties', { playerid: player.playerid, properties: ['time'] })).time);
  const before = await time();
  await new Promise((r) => setTimeout(r, gapMs));
  return (await time()) > before;
}
