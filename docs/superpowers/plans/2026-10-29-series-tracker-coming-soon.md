# Series tracker and Coming soon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Followed shows say which aired episodes are missing from the NAS (and list them in "Episodes to get"); a "Coming soon" row shows new seasons, sequels, cinema releases and film reminders.

**Architecture:** One new server module per feature: `server/series.ts` (TMDB show data cache, follows, missing episodes) and `server/soon.ts` (Coming soon entries from cached data). New routes in `server/api.ts` fill stale TMDB data in the background, single-flight, like `/reports/sets`. Web: a block on the series page, a report page, a home row; labels in `web/src/series.ts`.

**Tech Stack:** Node ≥24 strip-only TypeScript, Hono, node:sqlite, node:test; React 19 + Vite + wouter.

**Spec:** docs/superpowers/specs/2026-10-29-series-tracker-coming-soon-design.md

## Global Constraints

- Strip-only TypeScript: no enums, no parameter properties.
- Read only: nothing writes to the NAS, the Google Sheet or Kodi.
- No new timer, job or service: TMDB data is fetched when a route asks and it is stale.
- New routes stay out of `KIDS_ROUTES`. Kids mode shows no tracker block and no Coming soon row.
- Never a link to where an episode or film could be downloaded.
- No personal data in code, tests or docs: no show titles from the owner's library, no country.
- Codex review (`codex-companion.mjs review --wait --scope working-tree`, sandbox off) before each commit; no push.

## Review Focus

- **Two-episode files.** A file named `S01E09E10` (the parser gives no episode number) must count as E09 and E10, not as a missing pair.
- **Several folders per show.** A show split over items (one folder per season) must be counted as one show. Episodes of absent items don't count.
- **Odd seasons on TMDB.** A future season with no date or 0 episodes, and season 0, are never "missing".
- **TMDB down or no key.** Cached data keeps being served; with nothing cached, the pages say so instead of erroring.
- **A film in several sources.** The same film coming from a set, the cinema list and a reminder shows once, with the set label first.

---

### Task 1: Episodes a file holds

**Files:** Create `server/series.ts`; Test `tests/series.test.ts`

**Produces:** `fileEpisodes(path: string, season: number | null, episode: number | null): Array<[number, number]>`

- [ ] **Step 1: failing tests** `fileEpisodes`:
  - `('S/Show S01E09E10 Title.mkv', 1, null)` → `[[1,9],[1,10]]`
  - `'S01E09-E10'` → E09, E10; `'S01E09-10'` → E09, E10; `'s02e03e04e05'` → `[[2,3],[2,4],[2,5]]`
  - `('…S01E01-2010.mkv', 1, 1)` → `[[1,1]]` (a year is not a range)
  - `('x.mkv', 2, 7)` → `[[2,7]]`
  - `('x.mkv', 0, 3)` → `[]`; `('x.mkv', null, 3)` → `[]`; `('x.mkv', 1, null)` → `[]`
