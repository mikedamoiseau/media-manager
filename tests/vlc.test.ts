import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaUrl, vlcLink, episodeName } from '../web/src/vlc.ts';

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
