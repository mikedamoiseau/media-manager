import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KodiError, type kodiCall } from '../server/kodi.ts';
import { findChannel, kidsViewOn, startChannel, isPlaying } from '../server/liveKodi.ts';

const CFG = { host: '10.0.0.20', port: 8080 };
type Answer = unknown | Error | ((params: unknown) => unknown);

/** Kodi answering from a table, keeping what it was asked. */
function fakeKodi(answers: Record<string, Answer>) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const call = (async (_cfg: unknown, method: string, params?: unknown) => {
    calls.push({ method, params });
    const a = answers[method];
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? (a as (p: unknown) => unknown)(params) : a;
  }) as typeof kodiCall;
  return { call, calls };
}

const KIDS = 'Skin.HasSetting(CinemathequeKids)';
const CHANNELS = {
  channels: [
    { channelid: 1, channel: 'LCI', channelnumber: 21, uniqueid: 101, clientid: 3 },
    { channelid: 2, channel: 'LCI 2', channelnumber: 22, uniqueid: 102, clientid: 3 },
    { channelid: 3, channel: 'tf1', channelnumber: 1, uniqueid: 103, clientid: 3 },
  ],
};
const CARTOONS = { channels: [{ channelid: 4, channel: 'Pingu', channelnumber: 37, uniqueid: 104, clientid: 3 }] };
// The client id and the instance id differ here, as they may on a box (both are 1 on the Pi).
const CLIENTS = { clients: [{ addonid: 'pvr.iptvsimple', clientid: 3, instanceid: 2, label: 'IPTV Simple Client' }] };
const GROUPS = { channelgroups: [{ channelgroupid: 8, channeltype: 'tv', label: 'Toutes les chaînes' }, { channelgroupid: 5, channeltype: 'tv', label: 'Kids' }] };

/** A box with its own all-channels label, a Kids group with Pingu, and its IPTV Simple client. */
function box(kidsView: boolean | Error, more: Record<string, Answer> = {}) {
  return fakeKodi({
    'XBMC.GetInfoBooleans': kidsView instanceof Error ? kidsView : { [KIDS]: kidsView },
    'PVR.GetClients': CLIENTS,
    'PVR.GetChannelGroups': GROUPS,
    'PVR.GetChannelGroupDetails': (p: unknown) => {
      const id = (p as { channelgroupid: unknown }).channelgroupid;
      return { channelgroupdetails: id === 'alltv' ? { channelgroupid: 8, label: 'Toutes les chaînes', ...CHANNELS } : { channelgroupid: 5, label: 'Kids', ...CARTOONS } };
    },
    'Player.Open': 'OK',
    ...more,
  });
}
const TF1 = { name: 'TF1', number: 1, kids: false };
const PINGU = { name: 'Pingu', number: 37, kids: true };

test('a channel on a TV: by its name, case ignored, the number only breaks a tie', () => {
  const list = CHANNELS.channels;
  assert.equal(findChannel(list, { name: 'LCI 2', number: 5 })?.channelid, 2);
  assert.equal(findChannel(list, { name: 'TF1', number: 1 })?.channelid, 3);
  assert.equal(findChannel(list, { name: 'M6', number: 5 }), undefined);
  const twins = [{ channelid: 7, channel: 'LCI', channelnumber: 21 }, { channelid: 8, channel: 'LCI', channelnumber: 22 }];
  assert.equal(findChannel(twins, { name: 'LCI', number: 22 })?.channelid, 8);
  assert.equal(findChannel(twins, { name: 'LCI', number: 9 })?.channelid, 7);
});

test("the TV's kids view: on, off, unknown when Kodi can't say, and a TV that doesn't answer is an error", async () => {
  const on = fakeKodi({ 'XBMC.GetInfoBooleans': { [KIDS]: true } });
  assert.equal(await kidsViewOn(CFG, on.call), true);
  assert.deepEqual(on.calls[0], { method: 'XBMC.GetInfoBooleans', params: { booleans: [KIDS] } });
  assert.equal(await kidsViewOn(CFG, fakeKodi({ 'XBMC.GetInfoBooleans': { [KIDS]: false } }).call), false);
  assert.equal(await kidsViewOn(CFG, fakeKodi({ 'XBMC.GetInfoBooleans': new KodiError('rpc', 'XBMC.GetInfoBooleans: Failed') }).call), undefined);
  await assert.rejects(kidsViewOn(CFG, fakeKodi({ 'XBMC.GetInfoBooleans': new KodiError('unreachable', 'down') }).call), KodiError);
});

