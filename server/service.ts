import { EventEmitter } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type DB, type Settings, getSettings, saveSettings } from './db.ts';
import { scanMediaRoot, pool } from './scanner.ts';
import { cachedImage, isAllowedImage } from './images.ts';
import { reconcile, applySheetHints, syncSheetOnlyItems, importSheetRows } from './library.ts';
import { fetchSheet } from './sheet.ts';
import { type KodiConfig, kodiCall, discoverKodi, detectPathPrefix } from './kodi.ts';
import { syncFromKodi, matchPending, enrichTitles } from './metadata.ts';
import { Tmdb } from './tmdb.ts';
import { lanTransport } from './net.ts';

export interface TaskStatus {
  running: boolean;
  lastAt?: number;
  message?: string;
  error?: string;
  progress?: { done: number; total: number };
}

export interface Status {
  nas: { mounted: boolean; root: string };
  scan: TaskStatus;
  sheet: TaskStatus;
  kodi: TaskStatus & { connected: boolean; host?: string; transport: string };
  metadata: TaskStatus;
  tmdbConfigured: boolean;
  counts: Record<string, number>;
}

export class Service extends EventEmitter {
  db: DB;
  dataDir: string;
  status: Status;
  private timer?: NodeJS.Timeout;
  private libraryTimer?: NodeJS.Timeout;
  private kodiResyncTimer?: NodeJS.Timeout;

  constructor(db: DB, dataDir: string) {
    super();
    this.setMaxListeners(100);
    this.db = db;
    this.dataDir = dataDir;
    const s = this.settings();
    this.status = {
      nas: { mounted: existsSync(s.mediaRoot), root: s.mediaRoot },
      scan: { running: false },
      sheet: { running: false, lastAt: s.sheetImportedAt || undefined },
      kodi: { running: false, connected: false, host: s.kodiHost || undefined, transport: lanTransport() },
      metadata: { running: false },
      tmdbConfigured: !!s.tmdbKey,
      counts: {},
    };
    this.refreshCounts();
  }

  settings(): Settings {
    return getSettings(this.db);
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const s = saveSettings(this.db, patch);
    this.status.tmdbConfigured = !!s.tmdbKey;
    this.status.kodi.host = s.kodiHost || undefined;
    this.status.nas.root = s.mediaRoot;
    if (patch.scanIntervalMin !== undefined) this.schedule();
    this.emitStatus();
    return s;
  }

  kodiConfig(): KodiConfig | undefined {
    const s = this.settings();
    return s.kodiHost ? { host: s.kodiHost, port: s.kodiPort, user: s.kodiUser, pass: s.kodiPass } : undefined;
  }

  tmdb(): Tmdb | undefined {
    const k = this.settings().tmdbKey;
    return k ? new Tmdb(k) : undefined;
  }

  imagesDir(kind: 'img' | 'thumbs' | 'posters'): string {
    return join(this.dataDir, kind);
  }

  // ---------- events ----------

  emitStatus(): void {
    this.status.kodi.transport = lanTransport();
    this.emit('status', this.status);
  }

  /** Tell clients the library changed (debounced while a long job streams updates). */
  libraryChanged(immediate = false): void {
    this.refreshCounts();
    if (immediate) {
      clearTimeout(this.libraryTimer);
      this.libraryTimer = undefined;
      this.emit('library');
      return;
    }
    this.libraryTimer ??= setTimeout(() => {
      this.libraryTimer = undefined;
      this.emit('library');
    }, 2500);
  }

