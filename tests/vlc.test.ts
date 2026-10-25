import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaUrl, vlcLink, episodeName, playlistUrl, handoffLink } from '../web/src/vlc.ts';

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

test('the playlist link: where to start, in whole seconds, and a name ending in .m3u', () => {
  assert.equal(playlistUrl(origin, 'episode', 12, 754.9, 'Dark S01E02.mkv'), `${origin}/api/playlist/episode/12/754/Dark%20S01E02.mkv.m3u`);
});

test('taking over from the TV: the handoff playlist from 5 s before where the TV is, named like the film or episode', () => {
  const inner = (link: string | null) => decodeURIComponent(new URL(link!.replace('vlc-x-callback://', 'http://x/')).searchParams.get('url')!);
  const film = handoffLink(origin, { active: true, title: 'Heat', time: 4325, media: { kind: 'item', id: 7, ext: '.mkv' } }, null);
  assert.equal(inner(film), `${origin}/api/handoff/item/7/4320/Heat.mkv.m3u`);
  const ep = handoffLink(origin, { active: true, title: 'Ghosts', showTitle: 'Dark', season: 1, episode: 2, time: 3, media: { kind: 'episode', id: 9, ext: '.mp4' } }, null);
  assert.equal(inner(ep), `${origin}/api/handoff/episode/9/0/Dark S01E02.mp4.m3u`);
  const special = (season?: number, episode?: number) =>
    inner(handoffLink(origin, { active: true, title: 'Ghosts', showTitle: 'Dark', season, episode, time: 60, media: { kind: 'episode', id: 9, ext: '.mkv' } }, null));
  assert.equal(special(undefined, 5), `${origin}/api/handoff/episode/9/55/Dark E05.mkv.m3u`);
  assert.equal(special(), `${origin}/api/handoff/episode/9/55/Dark - Ghosts.mkv.m3u`);
  assert.equal(handoffLink(origin, { active: true, title: 'YouTube', time: 30 }, null), null);
});

