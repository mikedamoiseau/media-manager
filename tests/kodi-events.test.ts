import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonSplitter, KodiEvents, type Opener } from '../server/kodiEvents.ts';

test('jsonSplitter: objects back to back, cut anywhere, braces and quotes inside strings', () => {
  const a = '{"a":"x}{\\"y","n":[1,{"b":2}]}';
  const b = '{"method":"Input.OnInputFinished","params":{"data":null}}';
  const stream = `${a}\n${b}  ${a}`;
  for (const chunks of [[stream], [...stream]]) {
    const out: unknown[] = [];
    const feed = jsonSplitter((text) => out.push(JSON.parse(text)));
    for (const c of chunks) feed(c);
    assert.deepEqual(out, [JSON.parse(a), JSON.parse(b), JSON.parse(a)]);
  }
});

/** An opener whose connections the test drives: what Kodi sends, and when the connection ends. */
function fakeOpener() {
  const pipes: Array<{ host: string; port: number; written: string[]; closed: boolean; data: (s: string) => void; end: (e?: Error) => void }> = [];
  const open: Opener = (host, port, on) => {
    const p = { host, port, written: [] as string[], closed: false, data: on.data, end: on.end };
    pipes.push(p);
    return { write: (t) => void p.written.push(t), close: () => void (p.closed = true) };
  };
  return { open, pipes };
}

const PONG = '{"id":"ping","jsonrpc":"2.0","result":"pong"}';
const requested = (title: string, value = '', type = 'keyboard') =>
  JSON.stringify({ jsonrpc: '2.0', method: 'Input.OnInputRequested', params: { data: { title, type, value }, sender: 'xbmc' } });
const lanBlock = () => Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' });

test('Kodi asks for text, then closes its keyboard', () => {
  const tcp = fakeOpener();
  const nc = fakeOpener();
  let changes = 0;
  const ev = new KodiEvents(() => changes++, { tcp: tcp.open, nc: nc.open });
  ev.connect('10.0.0.5');
  const [p] = tcp.pipes;
  assert.deepEqual([p!.host, p!.port], ['10.0.0.5', 9090]);
  assert.match(p!.written[0]!, /"JSONRPC.Ping"/);
  assert.equal(ev.live, false);

  p!.data(PONG);
  assert.equal(ev.live, true);

  const msg = requested('Search YouTube', 'dune');
  p!.data(msg.slice(0, 20));
  p!.data(msg.slice(20));
  assert.deepEqual(ev.input, { id: 1, type: 'keyboard', title: 'Search YouTube', value: 'dune' });
  p!.data(requested('Password', '', 'password'));
  assert.deepEqual(ev.input, { id: 2, type: 'password', title: 'Password', value: '' });
  p!.data('{"jsonrpc":"2.0","method":"Input.OnInputFinished","params":{"data":null,"sender":"xbmc"}}');
  assert.equal(ev.input, null);
  assert.equal(changes, 4);

  ev.stop();
  assert.equal(p!.closed, true);
  assert.equal(ev.live, false);
  assert.equal(nc.pipes.length, 0);
});

test('falls back to nc when macOS blocks node, and reconnects with growing pauses', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const tcp = fakeOpener();
  const nc = fakeOpener();
  const ev = new KodiEvents(() => {}, { tcp: tcp.open, nc: nc.open });
  ev.connect('10.0.0.5');
  tcp.pipes[0]!.end(lanBlock());
  assert.equal(nc.pipes.length, 1, 'nc right away');
  assert.equal(tcp.pipes[0]!.closed, true);

  // The port is closed (Kodi's "applications on other systems" is off): try again in 5 s, then 10 s.
  nc.pipes[0]!.end(new Error('nc exited with code 1'));
  assert.equal(ev.live, false);
  assert.match(ev.error ?? '', /nc exited/);
  t.mock.timers.tick(4999);
  assert.equal(nc.pipes.length, 1);
  t.mock.timers.tick(1);
  assert.equal(nc.pipes.length, 2, 'still through nc');
  nc.pipes[1]!.end(new Error('nc exited with code 1'));
  t.mock.timers.tick(9999);
  assert.equal(nc.pipes.length, 2);
  t.mock.timers.tick(1);
  assert.equal(nc.pipes.length, 3);

  // Once it works, a lost connection is retried after 5 s again, and an open keyboard is forgotten.
  nc.pipes[2]!.data(PONG);
  nc.pipes[2]!.data(requested('Search'));
  assert.equal(ev.live, true);
  nc.pipes[2]!.end(new Error('nc exited with code 0'));
  assert.deepEqual([ev.live, ev.input], [false, null]);
  t.mock.timers.tick(5000);
  assert.equal(nc.pipes.length, 4);
  assert.equal(tcp.pipes.length, 1);
  ev.stop();
});

test('a connection that stops answering is dropped and opened again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const tcp = fakeOpener();
  const ev = new KodiEvents(() => {}, { tcp: tcp.open, nc: fakeOpener().open });
  ev.connect('10.0.0.5');
  const p = tcp.pipes[0]!;
  p.data(PONG);
  t.mock.timers.tick(30_000);
  assert.equal(p.written.length, 2, 'pinged again');
  p.data(PONG);
  t.mock.timers.tick(60_000);
  assert.equal(p.closed, false, 'last answer 60 s ago');
  t.mock.timers.tick(30_000);
  assert.equal(p.closed, true);
  assert.equal(ev.live, false);
  t.mock.timers.tick(5000);
  assert.equal(tcp.pipes.length, 2);
  ev.stop();
});

test('no Kodi host: no connection', () => {
  const tcp = fakeOpener();
  const ev = new KodiEvents(() => {}, { tcp: tcp.open, nc: tcp.open });
  ev.connect('');
  assert.equal(tcp.pipes.length, 0);
});

test('player events are passed on: what started, and what stopped (and whether it reached its end)', () => {
  const tcp = fakeOpener();
  const seen: unknown[] = [];
  const ev = new KodiEvents(() => {}, { tcp: tcp.open, nc: fakeOpener().open }, 9090, (e) => seen.push(e));
  ev.connect('10.0.0.5');
  const [p] = tcp.pipes;
  try {
  p!.data('{"jsonrpc":"2.0","method":"Player.OnPlay","params":{"data":{"item":{"id":12,"type":"movie"},"player":{"playerid":1,"speed":1}},"sender":"xbmc"}}');
  p!.data('{"jsonrpc":"2.0","method":"Player.OnStop","params":{"data":{"end":true,"item":{"id":12,"type":"movie"}},"sender":"xbmc"}}');
  p!.data('{"jsonrpc":"2.0","method":"Player.OnPlay","params":{"data":{"item":{"title":"trailer","type":"unknown"},"player":{"playerid":1}},"sender":"xbmc"}}');
  assert.deepEqual(seen, [
    { kind: 'play', item: { type: 'movie', id: 12 } },
    { kind: 'stop', item: { type: 'movie', id: 12 }, ended: true },
    { kind: 'play', item: undefined },
  ]);
  } finally {
    ev.stop();
  }
});
