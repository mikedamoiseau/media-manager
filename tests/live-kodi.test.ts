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
    { channelid: 1, channel: 'LCI', channelnumber: 21 },
    { channelid: 2, channel: 'LCI 2', channelnumber: 22 },
    { channelid: 3, channel: 'tf1', channelnumber: 1 },
  ],
};

test('a channel on a TV: by its name, case ignored, the number only breaks a tie', () => {
  const list = CHANNELS.channels;
  assert.equal(findChannel(list, { name: 'LCI 2', number: 5 }), 2);
  assert.equal(findChannel(list, { name: 'TF1', number: 1 }), 3);
  assert.equal(findChannel(list, { name: 'M6', number: 5 }), undefined);
  const twins = [{ channelid: 7, channel: 'LCI', channelnumber: 21 }, { channelid: 8, channel: 'LCI', channelnumber: 22 }];
  assert.equal(findChannel(twins, { name: 'LCI', number: 22 }), 8);
  assert.equal(findChannel(twins, { name: 'LCI', number: 9 }), 7);
});

test("the TV's kids view: on, off, unknown when Kodi can't say, and a TV that doesn't answer is an error", async () => {
  const on = fakeKodi({ 'XBMC.GetInfoBooleans': { [KIDS]: true } });
  assert.equal(await kidsViewOn(CFG, on.call), true);
  assert.deepEqual(on.calls[0], { method: 'XBMC.GetInfoBooleans', params: { booleans: [KIDS] } });
  assert.equal(await kidsViewOn(CFG, fakeKodi({ 'XBMC.GetInfoBooleans': { [KIDS]: false } }).call), false);
  assert.equal(await kidsViewOn(CFG, fakeKodi({ 'XBMC.GetInfoBooleans': new KodiError('rpc', 'XBMC.GetInfoBooleans: Failed') }).call), undefined);
  await assert.rejects(kidsViewOn(CFG, fakeKodi({ 'XBMC.GetInfoBooleans': new KodiError('unreachable', 'down') }).call), KodiError);
});

test('starting a channel: never in the kids view, nor when it cannot be checked', async () => {
  const kids = fakeKodi({ 'XBMC.GetInfoBooleans': { [KIDS]: true }, 'PVR.GetChannels': CHANNELS, 'Player.Open': 'OK' });
  assert.equal(await startChannel(CFG, { name: 'TF1', number: 1 }, kids.call), 'kids_view');
  assert.ok(!kids.calls.some((c) => c.method === 'Player.Open'));

  const unknown = fakeKodi({ 'XBMC.GetInfoBooleans': new KodiError('rpc', 'XBMC.GetInfoBooleans: Failed'), 'PVR.GetChannels': CHANNELS, 'Player.Open': 'OK' });
  assert.equal(await startChannel(CFG, { name: 'TF1', number: 1 }, unknown.call), 'kids_unknown');
  assert.ok(!unknown.calls.some((c) => c.method === 'Player.Open'));

  // A TV that is off: Kodi's own "not reachable", not a word about its kids view; still nothing plays.
  const off = fakeKodi({ 'XBMC.GetInfoBooleans': new KodiError('unreachable', 'down'), 'PVR.GetChannels': CHANNELS, 'Player.Open': 'OK' });
  await assert.rejects(startChannel(CFG, { name: 'TF1', number: 1 }, off.call), KodiError);
  assert.ok(!off.calls.some((c) => c.method === 'Player.Open'));
});

test("starting a channel the TV hasn't loaded, or on a TV without live TV", async () => {
  const off = { 'XBMC.GetInfoBooleans': { [KIDS]: false }, 'Player.Open': 'OK' };
  assert.equal(await startChannel(CFG, { name: 'M6', number: 2 }, fakeKodi({ ...off, 'PVR.GetChannels': CHANNELS }).call), 'not_loaded');
  const noPvr = fakeKodi({ ...off, 'PVR.GetChannels': new KodiError('rpc', 'PVR.GetChannels: Failed to execute method.') });
  assert.equal(await startChannel(CFG, { name: 'TF1', number: 1 }, noPvr.call), 'no_live_tv', 'not "wait for the new list": Kodi refused');
  await assert.rejects(
    startChannel(CFG, { name: 'TF1', number: 1 }, fakeKodi({ ...off, 'PVR.GetChannels': new KodiError('unreachable', 'down') }).call),
    KodiError,
    'a TV that does not answer is an error, not a missing channel',
  );
});

test('starting a channel opens it by its id on that TV', async () => {
  const k = fakeKodi({ 'XBMC.GetInfoBooleans': { [KIDS]: false }, 'PVR.GetChannels': CHANNELS, 'Player.Open': 'OK' });
  assert.equal(await startChannel(CFG, { name: 'TF1', number: 1 }, k.call), 'started');
  assert.deepEqual(k.calls.find((c) => c.method === 'PVR.GetChannels')!.params, { channelgroupid: 'alltv', properties: ['channel', 'channelnumber'] });
  assert.deepEqual(k.calls.at(-1), { method: 'Player.Open', params: { item: { channelid: 3 } } });
});

test('really playing: a video codec, that channel, and the time moving', async () => {
  const labels = (codec: string, name: string) => ({ 'VideoPlayer.VideoCodec': codec, 'VideoPlayer.ChannelName': name });
  const times = (...secs: number[]) => () => ({ time: { hours: 0, minutes: 0, seconds: secs.length > 1 ? secs.shift()! : secs[0]!, milliseconds: 0 } });
  const video = [{ playerid: 1, type: 'video' }];
  const k = (l: unknown, players: unknown, t: () => unknown) =>
    fakeKodi({ 'XBMC.GetInfoLabels': l, 'Player.GetActivePlayers': players, 'Player.GetProperties': t }).call;

  assert.equal(await isPlaying(CFG, 'TF1', k(labels('h264', 'TF1'), video, times(3, 5)), 1), true);
  assert.equal(await isPlaying(CFG, 'TF1', k(labels('', 'TF1'), video, times(3, 5)), 1), false, 'still opening');
  assert.equal(await isPlaying(CFG, 'TF1', k(labels('h264', 'M6'), video, times(3, 5)), 1), false, 'another channel');
  assert.equal(await isPlaying(CFG, 'TF1', k(labels('h264', 'TF1'), video, times(4, 4)), 1), false, 'stuck');
  assert.equal(await isPlaying(CFG, 'TF1', k(labels('h264', 'TF1'), [], times(3, 5)), 1), false, 'no player');
});