- [ ] **Step 2:** `node --test tests/series.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: implement.** Read the basename with `/s(\d{1,2})[ ._-]?e(\d{1,3})((?:[ ._-]?e\d{1,3})+|-e?\d{1,3})(?!\d)/i`. A range must go up (`to > from`) and span fewer than 10 episodes. Otherwise use `season`/`episode`. Season 0 or null gives `[]`.
- [ ] **Step 4:** run tests. Expected: PASS.

### Task 2: TMDB show data, kept a day

**Files:** Modify `server/tmdb.ts`, `server/db.ts` (migration 13), `server/series.ts`; Test `tests/series.test.ts`, `tests/tmdb.test.ts`

**Produces:**
- `Tmdb.showSeasons(id: number): Promise<ShowData>`.
- `ShowData = { status: string; seasons: Array<{ n: number; count: number; date: string | null }>; last: Ep | null; next: Ep | null }`, with `Ep = { s: number; e: number; date: string | null }`.
- `showData(db, tmdb: Tmdb | null, id, now = Date.now()): Promise<ShowData | null>`.
- `staleShows(db, ids: number[], now): number[]`.

Migration 13:

```sql
-- Series tracker: TMDB's seasons, last and next episode of each show, kept a day.
CREATE TABLE shows (tmdb_id INTEGER PRIMARY KEY, data TEXT NOT NULL, fetched_at INTEGER NOT NULL);
-- The owner's choice to follow a show or not, when it differs from the default (a copy in a SERIES folder).
CREATE TABLE follows (tmdb_id INTEGER PRIMARY KEY, follow INTEGER NOT NULL, at INTEGER NOT NULL);
```

- [ ] **Step 1: failing tests.**
  - **`showSeasons`**, with a fake fetch of `/3/tv/5`:
    - It maps `seasons[]` (`season_number`, `episode_count`, `air_date` with `''`/missing → `null`), `last_episode_to_air`, `next_episode_to_air` (null stays null) and `status`.
    - It asks once with `language=en-US`.
  - **`showData`:**
    - The first call fetches and stores.
    - A second call within 24 h makes no request.
    - After 24 h it fetches again.
    - When TMDB answers 503 with a row kept, it returns the kept row.
    - With `tmdb` null it returns the kept row, else `null`.
  - **`staleShows`** returns the ids never fetched or older than 24 h.
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3: implement.**
  - `showSeasons` uses `this.get('/tv/{id}', { language: 'en-US' })`.
  - `showData` mirrors `filmDetails`: one in-flight promise per id, and the stale row is used on error.
- [ ] **Step 4:** run `npm test`. Expected: all PASS, migration applies on `:memory:`.

### Task 3: Follows and what's missing

**Files:** Modify `server/series.ts`; Test `tests/series.test.ts`

**Produces:**
- `followed(db): Map<number, boolean>`: every TMDB show with a present matched TV item. Default `true` when one of its present items has `category = 'series'`; a `follows` row overrides it.
- `setFollow(db, id, follow: boolean, now)`: stores a row only when it differs from the default, and deletes it otherwise.
- `seriesStatus(db, id, data: ShowData, today: string): SeriesStatus`, where:
  - `SeriesStatus = { missing: SeasonGap[]; latest: string | null; next: NextUp | null; ended: boolean; unnumbered: number }`
  - `SeasonGap = { season: number; aired: number; missing: number[] }`
  - `NextUp = { kind: 'season'; season: number; date: string | null } | { kind: 'episode'; s: number; e: number; date: string }`
- `episodesToGet(db, now): Array<{ tmdbId: number; itemId: number; status: SeriesStatus }>`.

- [ ] **Step 1: failing tests.** Seed TV items and episodes with the same SQL shape as `tests/films.test.ts`.
  - **`followed`:**
    - A SERIES item gives `true`; a KIDS item gives `false`.
    - A show with one SERIES and one MOVIES item gives `true`.
    - `setFollow(id, false)` makes it `false`; `setFollow(id, true)` on a SERIES show deletes the row.
    - Absent items don't count.
  - **`seriesStatus` aired logic.** With seasons `0:5, 1:10, 2:8, 3:8(no date)` and last S2E6:
    - aired = S1 E1–10 and S2 E1–6;
    - season 0 and season 3 are never missing.
  - **`seriesStatus` on-NAS logic:**
    - Episodes of two items with the same `tmdb_id` both count.
    - A `S01E09E10` file covers E09 and E10.
    - An item with `present = 0`, or an episode with `present = 0`, doesn't count.
    - A season-1 file with no episode number adds 1 to `unnumbered`; season 0 files don't.
  - **`seriesStatus` `latest`:**
    - Missing S2E6, the last aired episode → `last.date`.
    - Missing only S1E3 → season 1's date.
  - **`seriesStatus` `next`:**
    - `next` S4E1 → `{kind:'season', season:4, date}`.
    - `next` S3E5 → `{kind:'episode'}`.
    - No `next`, a season 3 after `last` with no date → `{kind:'season', season:3, date:null}`.
    - No `next`, no later season → `null`.
  - **`seriesStatus` `ended`:** `true` for "Ended" and "Canceled".
  - **`episodesToGet`:**
    - Only followed shows with something missing and cached data.
    - Order: `latest` newest first, nulls last.
    - `itemId` = its present item with the most episodes.
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3: implement.**
  - On the NAS: one SQL over `episodes JOIN items` (present, `media_type = 'tv'`, `tmdb_id = ?`) into `fileEpisodes`.
  - `episodesToGet` reads `shows` rows only (no fetch).
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Codex review** (working tree). Fix real findings test-first, then commit: `feat(series): which episodes of a followed show are missing`.

### Task 4: Coming soon entries

**Files:** Create `server/soon.ts`; Test `tests/soon.test.ts`

**Consumes:** `followed`, `showData` rows (cached), `seriesStatus().next`, `ownedSetKeys` + the `collections` cache, `cinema()`, `filmDetails` (cached), `picks`.

**Produces:** `comingSoon(db, tmdb: Tmdb | null, country: string, now = Date.now(), cache?: CinemaCache): Promise<SoonEntry[]>`, where:

```ts
type SoonEntry =
  | { kind: 'season'; tmdbId: number; itemId: number; season: number; date: string | null }
  | { kind: 'film'; film: Film; date: string | null; set: string | null; cinema: boolean; reminder: boolean };
