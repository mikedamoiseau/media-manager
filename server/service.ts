import { EventEmitter } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type DB, type KodiTv, type Settings, getSettings, saveSettings } from './db.ts';
import { scanMediaRoot, pool } from './scanner.ts';
import { cachedImage, isAllowedImage } from './images.ts';
import { reconcile, applySheetHints, syncSheetOnlyItems, importSheetRows } from './library.ts';
import { fetchSheet } from './sheet.ts';
import { type KodiConfig, kodiCall, discoverKodi, detectPathPrefix, remote } from './kodi.ts';
import { listProfiles, type Profile } from './profiles.ts';
import { hasParentsCode, kidsProfile, bedtimeStop } from './kids.ts';
import { syncKidsTag } from './kidsTag.ts';
import { syncFromKodi, matchPending, enrichTitles } from './metadata.ts';
import { Tmdb } from './tmdb.ts';
import { lanTransport } from './net.ts';
import { KodiEvents, type KodiInput, type PlayerEvent } from './kodiEvents.ts';
import { TvOwners, notePlay, kodiStates, attributeKodiChanges } from './owners.ts';
import { pickTv, addTv, editTv, tvNumber, firstTvChanged, firstRun } from './tvs.ts';

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
  /** The library sync, from the first TV */
  kodi: TaskStatus & { connected: boolean; transport: string };
  tvs: TvStatus[];
  /** Who's watching: the people who can be picked on a device */
  profiles: Profile[];
  /** A parents' code is set (needed before a kids profile; asked to leave kids mode) */
  kidsCode: boolean;
  metadata: TaskStatus;
  tmdbConfigured: boolean;
  counts: Record<string, number>;
}

/** Runs `job` one at a time: asked again while it runs, it runs once more when done. */
export function oneAtATime(job: () => Promise<void>): () => Promise<void> {
  let running = false;
  let again = false;
  return async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await job();
      } while (again);
    } finally {
      running = false;
    }
  };
}

export interface TvStatus {
  id: string;
  name: string;
  /** Kodi's event connection is up: phones on this TV can type when Kodi shows its keyboard */
  keyboard: boolean;
  /** Kodi's keyboard, while it waits for text */
  input: KodiInput | null;
}

