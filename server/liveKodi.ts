import { type KodiConfig, KodiError, kodiCall } from './kodi.ts';
import { KIDS_VIEW } from './kidsTag.ts';
import { KIDS_GROUP } from './livetv.ts';

type KodiChannel = { channelid: number; channel: string; channelnumber: number };
type GroupChannel = KodiChannel & { uniqueid: number; clientid: number };
type Client = { clientid: number; instanceid: number; addonid: string };

/**
 * A channel of the owner's list on a TV: by the name the app wrote, then that name without case; when several
 * share it, the one at its number. Channel ids are each TV's own: never one TV's id on another.
 */
export function findChannel<T extends KodiChannel>(list: T[], want: { name: string; number: number }): T | undefined {
  let same = list.filter((c) => c.channel === want.name);
  if (!same.length) same = list.filter((c) => c.channel.toLowerCase() === want.name.toLowerCase());
  return same.find((c) => c.channelnumber === want.number) ?? same[0];
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
 * A group of the TV's channels: its label as the TV names it, and its channels with what a path needs. The
 * Kids group by its label (none until the TV has read a list with it), else the box's all-channels group.
 */
async function group(cfg: KodiConfig, kids: boolean, call: typeof kodiCall): Promise<{ label: string; channels: GroupChannel[] } | undefined> {
  let id: number | 'alltv' = 'alltv';
  if (kids) {
    const groups = (await call<{ channelgroups?: Array<{ channelgroupid: number; label: string }> }>(cfg, 'PVR.GetChannelGroups', { channeltype: 'tv' })).channelgroups ?? [];
    const g = groups.find((x) => x.label === KIDS_GROUP);
    if (!g) return undefined;
    id = g.channelgroupid;
  }
  const properties = ['channel', 'channelnumber', 'uniqueid', 'clientid'];
  const d = (await call<{ channelgroupdetails: { label: string; channels?: GroupChannel[] } }>(cfg, 'PVR.GetChannelGroupDetails', { channelgroupid: id, channels: { properties } })).channelgroupdetails;
  return { label: d.label, channels: d.channels ?? [] };
}

/**
 * Starts one of the owner's channels on a TV, by its path in a group: the TV's own keys then stay in that group
 * (by its channel id, it would play in whichever group the TV last opened). The Kids group for a kid (`forKid`)
 * or on a TV showing its kids view, which takes the kids channels only; the box's all-channels group otherwise.
 * Never when the kids view can't be read. A TV without the channel in that group (it hasn't read the new list
 * yet) says so; one that refuses to give its channels (no live TV set up there, or another refusal Kodi doesn't
 * name) says that instead. The path's parts are each box's own, read at each start (measured on the Pi by the
 * Kodi session, 2026-10-31): `pvr://channels/tv/<group>@<group's client id, -1 for all channels>/<instance
 * id>@<add-on id>_<unique id>.pvr`.
 */
export async function startChannel(
  cfg: KodiConfig,
  want: { name: string; number: number; kids: boolean },
  forKid: boolean,
  call: typeof kodiCall = kodiCall,
): Promise<'started' | 'kids_view' | 'kids_unknown' | 'not_loaded' | 'no_live_tv'> {
  const kidsView = await kidsViewOn(cfg, call);
  if (kidsView === undefined) return 'kids_unknown';
  if (kidsView && !want.kids) return 'kids_view';
  const kids = kidsView || forKid;
  let g: Awaited<ReturnType<typeof group>>;
  let clients: Client[];
  try {
    g = await group(cfg, kids, call);
    clients = (await call<{ clients?: Client[] }>(cfg, 'PVR.GetClients')).clients ?? [];
  } catch (e) {
    // Kodi answers but won't list channels ("Failed to execute method" says no more): most likely no live TV there.
    if (e instanceof KodiError && e.code === 'rpc') return 'no_live_tv';
    throw e;
  }
  const ch = g && findChannel(g.channels, want);
  const client = ch && clients.find((c) => c.clientid === ch.clientid);
  if (!g || !ch || !client) return 'not_loaded';
  const file = `pvr://channels/tv/${encodeURIComponent(g.label)}@${kids ? ch.clientid : -1}/${client.instanceid}@${client.addonid}_${ch.uniqueid}.pvr`;
  await call(cfg, 'Player.Open', { item: { file } }, 10000);
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
