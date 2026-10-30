import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { applyKodiLibrary } from '../server/metadata.ts';

test('the log and its tables exist', () => {
  const db = openDb(':memory:');
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
  assert.deepEqual(cols('plays'), ['id', 'profile_id', 'item_id', 'kind', 'episode_id', 'device', 'at', 'minutes', 'reached', 'finished', 'estimated']);
  assert.deepEqual(cols('year_asked'), ['profile_id', 'year', 'at']);
  assert.deepEqual(cols('person_photos'), ['name', 'url', 'fetched_at']);
  assert.ok(cols('episodes').includes('runtime'));
});

test("an episode's file replaced (a better copy): its plays stay, still an episode's", () => {
  const db = openDb(':memory:');
  const show = Number(db.prepare(`INSERT INTO items (path, folder, category, is_dir, match_state, present, added_at, updated_at)
    VALUES ('SERIES/Show', 'SERIES', 'series', 1, 'unmatched', 1, 1, 1)`).run().lastInsertRowid);
  const ep = Number(db.prepare("INSERT INTO episodes (item_id, path, season, episode) VALUES (?, 'SERIES/Show/S01E01.mkv', 1, 1)").run(show).lastInsertRowid);
  db.prepare("INSERT INTO plays (profile_id, item_id, kind, episode_id, device, at, minutes, finished) VALUES (1, ?, 'episode', ?, 'tv1', 1, 40, 1)").run(show, ep);
  db.prepare('DELETE FROM episodes WHERE id = ?').run(ep);
  assert.deepEqual({ ...db.prepare('SELECT item_id, kind, episode_id FROM plays').get() }, { item_id: show, kind: 'episode', episode_id: null });
});

test("an episode's runtime comes from Kodi, in minutes", () => {
  const db = openDb(':memory:');
  const show = Number(db.prepare(`INSERT INTO items (path, folder, category, is_dir, match_state, present, added_at, updated_at)
    VALUES ('SERIES/Show', 'SERIES', 'series', 1, 'unmatched', 1, 1, 1)`).run().lastInsertRowid);
  db.prepare("INSERT INTO episodes (item_id, path, season, episode) VALUES (?, 'SERIES/Show/S01E01.mkv', 1, 1)").run(show);
  applyKodiLibrary(db, 'smb://nas/MEDIA', {
    movies: [],
    shows: [],
    episodes: [{ episodeid: 7, file: 'smb://nas/MEDIA/SERIES/Show/S01E01.mkv', runtime: 2700, playcount: 0, lastplayed: '' }],
  });
  assert.deepEqual({ ...db.prepare('SELECT kodi_id, runtime FROM episodes').get() }, { kodi_id: 7, runtime: 45 });
});
