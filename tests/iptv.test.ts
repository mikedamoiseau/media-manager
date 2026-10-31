import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseM3u, cleanName, uniqueNames, buildM3u, channelPlaylist, withoutBackups } from '../server/iptv.ts';

const LIST = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="M6.fr@HD" tvg-logo="https://i.imgur.com/7GVp3fW.png" http-user-agent="Mozilla/5.0 (KHTML, like Gecko)" group-title="",M6 HD (1080p)',
  '#EXTVLCOPT:http-user-agent=Mozilla/5.0 (KHTML, like Gecko)',
  'http://99.27.51.147:8080/M6/index.m3u8',
  '#EXTINF:-1 tvg-id="TeleMB.be@SD" tvg-logo="" group-title="General",Tele MB (1080p) [Geo-blocked]',
  'https://x/telemb.m3u8',
].join('\r\n');

test('iptv-org entries: the name after the first comma outside quotes, option lines kept', () => {
  assert.deepEqual(parseM3u(LIST), [
    { key: 'M6.fr@HD', name: 'M6 HD', logo: 'https://i.imgur.com/7GVp3fW.png', group: '', opts: ['#EXTVLCOPT:http-user-agent=Mozilla/5.0 (KHTML, like Gecko)'], url: 'http://99.27.51.147:8080/M6/index.m3u8' },
    { key: 'TeleMB.be@SD', name: 'Tele MB', logo: '', group: 'General', opts: [], url: 'https://x/telemb.m3u8' },
  ]);
});

test('names without the resolution or the tags', () => {
  assert.equal(cleanName('arte (France) (720p)'), 'arte (France)');
  assert.equal(cleanName('W9 (1086p)'), 'W9');
  assert.equal(cleanName('Joe FM (720p) [Not 24/7]'), 'Joe FM');
  assert.deepEqual(uniqueNames(['LCI', 'LCI', 'TF1', 'LCI']), ['LCI', 'LCI 2', 'TF1', 'LCI 3']);
});

test('the file both TVs read: numbers in order, the written name, option lines kept', () => {
  const tf1 = { key: 'TF1.fr@SD', name: 'TF1', logo: 'L', group: 'General', opts: [], url: 'http://a/tf1.m3u8' };
  const m6 = { key: 'M6.fr@HD', name: 'M6 HD', logo: '', group: '', opts: ['#EXTVLCOPT:http-user-agent=UA'], url: 'http://b/m6.m3u8' };
  assert.equal(
    buildM3u([{ entry: tf1, name: 'TF1' }, { entry: m6, name: 'M6 "HD"\n' }]),
    [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="TF1.fr@SD" tvg-chno="1" tvg-name="TF1" tvg-logo="L" group-title="General",TF1',
      'http://a/tf1.m3u8',
      '#EXTINF:-1 tvg-id="M6.fr@HD" tvg-chno="2" tvg-name="M6 HD" tvg-logo="" group-title="",M6 HD',
      '#EXTVLCOPT:http-user-agent=UA',
      'http://b/m6.m3u8',
      '',
    ].join('\n'),
  );
  assert.equal(channelPlaylist('M6 HD', m6), '#EXTM3U\n#EXTINF:-1,M6 HD\n#EXTVLCOPT:http-user-agent=UA\nhttp://b/m6.m3u8\n');
});

test("the file both TVs read says where Kodi's guide is", () => {
  const tf1 = { key: 'TF1.fr@SD', name: 'TF1', logo: '', group: '', opts: [], url: 'http://a/tf1.m3u8' };
  assert.match(buildM3u([{ entry: tf1, name: 'TF1' }], 'smb://nas/video/IPTV/guide "x".xml'), /^#EXTM3U x-tvg-url="smb:\/\/nas\/video\/IPTV\/guide x.xml"\n#EXTINF/);
});

test("a channel's qualities without the backup server's: its audio and its qualities go, the rest is kept at full addresses", () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_A1",NAME="und",DEFAULT=YES,CHANNELS="2",URI="a1/live.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_A1-backup",NAME="fre",DEFAULT=YES,CHANNELS="2",URI="https://backup.example/a1.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=475136,RESOLUTION=320x180,CODECS="avc1.42000c,mp4a.40.5",AUDIO="group_A1"',
    'v240/live.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=475136,RESOLUTION=320x180,CODECS="avc1.42000c,mp4a.40.5",AUDIO="group_A1-backup"',
    'https://backup.example/v240.m3u8',
    '',
  ].join('\n');
  assert.equal(
    withoutBackups(master, 'https://main.example/cnews/master.m3u8'),
    [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_A1",NAME="und",DEFAULT=YES,CHANNELS="2",URI="https://main.example/cnews/a1/live.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=475136,RESOLUTION=320x180,CODECS="avc1.42000c,mp4a.40.5",AUDIO="group_A1"',
      'https://main.example/cnews/v240/live.m3u8',
      '',
    ].join('\n'),
  );
});
