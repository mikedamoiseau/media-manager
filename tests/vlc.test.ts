import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaUrl, vlcLink, episodeName, handoffLink } from '../web/src/vlc.ts';

const origin = 'http://192.168.0.29:8642';

test('the media URL is absolute on the address the phone used, with an encoded name', () => {
  assert.equal(mediaUrl(origin, 'item', 1901, 'Rocky II : La Revanche.mkv'), `${origin}/api/media/item/1901/Rocky%20II%20%3A%20La%20Revanche.mkv`);
});

test('VLC gets the stream URL and, when given, the page to come back to', () => {
  const media = mediaUrl(origin, 'episode', 7, 'Épisode 1');
  const link = new URL(vlcLink(media, `${origin}/title/1901`));
  assert.equal(link.protocol, 'vlc-x-callback:');
  assert.equal(`${link.host}${link.pathname}`, 'x-callback-url/stream');
  assert.equal(link.searchParams.get('url'), media);
  assert.equal(link.searchParams.get('x-success'), `${origin}/title/1901`);
  assert.equal(new URL(vlcLink(media, null)).searchParams.get('x-success'), null);
});

test('an episode reaches VLC as "Show S01E05" with its file extension', () => {
  assert.equal(episodeName('Shōgun', { name: 'Shogun.2024.S01E05.MULTi.1080p.mkv', season: 1, episode: 5 }), 'Shōgun S01E05.mkv');
  assert.equal(episodeName('Shōgun', { name: 'ep12.mp4', season: null, episode: 12 }), 'Shōgun E12.mp4');
  assert.equal(episodeName('Shōgun', { name: 'Making of.mkv', season: 0, episode: null }), 'Making of.mkv');
  assert.equal(episodeName('Show', { name: 'no-extension', season: 2, episode: 1 }), 'Show S02E01');
});

test('taking over from the TV: from 5 s before, with its tracks, on an address VLC has not seen, named like the film or episode', () => {
  const inner = (link: string | null) => decodeURIComponent(new URL(link!.replace('vlc-x-callback://', 'http://x/')).searchParams.get('url')!);
  const audio = { index: 2 };
  const subtitle = { index: 1 };
  const film = handoffLink(origin, { active: true, title: 'Heat', time: 4325, audio, subtitle, subtitlesOn: true, media: { kind: 'item', id: 7, ext: '.mkv' } }, null, 'k1');
  assert.equal(inner(film), `${origin}/api/handoff/item/7/t4320-a2-s1-kk1/Heat.mkv.m3u`);
  // Subtitles off on the TV; tracks unknown.
  const off = handoffLink(origin, { active: true, title: 'Heat', time: 3, audio, subtitle, subtitlesOn: false, media: { kind: 'item', id: 7, ext: '.mkv' } }, null, 'k2');
  assert.equal(inner(off), `${origin}/api/handoff/item/7/t0-a2-soff-kk2/Heat.mkv.m3u`);
  const ep = (season?: number, episode?: number) =>
    inner(handoffLink(origin, { active: true, title: 'Ghosts', showTitle: 'Dark', season, episode, time: 60, media: { kind: 'episode', id: 9, ext: '.mp4' } }, null, 'k3'));
  assert.equal(ep(1, 2), `${origin}/api/handoff/episode/9/t55-kk3/Dark S01E02.mp4.m3u`);
  assert.equal(ep(undefined, 5), `${origin}/api/handoff/episode/9/t55-kk3/Dark E05.mp4.m3u`);
  assert.equal(ep(), `${origin}/api/handoff/episode/9/t55-kk3/Dark - Ghosts.mp4.m3u`);
  assert.equal(handoffLink(origin, { active: true, title: 'YouTube', time: 30 }, null, 'k4'), null);
});
