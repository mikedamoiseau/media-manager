import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseM3u, cleanName, uniqueNames, buildM3u, channelPlaylist } from '../server/iptv.ts';

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
