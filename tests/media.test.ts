import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, videoType, vlcPlaylist, kodiMedia, parseHandoff } from '../server/media.ts';
import { openDb } from '../server/db.ts';

test('byte ranges as VLC and browsers send them', () => {
  assert.equal(parseRange(undefined, 1000), null);
  assert.deepEqual(parseRange('bytes=0-', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=100-199', 1000), { start: 100, end: 199 });
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 }, 'end clamped to the file');
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 }, 'suffix range');
  assert.deepEqual(parseRange('bytes=0-1, 5-9', 1000), { start: 0, end: 1 }, 'only the first of several ranges');
  assert.equal(parseRange('bytes=1000-', 1000), 'invalid', 'starts past the end');
  assert.equal(parseRange('bytes=500-100', 1000), 'invalid');
  assert.equal(parseRange('items=0-1', 1000), null, 'unknown unit: send the whole file');
});

test('video content types by extension', () => {
  assert.equal(videoType('MOVIES/Film (2015).mkv'), 'video/x-matroska');
  assert.equal(videoType('a/b.MP4'), 'video/mp4');
  assert.equal(videoType('x.avi'), 'video/x-msvideo');
  assert.equal(videoType('x.weird'), 'application/octet-stream');
});

test('the playlist that makes VLC start at a time, with the audio and subtitle tracks of the TV', () => {
  const url = 'http://192.168.0.29:8642/api/media/item/7/k1/Heat.mkv';
  assert.equal(
    vlcPlaylist(url, 'Heat\r\n#EXTVLCOPT:x', { start: 4321.8, audio: 2, sub: 1 }),
    `#EXTM3U\n#EXTINF:-1,Heat #EXTVLCOPT:x\n#EXTVLCOPT:start-time=4321\n#EXTVLCOPT:audio-track=2\n#EXTVLCOPT:sub-track=1\n${url}\n`,
  );
  // Subtitles off on the TV: none in VLC either (the film may flag one as default).
  assert.match(vlcPlaylist(url, 'Heat', { start: 10, sub: 'off' }), /start-time=10\n#EXTVLCOPT:sub-language=none\n/);
  assert.equal(vlcPlaylist(url, 'Heat', { start: -3 }), `#EXTM3U\n#EXTINF:-1,Heat\n#EXTVLCOPT:start-time=0\n${url}\n`);
});

test('the handoff options in the playlist address: time, tracks, and a key new each time', () => {
  assert.deepEqual(parseHandoff('t4320-a2-s1-kmvnz5c'), { start: 4320, audio: 2, sub: 1, tv: undefined, key: 'mvnz5c' });
  assert.deepEqual(parseHandoff('t0-soff-kx'), { start: 0, audio: undefined, sub: 'off', tv: undefined, key: 'x' });
  assert.deepEqual(parseHandoff('t12-kab'), { start: 12, audio: undefined, sub: undefined, tv: undefined, key: 'ab' });
  // The TV to stop once VLC takes over: the one the phone controls.
  assert.deepEqual(parseHandoff('t12-vtv2-kab'), { start: 12, audio: undefined, sub: undefined, tv: 'tv2', key: 'ab' });
  assert.equal(parseHandoff('t12-a2'), null, 'no key');
  assert.equal(parseHandoff('../../etc'), null);
});

test('what Kodi plays, as a file of the library: a film or an episode, whatever the accents', () => {
  const db = openDb(':memory:');
  const PREFIX = 'smb://192.168.0.24/video/MEDIA/';
  const item = db.prepare(`INSERT INTO items (path, folder, category, is_dir, media_type, match_state, present, added_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'matched', ?, 1, 1)`);
  // macOS lists names decomposed (NFD); Kodi sends them composed (NFC).
  const film = Number(item.run('MOVIES/Les Misérables.mkv'.normalize('NFD'), 'MOVIES', 'movies', 0, 'movie', 1).lastInsertRowid);
  item.run('MOVIES/Gone.mkv', 'MOVIES', 'movies', 0, 'movie', 0);
  item.run('MOVIES/Monsters (2010)', 'MOVIES', 'movies', 1, 'movie', 1);
  const show = Number(item.run('SERIES/Dark', 'SERIES', 'series', 1, 'tv', 1).lastInsertRowid);
  const ep = Number(db.prepare('INSERT INTO episodes (item_id, path, season, episode) VALUES (?, ?, 1, 2)').run(show, 'SERIES/Dark/S01E02.mkv').lastInsertRowid);
  const k = (rel: string) => kodiMedia(db, PREFIX, `smb://192.168.0.24/video/MEDIA/${rel}`.normalize('NFC'));
  assert.deepEqual(k('MOVIES/Les Misérables.mkv'), { kind: 'item', id: film, ext: '.mkv' });
  assert.deepEqual(k('SERIES/Dark/S01E02.mkv'), { kind: 'episode', id: ep, ext: '.mkv' });
  db.prepare("INSERT INTO episodes (item_id, path, season, episode, present) VALUES (?, 'SERIES/Dark/S01E03.mkv', 1, 3, 0)").run(show);
  assert.equal(k('SERIES/Dark/S01E03.mkv'), undefined, 'an episode no longer on the NAS');
  assert.equal(k('MOVIES/Gone.mkv'), undefined, 'not on the NAS');
  assert.equal(k('MOVIES/Monsters (2010)/Monsters.mkv'), undefined, 'a film in its own folder: not streamed');
  assert.equal(kodiMedia(db, PREFIX, 'plugin://plugin.video.youtube/play/?video_id=x'), undefined);
  // A media folder with an accent, set in one Unicode form while Kodi sends the other.
  const film2 = Number(item.run('Films/Été.mkv'.normalize('NFD'), 'Films', 'movies', 0, 'movie', 1).lastInsertRowid);
  assert.deepEqual(kodiMedia(db, 'smb://nas/Vidéos'.normalize('NFD'), 'smb://nas/Vidéos/Films/Été.mkv'.normalize('NFC')), { kind: 'item', id: film2, ext: '.mkv' });
});