```

- [ ] **Step 1: failing tests.**
  - **Seasons:** a followed show with a cached `next` S4E1 gives one season entry. An unfollowed one gives none.
  - **Sequels:**
    - A set with an owned film gives entries for its parts not on the NAS that are dated after today or undated.
    - A released part, a `skip` part and an owned part are left out.
  - **Cinema:** upcoming films from the fake `upcoming` list are in, flagged `cinema: true`. Now-playing ones are not.
  - **Reminders:** a `want` pick whose cached details date is after today, or empty, is in with `reminder: true`. A released `want` is not.
  - **One entry per film:** a film that is a sequel, upcoming in cinemas and reminded gives one entry with `set`, `cinema: true` and `reminder: true`.
  - **Order:** by date ascending, undated last, ties by title.
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3: implement.**
  - Read set parts from `collections` (no fetch).
  - `cinema()` already filters NAS and skip; keep its `soon` half.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Codex review**, then commit: `feat(soon): what comes out next, from cached TMDB data`.

### Task 5: API

**Files:** Modify `server/api.ts`; Test `tests/series-api.test.ts` (same harness as `tests/live-api.test.ts`)

**Produces:**
- `GET /series/:tmdbId` → `{ follow: boolean; status: SeriesStatus | null; tmdb: boolean }`. It awaits `showData` for this one show; TMDB failing with nothing kept gives `status: null`.
- `PUT /series/:tmdbId/follow` with `{ follow: boolean }` → `{ follow }`. A body that isn't boolean gives 400; a show not in the library gives 404.
- `GET /reports/episodes` → `{ shows: Array<{tmdbId, itemId, status}>; total; checked; running; tmdb }`. It starts a background fill of `staleShows` for followed shows (single-flight, `pool(…, 4)`).
- `GET /soon` → `{ entries: SoonEntry[]; running: boolean }`:
  - Posters go through `img(…, 342)`; a season entry's poster is its item card's.
  - It starts the shows fill and the sets fill. The sets fill is factored out of `/reports/sets` and shared.

- [ ] **Step 1: failing tests.**
  - The follow round trip, with the default shown before and after.
  - A follow body that isn't boolean gives 400.
  - `/reports/episodes` reports `running` and then the show once the fill resolves; the fake TMDB is counted.
  - A kids profile gets 403 on all four routes.
  - `/soon` with no TMDB key → `entries` from cache only, no throw.
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4:** `npm test` + `npm run typecheck` → PASS.
- [ ] **Step 5: Codex review**, then commit: `feat(series): API for the tracker, Episodes to get and Coming soon`.

### Task 6: Web labels

**Files:** Create `web/src/series.ts`; Modify `web/src/types.ts`; Test `tests/series-web.test.ts`

**Produces:**
- `gapLabel(g: SeasonGap): string`:
  - All aired episodes missing → `"Season 2: all 10 episodes"` (`"Season 2: 1 episode"` for one).
  - Otherwise ranges: `"Season 1: E03, E07–E08"`.
- `nextLabel(n: NextUp, today: string): string`:
  - `"Season 4 starts 8 Jul 2027"`, or `"Season 3 announced"` when undated.
  - `"Next episode S03E05 on 2 Nov"`.
  - Dates use `formatDay`.
- `soonWhy(e: SoonEntry): string`:
  - `"Season 4 · 8 Jul 2027"` / `"Season 3 · no date yet"`.
  - `"Next in Dune · 18 Dec 2026"` (`setName`).
  - `"In cinemas 5 Dec"`.
  - `"Reminder · 12 Mar 2027"`.
  - Undated: `"… · no date yet"`.

- [ ] **Step 1: failing tests** for each example above, plus `E01–E03` for consecutive numbers and an unsorted input.
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4:** `npm test` → PASS.

### Task 7: Series page block and Episodes to get

**Files:** Modify `web/src/components/Detail.tsx`, `web/src/components/Reports.tsx`, `web/src/components/Settings.tsx`

- [ ] **Series page.** In `Detail.tsx`, a `SeriesTracker` block above `Episodes` when `mediaType === 'tv' && tmdbId` and not kids. It fetches `/api/series/:tmdbId`.
  - The follow switch (`aria-pressed`) does an optimistic PUT and rolls back with a toast on error.
  - It shows `gapLabel` lines or "Up to date", `nextLabel`, "Ended"/"Cancelled", and the "not counted" note.
- [ ] **Episodes to get page.** `EpisodesReport` in `Reports.tsx`, modelled on `SetsReport`:
  - It polls while `running`.
  - Summary copy from the spec.
  - Each entry has a title button (`openTitle(itemId)`), `gapLabel` lines and "Latest aired {formatDay}".
- [ ] **Settings.** An "Episodes to get" button in Lists, and route `report === 'episodes'`.
- [ ] **Verify:** `npm run typecheck`, `npm run build`, `npm test`. In the browser (sandbox server, TVs pointed at 127.0.0.1:9), check:
  - the block on a SERIES show and on a kids show;
  - toggling follow;
  - the report page, while running and once filled.
- [ ] **Codex review** (tasks 6–7), then commit: `feat(series): tracker on the series page and the Episodes to get list`.

### Task 8: Coming soon row, reminders, Films to get

**Files:** Modify `web/src/rows.ts`, `web/src/store.ts`, `web/src/components/Library.tsx`, `web/src/components/Settings.tsx`, `web/src/components/Film.tsx`, `web/src/components/Reports.tsx`

- [ ] **Row registration.**
  - `RowKey` gains `'soon'`, with `ROW_TITLES.soon = 'Coming soon'`. Not in `KIDS_ROWS`.
  - `prefs.showSoon`, default `true`, gets a chip in Settings › Library.
- [ ] **Library.**
  - It loads `/api/soon` with the other rows. If `running`, it asks once more after 5 s.
  - `SoonShelf` sits after the cinema row, on the All view only, with no search and no filter.
  - Season tiles use the series card's poster and open `openTitle(itemId)`. Film tiles open `openFilm`, with a bell for `reminder`. The labels are `soonWhy`.
  - The row page `/row/soon` lists every entry.
- [ ] **At the cinema** keeps only `!soon` films.
- [ ] **Film page.** When the film is not out (`!date || date > today`), the want button reads "Remind me" / "Reminder set", with the toast from the spec.
- [ ] **Films to get.** `WantedReport` splits into out films and a "Reminders" section ("Out on …" / "No date yet").
- [ ] **Verify.** Typecheck, build and tests. In the browser, check:
  - the row with real cached data;
  - the row page;
  - the chip;
  - a reminder on a future film moving into Reminders.
- [ ] **Codex review**, then commit: `feat(soon): Coming soon row and film reminders`.

### Task 9: Docs

**Files:** Modify `docs/ROADMAP.md`, the spec's Status line

- [ ] **Roadmap.** Items 3 and 6 become "Done", linking the spec. Add Live TV as done, linking its spec, with a short section like the others.
- [ ] **Spec status.** It becomes "built on 2026-10-29".
- [ ] **Commit:** `docs: series tracker and Coming soon are done`.