test('starting a channel in the kids view: a kids channel only, and never when the view cannot be checked', async () => {
  const kids = box(true);
  assert.equal(await startChannel(CFG, TF1, false, kids.call), 'kids_view');
  assert.ok(!kids.calls.some((c) => c.method === 'Player.Open'));
  assert.equal(await startChannel(CFG, PINGU, false, kids.call), 'started');
  assert.deepEqual(kids.calls.at(-1), { method: 'Player.Open', params: { item: { file: 'pvr://channels/tv/Kids@3/2@pvr.iptvsimple_104.pvr' } } }, 'in the Kids group');

  const unknown = box(new KodiError('rpc', 'XBMC.GetInfoBooleans: Failed'));
  assert.equal(await startChannel(CFG, PINGU, false, unknown.call), 'kids_unknown');
  assert.ok(!unknown.calls.some((c) => c.method === 'Player.Open'));

  // A TV that is off: Kodi's own "not reachable", not a word about its kids view; still nothing plays.
  const off = box(new KodiError('unreachable', 'down'));
  await assert.rejects(startChannel(CFG, TF1, false, off.call), KodiError);
  assert.ok(!off.calls.some((c) => c.method === 'Player.Open'));
});

test('starting a channel by its path in the all-channels group: the box\'s own label, -1, the instance id', async () => {
  const k = box(false);
  assert.equal(await startChannel(CFG, TF1, false, k.call), 'started');
  assert.deepEqual(k.calls.find((c) => c.method === 'PVR.GetChannelGroupDetails')!.params, {
    channelgroupid: 'alltv',
    channels: { properties: ['channel', 'channelnumber', 'uniqueid', 'clientid'] },
  });
  assert.deepEqual(k.calls.at(-1), { method: 'Player.Open', params: { item: { file: 'pvr://channels/tv/Toutes%20les%20cha%C3%AEnes@-1/2@pvr.iptvsimple_103.pvr' } } });
});

test('starting a channel for a kid: in the Kids group, by its id there and the client\'s', async () => {
  const k = box(false);
  assert.equal(await startChannel(CFG, PINGU, true, k.call), 'started');
  assert.deepEqual(k.calls.find((c) => c.method === 'PVR.GetChannelGroupDetails')!.params, {
    channelgroupid: 5,
    channels: { properties: ['channel', 'channelnumber', 'uniqueid', 'clientid'] },
  });
  assert.deepEqual(k.calls.at(-1), { method: 'Player.Open', params: { item: { file: 'pvr://channels/tv/Kids@3/2@pvr.iptvsimple_104.pvr' } } });
});

test("starting a channel the TV hasn't loaded, or on a TV without live TV", async () => {
  assert.equal(await startChannel(CFG, { name: 'M6', number: 2, kids: false }, false, box(false).call), 'not_loaded');
  const noKidsGroup = box(false, { 'PVR.GetChannelGroups': { channelgroups: [GROUPS.channelgroups[0]] } });
  assert.equal(await startChannel(CFG, PINGU, true, noKidsGroup.call), 'not_loaded', 'no Kids group yet');
  const emptyKids = box(true, { 'PVR.GetChannelGroupDetails': { channelgroupdetails: { channelgroupid: 5, label: 'Kids', channels: [] } } });
  assert.equal(await startChannel(CFG, PINGU, false, emptyKids.call), 'not_loaded', 'not in the Kids group yet');
  for (const k of [noKidsGroup, emptyKids]) assert.ok(!k.calls.some((c) => c.method === 'Player.Open'));
  const noPvr = box(false, { 'PVR.GetChannelGroupDetails': new KodiError('rpc', 'PVR.GetChannelGroupDetails: Failed to execute method.') });
  assert.equal(await startChannel(CFG, TF1, false, noPvr.call), 'no_live_tv', 'not "wait for the new list": Kodi refused');
  await assert.rejects(
    startChannel(CFG, TF1, false, box(false, { 'PVR.GetChannelGroupDetails': new KodiError('unreachable', 'down') }).call),
    KodiError,
    'a TV that does not answer is an error, not a missing channel',
  );
});

test('really playing: that channel, a picture, full screen, no busy dialog, and Kodi playing (live TV has no clock)', async () => {
  const k = (labels: unknown, booleans: unknown) => fakeKodi({ 'XBMC.GetInfoLabels': labels, 'XBMC.GetInfoBooleans': booleans }).call;
  const L = (codec: string, name: string) => ({ 'VideoPlayer.VideoCodec': codec, 'VideoPlayer.ChannelName': name });
  const B = (playing: boolean, modal: boolean, full: boolean) => ({ 'Player.Playing': playing, 'System.HasActiveModalDialog': modal, 'Window.IsActive(fullscreenvideo)': full });
  assert.equal(await isPlaying(CFG, 'TF1', k(L('h264', 'TF1'), B(true, false, true))), 'playing');
  assert.equal(await isPlaying(CFG, 'TF1', k(L('h264', 'TF1'), B(true, true, false))), 'opening', 'its busy dialog still up (the Mi Box, 13 s in)');
  assert.equal(await isPlaying(CFG, 'TF1', k(L('', 'TF1'), B(false, false, false))), 'opening', 'no picture yet');
  assert.equal(await isPlaying(CFG, 'TF1', k(L('h264', ''), B(false, false, false))), 'stopped', 'back to Home: the stream failed (BFM TV on the Pi)');
  assert.equal(await isPlaying(CFG, 'TF1', k(L('h264', 'M6 HD'), B(true, false, true))), 'stopped', 'another channel');
});
