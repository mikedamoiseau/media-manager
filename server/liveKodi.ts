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

/** The TV shows its kids view (Lumen's skin setting); undefined when Kodi answers but can't say. A TV that doesn't answer is an error. */
export async function kidsViewOn(cfg: KodiConfig, call: typeof kodiCall = kodiCall): Promise<boolean | undefined> {
  const setting = `Skin.HasSetting(${KIDS_VIEW})`;
  try {
    const r = await call<Record<string, boolean>>(cfg, 'XBMC.GetInfoBooleans', { booleans: [setting] }, 3000);
    return r[setting] === true;
  } catch (e) {
    if (e instanceof KodiError && e.code !== 'rpc') throw e;
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

/**
 * Whether the TV plays that channel, as the Kodi session measured on both boxes (2026-10-28): its name, a
 * picture, full screen, no busy dialog, and Kodi playing. Not the clock: live TV reports no time, or one that
 * jumps while a stream opens. "opening" while Kodi still opens it (its busy dialog showed 3 to 13 s, sometimes
 * longer); "stopped" when another channel or nothing plays (a stream that fails goes back to Home).
 */
export async function isPlaying(cfg: KodiConfig, name: string, call: typeof kodiCall = kodiCall): Promise<'playing' | 'opening' | 'stopped'> {
  const labels = await call<Record<string, string>>(cfg, 'XBMC.GetInfoLabels', { labels: ['VideoPlayer.ChannelName', 'VideoPlayer.VideoCodec'] });
  if (labels['VideoPlayer.ChannelName'] !== name) return 'stopped';
  const full = 'Window.IsActive(fullscreenvideo)';
  const on = await call<Record<string, boolean>>(cfg, 'XBMC.GetInfoBooleans', { booleans: ['Player.Playing', 'System.HasActiveModalDialog', full] });
  return labels['VideoPlayer.VideoCodec'] && on['Player.Playing'] && on[full] && !on['System.HasActiveModalDialog'] ? 'playing' : 'opening';
}
