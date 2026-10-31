import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, getSettings, MIGRATIONS } from '../server/db.ts';

test('the Samsung TV Plus guide joins guide sources saved before it existed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-'));
  const file = join(dir, 'media.db');
  const old = new DatabaseSync(file);
  for (const m of MIGRATIONS.slice(0, 15)) old.exec(m);
  old.exec('PRAGMA user_version = 15');
  old.prepare("INSERT INTO settings (key, value) VALUES ('liveGuides', ?)").run(JSON.stringify(['https://own/guide.xml']));
  old.close();
  const db = openDb(file);
  assert.deepEqual(getSettings(db).liveGuides, ['https://own/guide.xml', 'https://i.mjh.nz/SamsungTVPlus/fr.xml.gz']);
  db.close();
  rmSync(dir, { recursive: true });
});

test("channels picked before categories are numbered category by category, each in the owner's order", () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-'));
  const file = join(dir, 'media.db');
  const old = new DatabaseSync(file);
  for (const m of MIGRATIONS.slice(0, 15)) old.exec(m);
  old.exec('PRAGMA user_version = 15');
  const channel = old.prepare("INSERT INTO live_catalog (key, list, name, logo, grp, url, opts, seen_at) VALUES (?, ?, ?, '', '', 'http://s', '[]', 1)");
  const pick = old.prepare('INSERT INTO live_channels (key, position) VALUES (?, ?)');
  [['TF1.fr@SD', 'fr'], ['BX1.be@SD', 'be'], ['M6.fr@HD', 'fr'], ['LCI.fr@SD', 'fr']].forEach(([key, list], i) => {
    channel.run(key!, list!, key!);
    pick.run(key!, i + 1);
  });
  old.close();
  const db = openDb(file);
  const order = db.prepare('SELECT key, position FROM live_channels ORDER BY position').all().map((r) => `${r.position} ${r.key}`);
  assert.deepEqual(order, ['1 TF1.fr@SD', '2 M6.fr@HD', '3 LCI.fr@SD', '4 BX1.be@SD']);
  db.close();
  rmSync(dir, { recursive: true });
});

test('channels picked before the kids switch are not for kids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-'));
  const file = join(dir, 'media.db');
  const old = new DatabaseSync(file);
  for (const m of MIGRATIONS.slice(0, 16)) old.exec(m);
  old.exec('PRAGMA user_version = 16');
  old.prepare("INSERT INTO live_channels (key, position) VALUES ('TF1.fr@SD', 1)").run();
  old.close();
  const db = openDb(file);
  assert.deepEqual({ ...db.prepare('SELECT key, kids FROM live_channels').get() }, { key: 'TF1.fr@SD', kids: 0 });
  db.close();
  rmSync(dir, { recursive: true });
});

test('channels picked before own logos keep the listed logo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-'));
  const file = join(dir, 'media.db');
  const old = new DatabaseSync(file);
  for (const m of MIGRATIONS.slice(0, 17)) old.exec(m);
  old.exec('PRAGMA user_version = 17');
  old.prepare("INSERT INTO live_channels (key, position) VALUES ('TF1.fr@SD', 1)").run();
  old.close();
  const db = openDb(file);
  assert.deepEqual({ ...db.prepare('SELECT key, logo FROM live_channels').get() }, { key: 'TF1.fr@SD', logo: null });
  db.close();
  rmSync(dir, { recursive: true });
});