  private refreshCounts(): void {
    const rows = this.db.prepare("SELECT match_state s, count(*) n FROM items WHERE present = 1 GROUP BY match_state").all() as Array<{ s: string; n: number }>;
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.s] = r.n;
    counts.total = rows.reduce((a, r) => a + r.n, 0);
    this.status.counts = counts;
  }

  private async task(key: 'scan' | 'sheet' | 'kodi' | 'metadata', fn: (st: TaskStatus) => Promise<string | void>): Promise<boolean> {
    const st = this.status[key];
    if (st.running) return false;
    st.running = true;
    st.error = undefined;
    st.progress = undefined;
    this.emitStatus();
    try {
      const msg = await fn(st);
      if (msg) st.message = msg;
      st.lastAt = Date.now();
      return true;
    } catch (e) {
      st.error = (e as Error).message;
      console.warn(`[${key}] ${st.error}`);
      return false;
    } finally {
      st.running = false;
      st.progress = undefined;
      this.refreshCounts();
      this.emitStatus();
    }
  }

  // ---------- jobs ----------

  async scan(): Promise<void> {
    let added = 0;
    const ok = await this.task('scan', async (st) => {
      const root = this.settings().mediaRoot;
      this.status.nas.mounted = existsSync(root);
      if (!this.status.nas.mounted) throw new Error(`Media folder not found: ${root} (is the NAS mounted?)`);
      const known = new Set<string>([
        ...(this.db.prepare("SELECT path FROM items WHERE source = 'disk' AND (size IS NOT NULL OR is_dir = 1)").all() as Array<{ path: string }>).map((r) => r.path),
        ...(this.db.prepare('SELECT path FROM episodes WHERE size IS NOT NULL').all() as Array<{ path: string }>).map((r) => r.path),
      ]);
      const items = await scanMediaRoot(root, {
        known,
        onProgress: (m) => {
          st.message = m;
          this.emitStatus();
        },
      });
      const r = reconcile(this.db, items);
      added = r.added.length;
      if (r.added.length || r.moved) {
        applySheetHints(this.db);
        syncSheetOnlyItems(this.db);
      }
      if (r.added.length || r.moved || r.removed) this.libraryChanged(true);
      return `${items.length} items, ${r.added.length} new, ${r.removed} gone, ${r.moved} moved`;
    });
    if (!ok) return;
    if (this.settings().sheetId && !this.settings().sheetImportedAt) await this.importSheet();
    if (added) await this.onNewFiles();
    await this.metadata();
  }

  /** New files: ask Kodi to pick them up too (it scrapes them into its own library), then re-sync from it later. */
  private async onNewFiles(): Promise<void> {
    const cfg = this.kodiConfig();
    if (!cfg) return;
    try {
      await kodiCall(cfg, 'VideoLibrary.Scan', { showdialogs: false });
      clearTimeout(this.kodiResyncTimer);
      this.kodiResyncTimer = setTimeout(() => void this.metadata(), 3 * 60_000);
    } catch (e) {
      console.warn(`Kodi library scan request failed: ${(e as Error).message}`);
    }
  }

  async importSheet(): Promise<void> {
    await this.task('sheet', async () => {
      const s = this.settings();
      if (!s.sheetId) throw new Error('No Google Sheet set: paste its link in Settings.');
      const rows = await fetchSheet(s.sheetId);
      const r = importSheetRows(this.db, rows);
      saveSettings(this.db, { sheetImportedAt: Date.now() });
      this.libraryChanged(true);
      return `${r.rows} rows, ${r.linked} matched to files, ${r.sheetOnly} not on the NAS`;
    });
  }

  /** Connect to Kodi (auto-discovering it on first run) and work out how it addresses the media folder. */
  async connectKodi(): Promise<KodiConfig | undefined> {
    let cfg = this.kodiConfig();
    if (!cfg) {
      const found = await discoverKodi();
      const k = found.find((f) => !f.needsAuth) ?? found[0];
      if (!k) {
        this.status.kodi.connected = false;
        this.status.kodi.error = 'No Kodi found on the network. Enable "Allow remote control via HTTP" in Kodi.';
        return undefined;
      }
      this.updateSettings({ kodiHost: k.host, kodiPort: k.port });
      cfg = this.kodiConfig()!;
    }
    await kodiCall(cfg, 'JSONRPC.Ping');
    this.status.kodi.connected = true;
    const s = this.settings();
    if (!s.kodiPathPrefix && existsSync(s.mediaRoot)) {
      const tops = readdirSync(s.mediaRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
      const prefix = await detectPathPrefix(cfg, tops, basename(s.mediaRoot));
      if (prefix) this.updateSettings({ kodiPathPrefix: prefix });
    }
    return cfg;
  }

  async syncKodi(): Promise<void> {
    await this.task('kodi', async () => {
      const cfg = await this.connectKodi();
      if (!cfg) throw new Error(this.status.kodi.error ?? 'Kodi not found');
      const prefix = this.settings().kodiPathPrefix;
      if (!prefix) throw new Error('Could not work out how Kodi sees the media folder: set the Kodi path in Settings');
      const r = await syncFromKodi(this.db, cfg, prefix);
      this.libraryChanged(true);
      return `${r.movies} films and ${r.shows} shows in Kodi, ${r.linked} linked to files`;
    }).catch(() => {});
    if (this.status.kodi.error) this.status.kodi.connected = false;
    this.emitStatus();
  }

  private stopRequested = false;

  async metadata(): Promise<void> {
    await this.syncKodi();
    const tmdb = this.tmdb();
    if (!tmdb) {
      void this.prefetchPosters();
      return;
    }
    this.stopRequested = false;
    await this.task('metadata', async (st) => {
      st.message = 'Matching new files on TMDB';
      const m = await matchPending(this.db, tmdb, {
        shouldStop: () => this.stopRequested,
        onProgress: (done, total) => {
          st.progress = { done, total };
          this.emitStatus();
          this.libraryChanged();
        },
      });
      st.message = 'Fetching French titles, cast and trailers';
      const n = await enrichTitles(this.db, tmdb, {
        shouldStop: () => this.stopRequested,
        onProgress: (done, total) => {
          st.progress = { done, total };
          this.emitStatus();
          this.libraryChanged();
        },
      });
      this.libraryChanged(true);
      return `${m.matched} matched, ${m.unmatched} to review, ${n} titles completed`;
    });
    void this.prefetchPosters();
  }

  private prefetching = false;

  /** Warm the poster cache in the background so scrolling the grid never waits on the internet. */
  async prefetchPosters(): Promise<void> {
    if (this.prefetching) return;
    this.prefetching = true;
    try {
      const rows = this.db.prepare(`SELECT DISTINCT t.poster AS url FROM items i
        JOIN titles t ON t.media_type = i.media_type AND t.tmdb_id = i.tmdb_id
        WHERE t.poster IS NOT NULL AND i.custom_poster IS NULL`).all() as Array<{ url: string }>;
      await pool(rows, 2, async ({ url }) => {
        if (!isAllowedImage(url) || this.stopRequested) return;
        await cachedImage(this.imagesDir('img'), url, 342).catch(() => {});
      });
    } finally {
      this.prefetching = false;
    }
  }

  schedule(): void {
    clearInterval(this.timer);
    const min = Math.max(1, this.settings().scanIntervalMin || 10);
    this.timer = setInterval(() => void this.scan(), min * 60_000);
    this.timer.unref();
  }

  start(): void {
    this.schedule();
    void this.scan();
  }

  stop(): void {
    this.stopRequested = true;
    clearInterval(this.timer);
    clearTimeout(this.kodiResyncTimer);
  }
}
