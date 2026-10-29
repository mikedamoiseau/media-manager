import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in Kodi: answers what Play and Stop ask, and keeps every call. `answers`: other methods' results;
 * `refused`: items Player.Open fails for, as Kodi does for a file it can't open.
 */
export async function standInKodi() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const players: Array<{ playerid: number; type: string }> = [];
  const answers: Record<string, unknown> = {};
  const refused: unknown[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const m = JSON.parse(body) as { id: number; method: string; params: Record<string, unknown> };
      calls.push({ method: m.method, params: m.params });
      const refuse = m.method === 'Player.Open' && refused.some((r) => JSON.stringify(r) === JSON.stringify(m.params.item));
      const result = m.method === 'Player.GetActivePlayers' ? players : m.method in answers ? answers[m.method] : 'OK';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(refuse ? { id: m.id, jsonrpc: '2.0', error: { code: -32100, message: 'Failed to execute method.' } } : { id: m.id, jsonrpc: '2.0', result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const opened = () => calls.filter((c) => c.method === 'Player.Open').map((c) => c.params.item);
  return { calls, players, answers, refused, server, port, opened };
}
