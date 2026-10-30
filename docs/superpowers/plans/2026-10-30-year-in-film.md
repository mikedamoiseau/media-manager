# Your year in film Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A log of every play from now on, filled once from what the app already knows, and from December a "Your year in film" question, Home card and animated story per profile on the phone.

**Architecture:** A `plays` table is written by the service (Kodi's play/pause/resume/stop events per TV), by the phone stream route, once by a fill from Kodi's last plays and the phone's last streams, and after each Kodi sync for plays the app missed. A pure `yearInFilm(db, profile, year, now, tvNames)` turns a profile's plays into the story's numbers; `/api/year` serves them with the actor's TMDB photo. The phone shows a question sheet, a Home card and a full-screen story built from those numbers with CSS animations.

**Tech Stack:** Node 24 (TypeScript run as is: no enums, no parameter properties), `node:sqlite`, Hono, `node:test`; React 19 + Vite + wouter; CSS animations only.

**Spec:** `docs/superpowers/specs/2026-10-30-year-in-film-design.md`

## Global Constraints

- No new libraries (spec, call 15). Animations in CSS.
- A play counts from **5 minutes** (`MIN_PLAY_MINUTES = 5`).
- "Finished" is the app's `FINISHED` (0.9, `server/watching.ts`); "started" is `STARTED` (0.02).
- Only titles matched on TMDB as a film or a series count (`items.media_type IN ('movie','tv')` with a `titles` row); fitness, courses, other and unmatched files are logged but not counted.
- Not counted: Live TV, trailers, anything not in the library.
- The question and the card: **1 December to 31 January**. December shows the current year up to today; January the year just ended.
- Fewer than **3** films and episodes watched in the year: no question, no card (`MIN_WATCHED = 3`).
- Asked once per profile per year, on the server (`year_asked`).
- Kids profiles get it too; `/year` and `/year/asked` join `KIDS_ROUTES`.
- "Reduce motion": cards fade, nothing drifts.
- The main profile's 2026 includes everything given to it before profiles (no "household" wording).
- Public repository: no titles, names or numbers from the owner's library in code, tests or docs (tests use made-up titles).
- Codex review before each commit; no attribution lines in commits; push only when the owner asks.

## Review Focus

1. A play whose stop never came (the app restarted mid-film, the TV switched off): it must not count as hours of wall time; it counts only with the progress Kodi later reports. Pinned in Task 3 and Task 6.
2. Kodi sends `Player.OnPlay` for a TV that already has an open play (it went on to the next item, or a resume reported as a play): the open one is closed first, never two open rows on one TV. Pinned in Task 3.
3. A play started on 31 December at 23:30 belongs to that year, one started at 00:10 on 1 January to the next. Pinned in Task 7.
4. A title gone from the NAS since (`present = 0`) was still watched: it counts. Pinned in Task 7.
5. Prime time uses the local hour of each play (Kodi's last-played times are local, `kodiTime`). Pinned in Task 7.

---

## File Structure

- `server/db.ts`: migration 15 (`plays`, `year_asked`, `person_photos`, `episodes.runtime`).
- `server/metadata.ts`: Kodi episode runtimes.
- `server/plays.ts` (new): writing the log (open, close, phone, fill, missed plays, left open).
- `server/kodiEvents.ts`: `pause` / `resume` player events.
- `server/service.ts`: the TV side of the log.
- `server/owners.ts`: `attributeKodiChanges` returns what it gave.
- `server/api.ts`: phone plays from the stream route; mounts the year routes.
- `server/yearInFilm.ts` (new): the numbers, the window.
- `server/yearApi.ts` (new): `/year`, `/year/asked`, the actor's photo.
- `server/tmdb.ts`: `personPhoto(name)`.
- `server/kids.ts`: two routes for kids.
- `web/src/types.ts`, `web/src/store.ts`, `web/src/yearInFilm.ts` (new, pure helpers), `web/src/components/YearInFilm.tsx` (new: question, card, story), `web/src/components/Library.tsx` (the card on Home), `web/src/App.tsx` (the story's route, the question), `web/src/styles.css`.
- Tests: `tests/plays.test.ts`, `tests/plays-service.test.ts`, `tests/year.test.ts`, `tests/year-api.test.ts`, `tests/year-web.test.ts` (new); `tests/owners.test.ts`, `tests/kids.test.ts` (changed).
- `docs/ROADMAP.md`: item 7 done.

---

### Task 1: The tables, and episode runtimes from Kodi

**Files:**
- Modify: `server/db.ts` (append one entry to `MIGRATIONS`)
- Modify: `server/metadata.ts:115-150` (`fetchKodiLibrary`, `applyKodiLibrary`)
- Test: `tests/plays.test.ts` (new)

**Interfaces:**
- Produces: tables `plays`, `year_asked`, `person_photos`; column `episodes.runtime` (minutes, from Kodi). `KodiLibrary['episodes'][number]` gains `runtime?: number` (seconds).

- [ ] **Step 1: Write the failing tests**

```ts
test('the log and its tables exist', () => {
  const db = openDb(':memory:');
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
  assert.deepEqual(cols('plays'), ['id', 'profile_id', 'item_id', 'episode_id', 'device', 'at', 'minutes', 'reached', 'finished', 'estimated']);
  assert.deepEqual(cols('year_asked'), ['profile_id', 'year', 'at']);
  assert.deepEqual(cols('person_photos'), ['name', 'url', 'fetched_at']);
  assert.ok(cols('episodes').includes('runtime'));
});

test("an episode's runtime comes from Kodi, in minutes", () => {
  // one series item with one episode file, as in tests/series.test.ts; Kodi reports runtime in seconds
  applyKodiLibrary(db, 'smb://nas/MEDIA', { movies: [], shows: [], episodes: [{ episodeid: 7, file: 'smb://nas/MEDIA/SERIES/Show/S01E01.mkv', runtime: 2700, playcount: 0, lastplayed: '' }] });
  assert.equal((db.prepare('SELECT runtime FROM episodes').get() as { runtime: number }).runtime, 45);
});
```

- [ ] **Step 2: Run them to watch them fail**

Run: `node --test tests/plays.test.ts`
Expected: FAIL (no table `plays`; runtime null).

- [ ] **Step 3: Write migration 15**

```sql
-- Every play of a film or episode, for Your year in film. A play from Kodi's events or the phone has a device and,
-- once over, its minutes; an estimated one (put in from Kodi's last plays, the phone's last streams, or a play the
-- app missed) has no device and only how far it got.
CREATE TABLE plays (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE, -- null: a film
  device TEXT,                        -- a TV's id, 'phone'; null: estimated
  at INTEGER NOT NULL,                -- when it started
  minutes REAL,                       -- played, without pauses; null while it plays, or not known
  reached REAL,                       -- how far it got (0..1), when known
  finished INTEGER NOT NULL DEFAULT 0,
  estimated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX plays_profile ON plays(profile_id, at);
-- Whether each profile was asked about its year (either answer).
CREATE TABLE year_asked (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, year)
);
-- An actor's TMDB photo (url null: TMDB has none), looked up by name.
CREATE TABLE person_photos (name TEXT PRIMARY KEY, url TEXT, fetched_at INTEGER NOT NULL);
-- An episode's runtime in minutes, from Kodi.
ALTER TABLE episodes ADD COLUMN runtime INTEGER;
```

- [ ] **Step 4: Episode runtimes**

Add `'runtime'` to the `VideoLibrary.GetEpisodes` properties in `fetchKodiLibrary`, `runtime?: number` to the episode type, and write `Math.round(runtime / 60)` (null when 0 or missing) in `epLink` (also in its "changed" condition).

- [ ] **Step 5: Run the tests, then the suite**

Run: `node --test tests/plays.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Codex review, commit**

```bash
git add server/db.ts server/metadata.ts tests/plays.test.ts
git commit -m "feat(year): the play log's tables, and episode runtimes from Kodi"
```

### Task 2: Writing the log

**Files:**
- Create: `server/plays.ts`
- Test: `tests/plays.test.ts`

**Interfaces:**
- Consumes: Task 1's tables; `FINISHED`, `kodiTime` from `server/watching.ts`.
- Produces:
  - `export const MIN_PLAY_MINUTES = 5; export const EPISODE_MINUTES = 40; export const PHONE_SESSION = 4 * 3600_000;`
  - `export function libraryTitle(db, kodiType: 'movie' | 'episode', kodiId: number): { itemId: number; episodeId: number | null } | undefined` (a film: the present item with that `kodi_id` and `kodi_type = 'movie'`, else any; an episode: by `episodes.kodi_id`).
  - `export function runtimeOf(db, itemId: number, episodeId: number | null): number | null` (minutes: `titles.runtime` for a film, `episodes.runtime` for an episode).
  - `export function openPlay(db, p: { profileId: number; itemId: number; episodeId: number | null; device: string; at: number }): number` (row id).
  - `export function closePlay(db, id: number, minutes: number, finished: boolean): void` (minutes capped at the runtime when known, never below 0).
  - `export function closeLeftOpen(db): number` (rows with `minutes IS NULL AND estimated = 0 AND device IS NOT 'phone'` become `estimated = 1`: their end was missed).
  - `export function notePhonePlay(db, profileId: number, itemId: number, episodeId: number | null, begunAt: number, reached: number, now: number): void`.
  - `export function playMinutes(r: { minutes: number | null; reached: number | null }, runtime: number | null, episode: boolean): number` (`minutes ?? (reached ?? 0) * (runtime ?? (episode ? EPISODE_MINUTES : 0))`).

- [ ] **Step 1: Write the failing tests**

- `'a film started on a TV is found by its Kodi id, the copy on the NAS first'`: two items with `kodi_id` 11 (one `present = 0`) → `libraryTitle(db, 'movie', 11)` is the present one; `libraryTitle(db, 'episode', 101)` gives the episode and its series.
- `'a play closed: its minutes, at most the runtime'`: film runtime 100; `closePlay(db, id, 130, true)` → `minutes = 100, finished = 1`.
- `'a play whose end was missed is an estimate with nothing known'`: open row, `closeLeftOpen(db)` → 1; row `estimated = 1`, `minutes` null; `playMinutes(row, 100, false) === 0`.
- `'the phone: one play per sitting, how far it got and how long it ran'`: `notePhonePlay(…, begunAt = t, reached = 0.3, now = t + 20 min)` then `(begunAt = t + 25 min, reached = 0.6, now = t + 50 min)` → one row: `at = t`, `minutes = 50`, `reached = 0.6`, `finished = 0`; a third note with reached 0.95 → `finished = 1`; a note 5 hours later → a second row.
- `'an estimate counts its share of the runtime; an episode without one, 40 minutes'`: `playMinutes({ minutes: null, reached: 0.5 }, 100, false) === 50`; `playMinutes({ minutes: null, reached: 1 }, null, true) === 40`.

- [ ] **Step 2: Run them to watch them fail**

Run: `node --test tests/plays.test.ts`
Expected: FAIL (module `server/plays.ts` missing).

- [ ] **Step 3: Implement `server/plays.ts` with the signatures above**

Phone sitting: the latest `device = 'phone'` row of that profile and title with `at >= now - PHONE_SESSION`; update `at = min(at, begunAt)`, `reached = max(reached, reached)`, `minutes = min((now - at) / 60000, runtime ?? Infinity)`, `finished = reached >= FINISHED`; else insert.

- [ ] **Step 4: Run the tests, then the suite**

Run: `node --test tests/plays.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Codex review, commit**

```bash
git add server/plays.ts tests/plays.test.ts
git commit -m "feat(year): writing the play log"
```

### Task 3: Plays on the TVs

**Files:**
- Modify: `server/kodiEvents.ts:207-212` (`PlayerEvent` and the message handler)
- Modify: `server/service.ts` (`player`, `stopped`, constructor)
- Test: `tests/plays-service.test.ts` (new), `tests/kodi-events.test.ts`

**Interfaces:**
- Consumes: Task 2's `libraryTitle`, `openPlay`, `closePlay`, `closeLeftOpen`.
- Produces: `PlayerEvent.kind` is `'play' | 'stop' | 'pause' | 'resume'`; the service keeps `private open = new Map<string, { id: number; at: number; pausedAt: number | null; paused: number }>()` per TV.

- [ ] **Step 1: Write the failing tests**

In `tests/kodi-events.test.ts`, following its `Player.OnPlay` test: `Player.OnPause` and `Player.OnResume` reach `onPlayer` as `{ kind: 'pause' }` and `{ kind: 'resume' }`.

In `tests/plays-service.test.ts` (setup as in `tests/upnext-service.test.ts`, film kodi id 11 with runtime 100, episodes 101/102), driving `svc.onPlayer` with `mock.timers` for `Date`:
- `'a film played on a TV is logged for whoever watches, with its minutes without the pause'`: play at 20:00, pause 20:30, resume 20:40, stop ended at 21:30 → one row: `device 'tv1'`, the owner's profile, `minutes = 80`, `finished = 1`, `estimated = 0`.
- `'stopped by hand: not finished'`: play, stop with `ended: false` after 30 min → `minutes = 30, finished = 0`.
- `'a new play on a TV with one still open closes the open one first'`: play 101, then play 102 ten minutes later with no stop → two rows, the first `minutes = 10, finished = 0`; never two rows with `minutes` null on `tv1`.
- `'a play of something not in the library is not logged'`: `{ kind: 'play', item: undefined }` and a movie id not in the library → no rows.
- `'a play left open when the app stopped becomes an estimate when it starts again'`: an open row, then `new Service(db, …)` → the row is `estimated = 1`.

- [ ] **Step 2: Run them to watch them fail**

Run: `node --test tests/plays-service.test.ts tests/kodi-events.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `kodiEvents.ts`: `Player.OnPause` → `{ kind: 'pause' }`, `Player.OnResume` → `{ kind: 'resume' }`.
- `service.ts`, in `player()`: `pause` / `resume` update the TV's open entry (`pausedAt`, `paused`) and return. On `play`: close the TV's open play first (`(now - at - paused) / 60000`, not finished), then, after the owner is decided, `libraryTitle` and `openPlay` for a movie or episode the library knows. In `stopped()`: close it with `finished = ended`, before anything else there. Constructor: `closeLeftOpen(db)`.

- [ ] **Step 4: Run the tests, then the suite**

Run: `node --test tests/plays-service.test.ts tests/kodi-events.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Codex review, commit**

```bash
git add server/kodiEvents.ts server/service.ts tests/plays-service.test.ts tests/kodi-events.test.ts
git commit -m "feat(year): plays on the TVs go into the log, pauses left out"
```

### Task 4: Plays on the phone

**Files:**
- Modify: `server/api.ts:273-300` (the `media` handler's `progress`)
- Test: `tests/plays.test.ts` (an API test, requesting `/api/media/…` the way `tests/media.test.ts` does)

**Interfaces:**
- Consumes: Task 2's `notePhonePlay`.

- [ ] **Step 1: Write the failing test**

`'a film streamed to the phone is a phone play of that profile'`: request a film (and, separately, an episode) as profile 2 with enough bytes to pass `MIN_STREAM` → one `plays` row, `device = 'phone'`, `profile_id = 2`, `episode_id` set for the episode.

- [ ] **Step 2: Run it to watch it fail**

Run: `node --test tests/plays.test.ts`
Expected: FAIL (no row).

- [ ] **Step 3: Implement**

Capture `const begunAt = Date.now()` when the request starts; each `progress` callback also calls `notePhonePlay(db, p, itemId, episodeId, begunAt, Math.min(1, (start + sent) / size), Date.now())` under the same `MIN_STREAM` and `size` checks as `noteStreamed`.

- [ ] **Step 4: Run the tests, then the suite**

Run: `node --test tests/plays.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Codex review, commit**

```bash
git add server/api.ts tests/plays.test.ts
git commit -m "feat(year): plays on the phone go into the log"
```

### Task 5: What the app knew before the log

**Files:**
- Modify: `server/plays.ts`, `server/service.ts` (constructor)
- Test: `tests/plays.test.ts`

**Interfaces:**
- Produces: `export function fillPlays(db): number` (rows added; runs once: the settings-table key `playsFilled`, kept out of the app's settings like `parentsCode` in `server/kids.ts`).

- [ ] **Step 1: Write the failing tests**

- `'Kodi's last plays and the phone's last streams become estimated plays, once'`: for profile 1, `film_states` rows: A watched (`playcount 1`, last played `2026-03-14 21:05:00`), B stopped at 40 % (`resume 0.4`), C only opened (`playcount 0`, no resume); `episode_states` E1 watched; `watching` (phone) for film D at 0.95 on a date. → rows for A (`reached 1, finished 1`), B (`reached 0.4, finished 0`), E1, D (`finished 1`); none for C; all `estimated = 1`, `device` null, `at = kodiTime(last_played)` (phone: `played_at`). A second `fillPlays` → 0.
- `'a title known on both the TV and the phone keeps the one that got further'`: film A at 0.5 on the TV, 0.8 on the phone → one row, `reached 0.8`.
- `'the fill runs when the service starts'`: `new Service(db, …)` on such a database → the rows are there.

- [ ] **Step 2: Run them to watch them fail**

Run: `node --test tests/plays.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `fillPlays`**, with the rules above (`STARTED` and `FINISHED` from `server/watching.ts`; `reached = finished ? 1 : resume or fraction`), and call it in the `Service` constructor.

- [ ] **Step 4: Run the tests, then the suite**

Run: `node --test tests/plays.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Codex review, commit**

```bash
git add server/plays.ts server/service.ts tests/plays.test.ts
git commit -m "feat(year): the log starts with what the app already knew"
```

### Task 6: Plays the app missed

**Files:**
- Modify: `server/owners.ts` (`attributeKodiChanges`), `server/plays.ts`, `server/service.ts:608-611`
- Test: `tests/owners.test.ts`, `tests/plays.test.ts`

**Interfaces:**
- Produces:
  - `export interface KodiChange { profileId: number; itemId: number; episodeId: number | null; lastPlayed: string | null; watched: boolean; resume: number | null }` in `server/owners.ts` (`watched`: Kodi's play count went up).
  - `attributeKodiChanges(db, before, now?): KodiChange[]` (was: the count; callers use `.length`).
  - `export function logKodiChanges(db, changes: KodiChange[]): number` in `server/plays.ts` (rows added).

- [ ] **Step 1: Write the failing tests**

- `tests/owners.test.ts`: the two existing count assertions become `.length`; one more asserts the change given: `{ profileId, itemId, episodeId: null, lastPlayed, watched: true, resume: null }`.
- `'a play the app logged is marked finished when Kodi counts it watched'`: a closed play of film A at 20:00, not finished; a change `{ watched: true, lastPlayed: '…21:40:00' }` → that row `finished = 1`, no new row.
- `'a play the app missed comes in as an estimate'`: no row for A; change watched at `2026-11-02 21:40:00` → one row `estimated 1, reached 1, finished 1, at = kodiTime(lastPlayed)`.
- `'a change that is only a few seconds' start adds nothing'`: change with `watched: false, resume: null` → no row.
- `'a play left open, then reported by Kodi, gets how far Kodi says'`: a left-open row (Task 2), change `resume 0.6` → that row `reached 0.6`.

A logged play "covers" a change when it is the same profile and title with `at` between `kodiTime(lastPlayed) - CLAIM_WINDOW` and `kodiTime(lastPlayed) + 5 min`.

- [ ] **Step 2: Run them to watch them fail**

Run: `node --test tests/owners.test.ts tests/plays.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**, and in `syncKodiOnce` call `logKodiChanges(this.db, attributeKodiChanges(this.db, before))`.

- [ ] **Step 4: Run the tests, then the suite**

Run: `node --test tests/owners.test.ts tests/plays.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Codex review, commit**

```bash
git add server/owners.ts server/plays.ts server/service.ts tests/owners.test.ts tests/plays.test.ts
git commit -m "feat(year): plays the app missed come back from Kodi's sync"
```

### Task 7: The year's numbers

**Files:**
- Create: `server/yearInFilm.ts`
- Test: `tests/year.test.ts` (new)

**Interfaces:**
- Consumes: `plays`, `items`, `titles`, `episodes`; `playMinutes`, `MIN_PLAY_MINUTES` (Task 2).
- Produces:

```ts
export const MIN_WATCHED = 3;
export interface YearTitle { itemId: number; name: string; poster: string | null }
export interface YearInFilm {
  year: number;
  from: number; // 1 January, local
  to: number; // now in the year shown, else 31 December 23:59:59
  films: number; episodes: number; // finished plays (rewatches count)
  hours: number; estimated: boolean; // rounded; any counted play estimated
  titles: number; // films and series watched (each once)
  genres: Array<{ name: string; n: number }>; // top 5 by titles, then name
  actor: { name: string; n: number; tie: string | null; photo: string | null; titles: YearTitle[] } | null; // n >= 2, else null; titles: up to 3
  series: Array<YearTitle & { episodes: number; backdrop: string | null }>; // top 4 by episodes
  hours24: number[]; primeHour: number | null; primeCount: number; plays: number; afterMidnight: number; // afterMidnight: 00:00 to 04:59
  tvs: { since: number; rows: Array<{ name: string; n: number }> } | null; // logged (not estimated) plays only
  oldest: (YearTitle & { year: number }) | null;
  posters: string[]; // up to 18, latest first, one per title
}
export function yearToShow(now: number): number | null; // December: this year; January: last year; else null
export function yearInFilm(db: DB, profileId: number, year: number, now: number, tvNames: Map<string, string>): YearInFilm | null; // null under MIN_WATCHED
```

`name`: `COALESCE(t.title_en, t.original_title, i.parsed_title)` (the phone shows its own language from the library cards; this is the fallback). `poster` and `backdrop` via `img()` from `server/views.ts` (342 and 1280 wide). `tvNames` maps a TV id to its name, `'phone'` to `'On the phone'`. `photo` is filled by Task 8.

- [ ] **Step 1: Write the failing tests** (made-up titles; a fixture helper `play(db, { profile, item, episode?, at, minutes?, reached?, finished?, estimated?, device? })`)

- `'counts: finished films and episodes, rewatches again, plays under 5 minutes nowhere'`: film A finished twice, film B stopped at 40 min, film C 3 min, two episodes finished → `films 2, episodes 2`; hours = round((A + A + 40 + episodes) / 60); C nowhere (not in `plays`, not in `hours24`).
- `'only films and series matched on TMDB count'`: a fitness file played → nowhere.
- `'genres, the actor and the oldest film count each title once'`: genres top 5 sorted by count then name; actor in 2 titles with a tie → `tie` set; an actor in 1 title only → `actor null`.
- `'the series: most episodes first'`.
- `'prime time: the local hour each play started'`: plays at 22:10, 22:50, 23:05, 00:30 local → `primeHour 22, primeCount 2, afterMidnight 1`, `hours24[22] === 2`.
- `'which TV: logged plays only, named, since the first one'`: two on `tv1`, one `phone`, one estimated → rows `[{ 'Living room', 2 }, { 'On the phone', 1 }]`, `since` = the first logged play.
- `'the year a play started is the one it counts in'` (Review Focus 3): 31 Dec 23:30 counts in that year, 1 Jan 00:10 in the next.
- `'a title gone from the NAS still counts'` (Review Focus 4).
- `'too little: null'`: two finished plays → `null`.
- `'estimated plays say so'`: one estimated counted play → `estimated: true`.
- `'the window: December this year, January last year, else nothing'`: `yearToShow` on 15 Nov 2026 → null, 1 Dec 2026 → 2026, 31 Jan 2027 → 2026, 1 Feb 2027 → null.

- [ ] **Step 2: Run them to watch them fail**

Run: `node --test tests/year.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `server/yearInFilm.ts`** with the interface above. Year bounds by local time (`new Date(year, 0, 1)`).

- [ ] **Step 4: Run the tests, then the suite**

Run: `node --test tests/year.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Codex review, commit**

```bash
git add server/yearInFilm.ts tests/year.test.ts
git commit -m "feat(year): the year's numbers from the play log"
```

### Task 8: The year on the API

**Files:**
- Create: `server/yearApi.ts`
- Modify: `server/api.ts` (mount after `upNextRoutes`), `server/tmdb.ts`, `server/kids.ts:125-132`
- Test: `tests/year-api.test.ts` (new), `tests/kids.test.ts`, `tests/tmdb.test.ts`

**Interfaces:**
- Consumes: Task 7's `yearToShow`, `yearInFilm`.
- Produces:
  - `Tmdb.personPhoto(name: string): Promise<string | null>` (`/search/person?query=`, first result's `profile_path` as a full `image.tmdb.org/t/p/w342` URL, else null).
  - `export function yearRoutes(api: Hono, svc: Service, who: (c: Context) => number): void`.
  - `GET /api/year` → `200 YearInFilm & { asked: boolean }`; `404 { error: 'Nothing to show' }` outside the window or under `MIN_WATCHED`. `?year=YYYY` shows that year at any time (a preview, no UI; used for checks).
  - `POST /api/year/asked` → `204`; records `year_asked` for the year shown (or `?year=`).
  - The actor's photo: from `person_photos` when fetched in the last 30 days; else asked of TMDB (no key, or an error: `null`, not stored), stored, and returned through `img()` at 185 wide.

- [ ] **Step 1: Write the failing tests**

- `tests/tmdb.test.ts`: `personPhoto` with the fake fetch answering `/search/person` → the URL; no result → null.
- `tests/year-api.test.ts` (API set up as in `tests/upnext-api.test.ts`; `Date` mocked to 2 Dec 2026):
  - `'the year of the profile asking, and whether it was asked'`: plays for profile 2 → `GET /api/year` with `x-profile: 2` → 200, `films` as set up, `asked: false`; `POST /api/year/asked` → 204; GET again → `asked: true`; profile 1 is still `asked: false`.
  - `'November: nothing yet; ?year= shows it anyway'`: `Date` at 15 Nov → 404; `?year=2026` → 200.
  - `'the actor's photo is asked of TMDB once'`: two GETs → one `/search/person` call; `actor.photo` starts with `/api/img?w=185&u=`.
- `tests/kids.test.ts`: `kidsRoute('GET', '/year')` and `kidsRoute('POST', '/year/asked')` are true.

- [ ] **Step 2: Run them to watch them fail**

Run: `node --test tests/year-api.test.ts tests/kids.test.ts tests/tmdb.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** with the interfaces above; add `/year` and `/year/asked` to `KIDS_ROUTES`.

- [ ] **Step 4: Run the tests, then the suite**

Run: `node --test tests/year-api.test.ts tests/kids.test.ts tests/tmdb.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Codex review, commit**

```bash
git add server/yearApi.ts server/api.ts server/tmdb.ts server/kids.ts tests/year-api.test.ts tests/kids.test.ts tests/tmdb.test.ts
git commit -m "feat(year): /api/year, with the actor's photo, for kids too"
```

### Task 9: The question and the card on Home

**Files:**
- Modify: `web/src/types.ts` (`YearInFilm` as in Task 7, plus `asked`), `web/src/store.ts`
- Create: `web/src/yearInFilm.ts`, `web/src/components/YearInFilm.tsx`
- Modify: `web/src/App.tsx`, `web/src/components/Library.tsx:323`, `web/src/styles.css`
- Test: `tests/year-web.test.ts` (new)

**Interfaces:**
- Produces:
  - `web/src/store.ts`: `export const yearStore = createStore<YearInFilm | null>(null); export function loadYear(): Promise<void>` (on start and when the profile changes; 404 → null).
  - `web/src/yearInFilm.ts`: `export function storyCards(y: YearInFilm): CardKey[]` with `type CardKey = 'open' | 'count' | 'hours' | 'genres' | 'actor' | 'series' | 'prime' | 'tvs' | 'summary'` (a card without data left out; `open` and `summary` always); `export function hourLabel(h: number): string` (`22 → '10 PM'`, `0 → 'Midnight'`, `12 → 'Noon'`); `export function daysLine(hours: number): string | null` (`76 → 'More than three days'`, `30 → 'More than a day'`, under 24 → null); `export function teaser(y: YearInFilm): string` (`'N films, N episodes and one actor you kept coming back to'`, the actor part only when there is one); `export function coveredLine(y: YearInFilm, now: number): string | null` (`'1 January to 29 October'` while the year runs, null once over).
  - `web/src/components/YearInFilm.tsx`: `YearQuestion` (a sheet over Home: "<Profile> · 2026", "Your year in film is ready", the teaser, **See my year** (navigates to `/year`), **Later**, small print "Later keeps it on Home until 31 January."; any answer or closing posts `/api/year/asked` and updates the store), `YearCard` (the slim Home card: "2026 · Your year in film · Ready until 31 January", opens `/year`).

- [ ] **Step 1: Write the failing tests** for `storyCards`, `hourLabel`, `daysLine`, `teaser`, `coveredLine` with the values above (`storyCards` of a year without actor, series and logged plays → `['open', 'count', 'hours', 'genres', 'prime', 'summary']`).

- [ ] **Step 2: Run them to watch them fail**

Run: `node --test tests/year-web.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the helpers, the store, `YearQuestion` (shown by `App` over Home when `yearStore` has a year with `asked: false`, the profile picked and no title page open) and `YearCard` (in `Library` above `ContinueShelf`, when the year is there and no search or filter is on). Kids mode shows both too.

- [ ] **Step 4: Run the tests, the suite, the type check, the build**

Run: `node --test tests/year-web.test.ts && npm test && npm run typecheck && npm run build`
Expected: PASS, build OK.

- [ ] **Step 5: Codex review, commit**

```bash
git add web/src tests/year-web.test.ts
git commit -m "feat(year): the question and the card on Home"
```

### Task 10: The story

**Files:**
- Modify: `web/src/components/YearInFilm.tsx`, `web/src/App.tsx`, `web/src/styles.css`

**Interfaces:**
- Consumes: Task 9's `storyCards`, `hourLabel`, `daysLine`, `coveredLine`, `yearStore`; library cards (`library` store, `displayTitle` with the device's `titleLang`) to name each `itemId`, else the server's `name`.
- Produces: `YearStory` on the route `/year` (full screen over everything, no tab bar).

The look and motion are the mockups' (the private canvas the owner approved): petrol night `--nuit`, screen-white `--ecran`, projector-bulb gold `--lampe`, Big Shoulders Display (`--font-display`) for the large type. Per card, in `storyCards` order:

- **open**: profile badge, the year (very large, gold), "Your year in film", `coveredLine`; three columns of `posters` drifting up and down behind a dark fade.
- **count**: a 4 × 3 wall of posters popping in one after another; "You watched", `films` counting up, "films", then "and N episodes."
- **hours**: `hours` counting up ("about" before it when `estimated`), "hours", `daysLine`; a film strip of posters running underneath.
- **genres**: "Mostly", the top genre (very large, gold), "N of the T films and series you watched.", five bars growing one after another (the first gold).
- **actor**: their `titles`' posters fanning out, the `photo` in a circle (initials when null), "You kept coming back to", the name, "N films" (or "N titles" when a series is among them), "Tied with X." when `tie`.
- **series**: the top series' `backdrop` slowly zooming, the episode count counting up, "episodes of", the name, then the next three with their counts.
- **prime**: "Prime time", `hourLabel(primeHour)`, "N of your P films and episodes started between X and Y.", "N after midnight." when any, a 24-bar chart growing bar by bar, `primeHour` gold, labels midnight / 6 am / noon / 6 pm.
- **tvs**: "Where you watched", a bar per row of `tvs.rows`, "Since <date>" when `since` is after `from`.
- **summary**: a card with films, episodes, hours, prime time, top genre, top series, the actor, the oldest film; **Watch again** (back to the first card) and **Done** (back to Home).

Behaviour: a progress bar per card at the top; each card moves on after 6 s; tap the right two thirds to go on, the left third to go back; a close button top right (44 × 44, `aria-label="Close"`); counting numbers over 1.5 s. `@media (prefers-reduced-motion: reduce)`: no drifting, strip or zoom, cards fade in place, numbers shown at once. Real `<button>`s for the tap areas (`aria-label` "Previous", "Next").

- [ ] **Step 1: Build `YearStory`** and its route in `App` (`/year`; Escape and the back button close it).

- [ ] **Step 2: Type check and build**

Run: `npm run typecheck && npm run build`
Expected: OK.

- [ ] **Step 3: Check it in a browser** with a sandbox copy of the database and `GET /api/year?year=2026` (the story reads `?year=` from its own URL and passes it on): every card shows with the copy's numbers, tapping both ways works, close and Done return to Home, phone width (390 px) without sideways scrolling, and reduced motion (DevTools rendering emulation) fades instead of moving.

- [ ] **Step 4: Codex review, commit**

```bash
git add web/src
git commit -m "feat(year): the story, card by card"
```

### Task 11: The roadmap

**Files:**
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1:** Item 7's row: `Done: [design](superpowers/specs/2026-10-30-year-in-film-design.md)`; its section gets a "Done:" paragraph in the roadmap's voice: the log of plays since <the day it shipped>, the question from 1 December, the card until 31 January, the story's cards, and that it needs the app running (see item 9).

- [ ] **Step 2: Commit**

```bash
git add docs/ROADMAP.md
git commit -m "docs(roadmap): your year in film, done"
```
