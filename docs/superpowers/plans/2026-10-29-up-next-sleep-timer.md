# Up next and sleep timer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-TV Up next list that plays films and episodes one after another, and a per-TV sleep timer (after this one, or in N minutes).

**Architecture:** The list and the timer live in the app's SQLite (migration 14), per TV. The Service hears each TV's `Player.OnStop` (with Kodi's `end` flag) and starts the next entry through the same Play as the Play on TV button, moved out of the route into `playItem`. A 15 s check stops TVs whose timer is due. Both reach every device in `TvStatus` over the existing status stream.

**Tech Stack:** Node ≥24 (strip-only TypeScript), Hono, node:sqlite, node:test; React 19 + Vite.

**Spec:** docs/superpowers/specs/2026-10-29-up-next-sleep-timer-design.md

## Global Constraints

- No enums, no parameter properties (tsconfig `erasableSyntaxOnly`).
- Stale list: cleared after `6 * 3600_000` ms without an add or a play from it.
- "After this" timer lapses after `6 * 3600_000` ms.
- Timer check every `15_000` ms; pause before the next entry `1000` ms.
- Sleep minutes: whole number 1 to 240. UI choices 15, 30, 45, 60, 90.
- Routes are refused to kids (not added to `KIDS_ROUTES`).
- No personal data (titles from the library, country, names) in tests or docs; tests use made-up titles.
- Codex review (`codex-companion.mjs review --wait --scope working-tree`) before each commit; no attribution lines.

## Review Focus

1. A play replaced by another Play (Kodi sends `OnStop` without `end`): the list must not move on, and an "after this" timer is done.
2. Kodi going on by itself after an end while "after this" is set (a box with autoplay on): that chained play is stopped; an app Play is never stopped.
3. An entry whose file left the NAS: dropped, the next one plays; an empty list ends quietly.
4. A list untouched for 6 h when a play ends: nothing starts, the list is cleared.
5. Adding a series while one of its episodes plays on that TV: the episode after it, not the one playing.

---

### Task 1: Storage (migration 14, `server/upnext.ts`)

**Files:**
- Modify: `server/db.ts` (append migration 14)
- Create: `server/upnext.ts`
- Test: `tests/upnext.test.ts`

**Interfaces:**
- Produces:
  - `STALE = 6 * 3600_000`, `AFTER_THIS_LAPSE = 6 * 3600_000`
  - `interface UpNextRow { id: number; tvId: string; itemId: number; episodeId: number | null; profileId: number }`
  - `interface UpNextEntry { id: number; itemId: number; episodeId: number | null; season: number | null; episode: number | null; episodeTitle: string | null }`
  - `class UpNextError extends Error { code: 'duplicate' | 'none_left' }` (field assigned in the constructor)
  - `upNext(db, tvId): UpNextRow[]` (in order of id)
  - `upNextEntries(db, tvId): UpNextEntry[]` (for the status; joins `episodes`)
  - `addToUpNext(db, tvId, profileId, itemId, episodeId: number | null, now): UpNextRow` (throws `duplicate` when the same film or episode is on that TV's list; refreshes the TV's `at`)
  - `removeFromUpNext(db, tvId, id): boolean`, `clearUpNext(db, tvId): void`, `forgetTv(db, tvId): void` (list and timer)
  - `takeFromUpNext(db, tvId, now, id?: number): UpNextRow | undefined` (that entry or the first, removed; the rest's `at` refreshed)
  - `dropStale(db, now): string[]` (tv ids whose list was cleared: newest `at` older than `STALE`)
  - `episodeToQueue(db, tvId, itemId, profileId, playingKodiEpisode?: number): number | undefined`
  - `type Sleep = { at: number } | { afterThis: true } | null`
  - `sleepOf(db, tvId, now): Sleep` (a lapsed "after this" reads as null)
  - `setSleep(db, tvId, s: { minutes: number } | { afterThis: true }, now): void`, `clearSleep(db, tvId): void`
  - `dueSleeps(db, now): { stop: string[]; lapsed: string[] }` (removes both)

Migration 14:

```sql
CREATE TABLE up_next (
  id INTEGER PRIMARY KEY,
  tv_id TEXT NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  at INTEGER NOT NULL
);
CREATE INDEX up_next_tv ON up_next(tv_id);
CREATE TABLE tv_sleep (
  tv_id TEXT PRIMARY KEY,
  at INTEGER,          -- when to stop; null: after what plays now
  until INTEGER NOT NULL  -- an "after this" left behind lapses then
);
```

`episodeToQueue` order of bases, on the series' episodes without extras (season 0) in `episodesOf` order: the last queued episode of this series on that TV; else the episode playing now (`playingKodiEpisode`, matched by `episodes.kodi_id`) when it is of this series; then the episode after the base. No base: `nextEpisode(db, itemId, profileId)` (where the series stands). A result already queued on that TV, or none after the base: `undefined`.

- [ ] **Step 1: Write the failing tests** in `tests/upnext.test.ts` (in-memory `openDb(':memory:')`, a made-up series "Show" with S1E1–E3 and an extra S0E1, a made-up film):
  - `adds in order and refuses a duplicate`: two adds → `upNext` ids ascending; adding the film again throws `UpNextError` with code `duplicate`; the same film on `tv2` is fine.
  - `takes the first entry or the one asked, refreshing the rest`: add A at t0, B at t0; `takeFromUpNext(db,'tv1',t1)` returns A; B's `at` is t1 (read the row); `takeFromUpNext(db,'tv1',t1, B.id)` returns B; then `undefined`.
  - `clears a list untouched for 6 hours`: add at t0; `dropStale(db, t0 + STALE - 1)` → `[]`; `dropStale(db, t0 + STALE + 1)` → `['tv1']` and the list is empty.
  - `queues the episode after the last queued one`: S1E1 queued → `episodeToQueue` gives S1E2's id; with E3 queued last → `undefined`.
  - `queues the episode after the one playing`: nothing queued, `playingKodiEpisode` = S1E2's kodi id → S1E3; a kodi id of another series → falls back to where the series stands (S1E1, nothing watched).
  - `removes entries with their profile`: `removeProfile` (from profiles.ts) of the adder → list empty.
  - `sets, reads and fires timers`: `setSleep({minutes: 45}, t0)` → `sleepOf` `{at: t0 + 45*60_000}`; `dueSleeps(t0 + 45*60_000)` → `{stop:['tv1'], lapsed:[]}` and `sleepOf` null; `setSleep({afterThis:true}, t0)` → `sleepOf(t0+1)` `{afterThis:true}`, `sleepOf(t0 + AFTER_THIS_LAPSE + 1)` null, `dueSleeps(t0 + AFTER_THIS_LAPSE + 1)` → `{stop:[], lapsed:['tv1']}`.

- [ ] **Step 2: Run** `node --test tests/upnext.test.ts` — Expected: FAIL, module `server/upnext.ts` not found.
- [ ] **Step 3: Implement** migration 14 and `server/upnext.ts` as the Interfaces say.
- [ ] **Step 4: Run** `node --test tests/upnext.test.ts` — Expected: all pass. Then `npm test` and `npm run typecheck` — Expected: green.
- [ ] **Step 5: Codex review, then commit** `feat(upnext): per-TV list and sleep timer storage`.

### Task 2: One Play for the button and the list (`server/playItem.ts`)

**Files:**
- Create: `server/playItem.ts`
- Modify: `server/api.ts` (`POST /items/:id/play` calls it)
- Test: `tests/media-path.test.ts` (existing Play tests stay green), `tests/upnext-service.test.ts` (new, first test)

**Interfaces:**
- Consumes: `Service` (type import): `tv(id)`, `kodiConfig(id)`, `findPathPrefix(id)`, `owners`, `db`.
- Produces:
  - `class PlayError extends Error { status: 400 | 403 | 404; code?: string }`
  - `playItem(svc: Service, tvId: string, profileId: number, itemId: number, episodeId?: number): Promise<void>` — exactly what the route body does today from the bedtime check to `recordActivity` (403 `bedtime`, 404 "File is not on the NAS", 404 "No episode found", 400 "Kodi path for the media folder is unknown: set it in Settings"); Kodi errors pass through unchanged.

- [ ] **Step 1: Write the failing test** `tests/upnext-service.test.ts` › `playItem refuses a film that left the NAS`: item with `present = 0` → rejects with `PlayError` status 404, and the stand-in Kodi saw no `Player.Open`. (Stand-in Kodi: an HTTP server like `kodiWithoutSources` in media-path.test.ts, recording calls; `Player.GetActivePlayers` answers from a mutable list.)
- [ ] **Step 2: Run** `node --test tests/upnext-service.test.ts` — Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `playItem`; the route becomes `try { await playItem(svc, tv, p, id, body.episodeId) } catch (e) { if (e instanceof PlayError) return c.json({ error: e.message, code: e.code }, e.status); throw e; }` (no `code` key when undefined, as today).
- [ ] **Step 4: Run** `node --test tests/upnext-service.test.ts tests/media-path.test.ts tests/kids-api.test.ts` (whichever test files hit `/play`; `grep -l "/play'" tests`) — Expected: pass. `npm test`, `npm run typecheck` — green.
- [ ] **Step 5: Codex review, then commit** `refactor(play): one Play for the button and Up next`.

### Task 3: The Service moves on and stops (`server/service.ts`)

**Files:**
- Modify: `server/service.ts`
- Test: `tests/upnext-service.test.ts`

**Interfaces:**
- Consumes: Task 1's functions; Task 2's `playItem`; `remote(cfg, 'stop')` from kodi.ts; `owners.chained(tvId)`.
- Produces:
  - `TvStatus` gains `upNext: UpNextEntry[]` and `sleep: Sleep` (filled in `tvsChanged`, also in the constructor's initial status).
  - `onPlayer(tvId, e): Promise<void>` becomes public (tests drive it).
  - `upNextChanged(): void` (recomputes the TVs' status and emits; routes call it).
  - `playNext(tvId: string, id?: number): Promise<boolean>` — takes entries until one plays (`playItem` as the entry's profile; a `PlayError` or Kodi error drops it with a warning); true when one played; emits the status.
  - `checkSleep(now = Date.now()): Promise<void>` — `dueSleeps`: stop each due TV (`remote(cfg, 'stop')`, errors logged); `dropStale`; emits when anything changed. Started in `start()` every 15 s (`unref`), cleared in `stop()`.
  - `NEXT_PAUSE = 1000` exported.
- Behaviour in `player()`:
  - `play`: remember the Kodi item playing on that TV (`Map<tvId, {type, id}>`, for Task 4's `episodeToQueue`). If the TV was marked "stop the chain" (below), unmark it, and when `owners.chained(tvId)` stop it (`remote`), as bedtime does.
  - `stop`: forget the item. An "after this" timer (`sleepOf` gives `afterThis`): clear it, mark the TV "stop the chain" when `ended`, emit, return. Else when `ended`: `dropStale`, wait `NEXT_PAUSE`, `playNext(tvId)`.
- `saveTvs`: a TV no longer in the list → `forgetTv`.

- [ ] **Step 1: Write the failing tests** in `tests/upnext-service.test.ts` (stand-in Kodi with recorded calls; `new Service(db, dataDir)` without `start()`; settings with one TV `tv1` at the stand-in's port; a made-up film A, film B, profile "Anna"):
  - `a play that ends starts the first entry, as its profile`: Anna adds B (`addToUpNext`); `await svc.onPlayer('tv1', {kind:'stop', ended:true})` → last `Player.Open` item is `{movieid: <B kodi id>}`; list empty; `svc.status.tvs[0].upNext` is `[]`; `svc.owners.start('tv1', Date.now())` is Anna's id.
  - `a play stopped by hand leaves the list`: `{kind:'stop', ended:false}` → no `Player.Open`; list unchanged.
  - `an entry that left the NAS is dropped and the next plays`: A not present, B present; both queued; ended stop → `Player.Open` for B; list empty.
  - `stop after this: nothing follows, and Kodi's own next is stopped`: `setSleep({afterThis:true})`, B queued; ended stop → no `Player.Open`; `sleepOf` null; B still queued; then `onPlayer('tv1', {kind:'play', item:{type:'episode', id: <kodi id>}})` for the next episode of the series that ended (start the ended play with `owners.start(tv, t, show)` first so `chained` is true) → a `Player.Stop` call.
  - `stop after this, stopped by hand: the timer is done, nothing is stopped later`: ended=false → `sleepOf` null; a following play → no `Player.Stop`.
  - `a stale list does not start`: entry `at` = now − STALE − 1 (update the row) → ended stop → no `Player.Open`, list empty.
  - `the timer stops the TV when due`: `setSleep({minutes: 1}, t0)`; `await svc.checkSleep(t0 + 60_000)` → a `Player.Stop` call; `sleepOf` null; status `sleep` null.
  - `a removed TV takes its list`: `svc.saveTvs([])` → `upNext(db,'tv1')` empty.
  Tests set no fake timers: `NEXT_PAUSE` is 1 s, and only the ended-with-a-list tests wait for it.
- [ ] **Step 2: Run** `node --test tests/upnext-service.test.ts` — Expected: FAIL (status has no `upNext`; nothing plays).
- [ ] **Step 3: Implement** as the Interfaces say.
- [ ] **Step 4: Run** `node --test tests/upnext-service.test.ts` — pass; `npm test`, `npm run typecheck` — green.
- [ ] **Step 5: Codex review, then commit** `feat(upnext): the TV moves on to Up next; the sleep timer stops it`.

### Task 4: Routes (`server/upnextRoutes.ts`)

**Files:**
- Create: `server/upnextRoutes.ts` (`upNextRoutes(api, svc, kodi, who)`, mounted in `createApi` next to `liveTvRoutes`)
- Modify: `server/api.ts`
- Test: `tests/upnext-api.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `nowPlaying`-free: the episode playing comes from the Service's map (`svc.playingOn(tvId): { type: string; id: number } | undefined`, added here).
- Produces (all on the device's TV from `kodi(c)`, profile from `who(c)`; every success calls `svc.upNextChanged()` and answers `{ upNext: UpNextEntry[] }`):
  - `POST /upnext` `{ itemId: number, episodeId?: number }`: item missing or not present → 404 "File is not on the NAS"; a folder (series) without `episodeId` → `episodeToQueue`, none → 404 `{error: 'No episode left to add', code: 'none_left'}`; `episodeId` not of that item → 404 "No episode found"; duplicate → 409 `{error: 'Already in Up next', code: 'duplicate'}`. Answers also `added: { season, episode } | null`.
  - `DELETE /upnext/:id` (404 when not on that TV's list), `DELETE /upnext`.
  - `POST /upnext/:id/play`: 404 when not on the list; else `svc.playNext(tv, id)`; false → 404 "Could not play it". 
  - `PUT /kodi/sleep` `{ minutes }` integer 1–240, or `{ afterThis: true }` (409 "Nothing is playing" when `Player.GetActivePlayers` is empty); anything else 400. Answers `{ sleep }`.
  - `DELETE /kodi/sleep` → `{ sleep: null }`.

- [ ] **Step 1: Write the failing tests** `tests/upnext-api.test.ts` (Hono app over `createApi(svc)` with a stand-in Kodi, headers `x-kodi-tv: tv1`, `x-profile`):
  - film add → 200, `upNext` length 1; again → 409 `duplicate`.
  - series added three times with no `episodeId` → S1E1, S1E2, S1E3 (`added`), fourth → 404 `none_left`.
  - with the Service's playing map set to S1E2 (via `svc.onPlayer('tv1',{kind:'play', item:{type:'episode', id}})`) and nothing queued → adds S1E3.
  - `DELETE /upnext/:id` → list shrinks; unknown id → 404; `DELETE /upnext` → empty.
  - `POST /upnext/:id/play` → `Player.Open` for that entry, the entry gone.
  - `PUT /kodi/sleep {minutes: 45}` → `{sleep:{at}}` ≈ now + 45 min; `{minutes: 0}`, `{minutes: 241}`, `{minutes: 1.5}`, `{}` → 400; `{afterThis:true}` with no active player → 409; with one → 200 `{sleep:{afterThis:true}}`; `DELETE /kodi/sleep` → null.
  - a kids profile (`addProfile` with `kids`) on `POST /upnext` and `PUT /kodi/sleep` → 403.
- [ ] **Step 2: Run** `node --test tests/upnext-api.test.ts` — Expected: FAIL (404 from Hono for unknown routes).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file, `npm test`, `npm run typecheck` — green.
- [ ] **Step 5: Codex review, then commit** `feat(upnext): routes to add, remove, play now and set the timer`.

### Task 5: Web (Detail, Remote) and the roadmap

**Files:**
- Create: `web/src/upNext.ts` (labels), `web/src/components/UpNext.tsx` (`UpNextList`, `SleepButton`/`SleepSheet`)
- Modify: `web/src/types.ts` (`TvStatus.upNext`, `TvStatus.sleep`, `UpNextEntry`, `Sleep`), `web/src/components/Detail.tsx`, `web/src/components/Remote.tsx`, `web/src/components/icons.tsx` (`IconListPlus`, `IconMoon`), `web/src/styles.css`, `docs/ROADMAP.md` (item 5 Done, section 5 says what was built)
- Test: `tests/upnext-web.test.ts`

**Interfaces:**
- Consumes: Task 4's routes and `TvStatus` fields.
- Produces (`web/src/upNext.ts`):
  - `entryLabel(e: UpNextEntry): string | null` → `"S2 E5"` (season and episode), `"E5"` (no season), null (film).
  - `sleepLabel(s: Sleep, now: number, episode: boolean): string | null` → `"Stops in 42 min"` (minutes rounded up, at least 1), `"Stops after this episode"` / `"Stops after this film"`, null when off.

UI (copy from the spec):
- Detail: `Up next` button (IconListPlus) after Play on TV when present, not bedtime, not kids; disabled when Kodi isn't ready, and for a film already on the device TV's list (reads "In Up next"). Toast `Added S2 E5 to Up next on <tv name>` / `Added to Up next on <tv name>`; errors as toasts (server copy).
- Episode rows: an `ep-queue` button (IconListPlus, aria-label `Add <title> to Up next`) when not kids and Kodi ready.
- Remote: `UpNextList` after the transport: section title "Up next" with "Clear" when not empty; rows with `Poster` (from `library.items` by `itemId`, `displayTitle` with the title language pref), title, `entryLabel` · episode title; tap → `POST /upnext/:id/play`; remove button (aria-label `Remove <title> from Up next`). Empty: the help line. Hidden in kids mode.
- Now-playing card: `Next: <entryLabel> · <episode title or title>` under the slider when active and the list isn't empty; sleep pill with `sleepLabel` (re-rendered every 30 s) opening the sheet; a moon `icon-btn on-image` beside the power button (not in kids mode).
- Sleep sheet (existing `Sheet`): "After this episode"/"After this film" (only when active), "In 15 minutes", 30, 45, 60, 90, "Turn off" when set.

- [ ] **Step 1: Write the failing tests** `tests/upnext-web.test.ts`: `entryLabel` three cases; `sleepLabel` for `{at: now + 41.2 min}` → "Stops in 42 min", `{at: now + 10_000}` → "Stops in 1 min", `{afterThis:true}` episode/film, null.
- [ ] **Step 2: Run** `node --test tests/upnext-web.test.ts` — Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `upNext.ts`, then the components and styles.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run build` — green. Browser check on a sandbox server (copy of the DB, TVs pointed at 127.0.0.1:9 so nothing plays on a real TV): add a film and an episode from their pages, see them on the Remote, remove one, set and clear a timer. Screenshots at phone width.
- [ ] **Step 5: Codex review, then commit** `feat(upnext): Up next on title pages and the Remote, with the sleep timer` (ROADMAP in the same commit).