export class Service extends EventEmitter {
  db: DB;
  dataDir: string;
  status: Status;
  private timer?: NodeJS.Timeout;
  private libraryTimer?: NodeJS.Timeout;
  private kodiResyncTimer?: NodeJS.Timeout;
  private kidsTimer?: NodeJS.Timeout;
  /** Each TV's event connection, and the address it is for */
  private events = new Map<string, { host: string; ev: KodiEvents }>();
  /** Who is watching on each TV, for whose progress Kodi's changes are. */
  readonly owners = new TvOwners();

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
      kodi: { running: false, connected: false, transport: lanTransport() },
      tvs: s.kodiTvs.map((t) => ({ id: t.id, name: t.name, keyboard: false, input: null })),
      profiles: listProfiles(db),
      kidsCode: hasParentsCode(db),
      metadata: { running: false },
      tmdbConfigured: !!s.tmdbKey,
      counts: {},
    };
    this.refreshCounts();
  }

  /** Profiles added, changed or removed: every device hears it (one whose profile went asks again who's watching). */
  profilesChanged(): void {
    this.status.profiles = listProfiles(this.db);
    this.status.kidsCode = hasParentsCode(this.db);
    this.emitStatus();
  }

  settings(): Settings {
    return getSettings(this.db);
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const s = saveSettings(this.db, patch);
    this.status.tmdbConfigured = !!s.tmdbKey;
    this.status.nas.root = s.mediaRoot;
    if (patch.scanIntervalMin !== undefined) this.schedule();
    this.emitStatus();
    return s;
  }

  tvs(): KodiTv[] {
    return this.settings().kodiTvs;
  }

  /** This TV, else the first. */
  tv(id?: string): KodiTv | undefined {
    return pickTv(this.tvs(), id);
  }

  kodiConfig(id?: string): KodiConfig | undefined {
    const tv = this.tv(id);
    return tv && { host: tv.host, port: tv.port, user: tv.user, pass: tv.pass };
  }

  /**
   * The TVs as changed in Settings. A new first TV, or a new address or media path for it, syncs the
   * library again; any other TV changed (`id`) only gets its media path worked out, if missing.
   */
  saveTvs(tvs: KodiTv[], id?: string): void {
    const before = this.tvs();
    this.storeTvs(tvs);
    if (firstTvChanged(before, tvs)) {
      void this.syncKodi();
    } else if (id) {
      void this.findPathPrefix(id).catch((e: Error) => console.warn(`Kodi media path: ${e.message}`));
    }
  }

  /** Saved, with the highest TV number given, and connected. */
  private storeTvs(tvs: KodiTv[]): void {
    const last = Math.max(this.settings().kodiTvLast, ...tvs.map((t) => tvNumber(t.id)));
    saveSettings(this.db, { kodiTvs: tvs, kodiTvLast: last });
    this.connectTvs();
  }

  /** One event connection per TV, for its keyboard and what it plays: opened, moved or closed as the TVs change. */
  private connectTvs(): void {
    const tvs = this.tvs();
    for (const [id, e] of this.events) {
      if (tvs.some((t) => t.id === id)) continue;
      this.events.delete(id);
      e.ev.stop();
    }
    for (const tv of tvs) {
      let e = this.events.get(tv.id);
      if (!e) this.events.set(tv.id, (e = { host: '', ev: new KodiEvents(() => this.tvsChanged(), undefined, undefined, (p) => this.onPlayer(tv.id, p)) }));
      if (e.host === tv.host) continue;
      e.host = tv.host;
      e.ev.connect(tv.host);
    }
    this.tvsChanged();
  }

  /** A TV started a film or episode of Kodi's library: noted for whoever is watching there. */
  private onPlayer(tvId: string, e: PlayerEvent): void {
    const now = Date.now();
    if (e.kind === 'stop') return this.owners.stop(tvId, !!e.ended, now);
    const owner = this.owners.start(tvId, now, this.seriesOf(e));
    // Called from the TV's socket: an error here would stop the server.
    try {
      if (e.item?.type === 'movie' || e.item?.type === 'episode') notePlay(this.db, e.item.type, e.item.id, owner, now);
      // A kid's bedtime: Kodi doesn't go on with the next episode.
      const tv = this.tvs().find((t) => t.id === tvId);
      if (tv && bedtimeStop(kidsProfile(this.db, owner), this.owners.chained(tvId), new Date(now))) {
        remote(tv, 'stop').catch((err: Error) => console.warn(`Bedtime stop on ${tv.name}: ${err.message}`));
      }
    } catch (err) {
      console.warn(`Kodi play not noted: ${(err as Error).message}`);
    }
  }

  /** The series (item id) of the episode Kodi started; none for a film, or an episode the app doesn't know. */
  private seriesOf(e: PlayerEvent): number | undefined {
    if (e.item?.type !== 'episode') return undefined;
    try {
      return (this.db.prepare('SELECT item_id FROM episodes WHERE kodi_id = ?').get(e.item.id) as { item_id: number } | undefined)?.item_id;
    } catch {
      return undefined;
    }
  }

  private tvsChanged(): void {
    this.status.tvs = this.tvs().map((t) => {
      const ev = this.events.get(t.id)?.ev;
      return { id: t.id, name: t.name, keyboard: ev?.live ?? false, input: ev?.input ?? null };
    });
    this.emitStatus();
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

  /** What the kids may watch may have changed (a profile, a parent's call, Kodi, ratings): the Kids tag in Kodi follows, after a pause. */
  kidsChanged(): void {
    clearTimeout(this.kidsTimer);
    this.kidsTimer = setTimeout(() => {
      this.kidsTimer = undefined;
      void this.syncKidsTag();
    }, 5000);
  }

  private readonly syncKidsTag = oneAtATime(async () => {
    const cfg = this.kodiConfig();
    if (!cfg) return;
    try {
      const n = await syncKidsTag(this.db, cfg);
      if (n) console.log(`[kids] Kids tag changed on ${n} titles in Kodi`);
    } catch (e) {
      console.warn(`[kids] Kids tag not updated: ${(e as Error).message}`);
    }
  });

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

  /** Connect to the first TV (auto-discovering one on first run) and work out how it addresses the media folder. */
  async connectKodi(): Promise<KodiConfig | undefined> {
    if (!this.tvs().length && !firstRun(this.settings())) {
      this.status.kodi.connected = false;
      this.status.kodi.error = 'No TV set up: add one in Settings › TVs.';
      return undefined;
    }
    if (!this.tvs().length) {
      const found = await discoverKodi();
      const k = found.find((f) => !f.needsAuth) ?? found[0];
      if (!k) {
        this.status.kodi.connected = false;
        this.status.kodi.error = 'No Kodi found on the network. Enable "Allow remote control via HTTP" in Kodi.';
        return undefined;
      }
      this.storeTvs(addTv([], { name: k.name, host: k.host, port: k.port }, this.settings().kodiTvLast));
    }
    const tv = this.tv()!;
    const cfg = this.kodiConfig(tv.id)!;
    await kodiCall(cfg, 'JSONRPC.Ping');
    this.status.kodi.connected = true;
    await this.findPathPrefix(tv.id);
    return cfg;
  }

  /** Work out how this TV's Kodi addresses the media folder, unless known. */
  async findPathPrefix(id: string): Promise<void> {
    const s = this.settings();
    const tv = s.kodiTvs.find((t) => t.id === id);
    if (!tv || tv.pathPrefix || !existsSync(s.mediaRoot)) return;
    const tops = readdirSync(s.mediaRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    const prefix = await detectPathPrefix(this.kodiConfig(id)!, tops, basename(s.mediaRoot));
    // The TVs may have changed while Kodi answered.
    if (prefix && this.tvs().some((t) => t.id === id && t.host === tv.host && !t.pathPrefix)) {
      saveSettings(this.db, { kodiTvs: editTv(this.tvs(), id, { pathPrefix: prefix }) });
    }
  }

  /** Asked again while it runs (the first TV changed meanwhile): it syncs once more after. */
  readonly syncKodi = oneAtATime(() => this.syncKodiOnce());

  private async syncKodiOnce(): Promise<void> {
    await this.task('kodi', async () => {
      const cfg = await this.connectKodi();
      if (!cfg) throw new Error(this.status.kodi.error ?? 'Kodi not found');
      const tv = this.tv()!;
      if (!tv.pathPrefix) throw new Error(`Could not work out how Kodi sees the media folder: set the media path of ${tv.name} in Settings`);
      const prefix = tv.pathPrefix;
      const before = kodiStates(this.db);
      const r = await syncFromKodi(this.db, cfg, prefix);
      attributeKodiChanges(this.db, before);
      this.libraryChanged(true);
      // Kodi may have re-scraped a title and lost its tag, or got new ones.
      this.kidsChanged();
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
      // New ratings and genres: the kids' titles may differ.
      this.kidsChanged();
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
    this.connectTvs();
    void this.scan();
  }

  stop(): void {
    this.stopRequested = true;
    clearInterval(this.timer);
    clearTimeout(this.kodiResyncTimer);
    for (const e of this.events.values()) e.ev.stop();
  }
}
