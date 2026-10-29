# Series tracker and Coming soon: design

Status: built on 2026-10-29. The owner asked for roadmap items 3 and 6 and
skipped the questions ("go ahead"), so every call below is the designer's,
listed at the end for the owner to check.

## Why

The NAS holds about 25 shows in its SERIES folders. Nothing tells the owner
that a show they keep has a season they don't have yet, that two episodes in
the middle of a season never arrived, or that a show they follow comes back
next month. Films have "Films to get" and "Sets with missing films"; series
have nothing.

Two things, built in this order:

1. **Series tracker**: for each show the owner follows, compare the episodes
   on the NAS with TMDB and say what is missing ("S03E06–E08",
   "Season 2, 10 episodes"). Everything missing makes a list of episodes to
   get, next to "Films to get".
2. **Coming soon**: a row on the library home of what comes out next: new
   seasons of followed shows, sequels to films on the NAS, films coming to
   cinemas, and films the owner asked to be reminded of. A reminded film
   joins "Films to get" on the day it is out.

Coming soon reuses the tracker's TMDB data for new seasons, so the tracker
comes first.

## What the user sees

### A series page

A show matched on TMDB gets a short "Series tracker" block above its
episodes:

- **Follow**: a switch, "Following" / "Follow this series". It is on by
  default for a show with a copy in a SERIES folder and off for the rest
  (anime, kids, shows, films folders). The owner can change it on any
  matched show. One choice for the household, like "Want it" on films.
- **What's missing**, for a followed show: "Up to date", or each season with
  something missing: "Season 2: all 10 episodes", "Season 3: E06–E08",
  "Season 1: E03, E07–E08".
- **What's next**, when TMDB knows it: "Season 4 starts 8 Jul 2027",
  "Next episode S03E05 on 2 Nov", "Season 3 announced" (no date yet),
  or "Ended" / "Cancelled".
- **Files not counted**: when some files of the show have no episode number,
  "3 files have no episode number, so they weren't counted."

A show not followed shows only the switch. Kids mode shows none of this.

### Episodes to get (Settings › Lists)

A new list next to "Films to get", opened the same way (full page, back
returns to Settings):

- One entry per followed show that misses an aired episode: its title
  (opens the series page), then what's missing per season as on the series
  page, and when the latest missing episode aired.
- Newest first: the show whose latest missing episode aired most recently
  is at the top.
- Summary line: "4 of 25 series you follow miss episodes." While TMDB data
  is being fetched: "Checking series with TMDB: 12 of 25…", and the page
  asks again until done (like "Sets with missing films").
- An episode leaves the list once its file is on the NAS (the next scan).
- Without a TMDB key: "Add a TMDB key in Settings to check your series."

### Coming soon (library home)

A new row, "Coming soon", after "At the cinema". Same rules as the other
rows:

- It is hidden while searching or filtering.
- Kids mode never shows it.
- Settings › Library gets a "Coming soon" chip to show or hide it on this
  device (default on).
- "See all" opens its page (`/row/soon`).

Entries, soonest first, then the ones with no date:

| Source | Tile says | Tap opens |
|---|---|---|
| A followed show's next season (TMDB's next episode is an episode 1, or a later season has a future date) | "Season 4 · 8 Jul 2027" | the series page |
| A followed show's announced season with no date | "Season 3 · no date yet" | the series page |
| A film not out yet in a set with a film on the NAS | "Next in Dune · 18 Dec 2026", or "· no date yet" | the film page |
| A film coming to cinemas in the cinema country (today's "upcoming" list) | "In cinemas 5 Dec" | the film page |
| A film the owner asked to be reminded of, not out yet | "Reminder · 12 Mar 2027" | the film page |

Each film shows once. When several sources have it, the tile names the set
first, then the cinema date, then the reminder. A reminded film also gets a
small bell on its tile.

"At the cinema" then shows only the films on now: what is coming moves to
Coming soon.

### Reminders on films

- On the page of a film that isn't out yet (no release date, or a date after
  today), the "Want it" button reads **"Remind me"** / **"Reminder set"**.
  It is the same choice as "Want it": once the film is out it simply is a
  film you want. The toast says "You'll find it in Films to get once it's out."
- **Films to get** lists the films that are out. Films not out yet move to a
  second section, **"Reminders"**, with their date ("Out on 12 Mar 2027",
  "No date yet"). On its release day a film moves up into the list.
- "Not interested" hides a film from Coming soon too.
- Series need no reminder: following a show is the reminder. Its new
  episodes show in Episodes to get once they air.

## How it works

### TMDB data for a show

One TMDB call per show, `/tv/{id}`, gives everything needed (checked on
2026-10-29 against every show on the NAS):

- `seasons[]`: `season_number`, `episode_count`, `air_date`. Season 0 is
  specials, and a future season may be listed with no date or 0 episodes.
- `last_episode_to_air` and `next_episode_to_air`: season, episode,
  air date.
- `status`: "Returning Series", "Ended", "Canceled", "In Production".

The app keeps this per show in its database and fetches it again when it is
more than a day old **and** something asks for it: the Episodes to get page,
the Coming soon row, or a series page. The first time, the shows are fetched
in the background (about 25–55 calls at the TMDB client's usual pace) and
the asking page shows what is there so far. No new timer, job or service.

### Which episodes are on the NAS

For a show, the episodes on the NAS are the present episode files of every
present library item matched to that TMDB show. A show can be split over
several folders.

- Season and episode come from the file name, or the season folder, as the
  scanner already reads them.
- A file named for several episodes counts for each one. Accepted forms:
  `S01E09E10`, `S01E09-E10`, `S01E09-10`. Today the parser reads none of
  them, so a two-episode file looks like a missing pair.
- Season 0 (specials, extras folders) never counts and is never "missing".
- Files with no episode number count only toward the "not counted" note.
- An episode TMDB doesn't list (different numbering) is ignored. It isn't
  reported as extra.

### Which episodes have aired

From TMDB's seasons, except 0:

- every episode of a season before the season of `last_episode_to_air`;
- in that season, episodes 1 to its episode number;
- nothing after it.

Missing = aired − on the NAS. A season missing every aired episode reads
"Season 2: all 10 episodes". Otherwise the missing numbers become ranges,
"E03, E07–E08".

### Sequels

The sets (TMDB collections) with a film on the NAS, hidden ones aside, are
the ones "Sets with missing films" already uses. Their film lists are
already kept a week. Coming soon fetches the lists it lacks in the
background, as the Sets list does.

A part counts as a sequel when it is not on the NAS, not "Not interested",
and not out yet: no date, or a date after today.

### Cinema

The existing "upcoming" list for the cinema country, kept 6 hours, minus
films on the NAS and "Not interested" ones. "At the cinema" keeps the
"now playing" half.

## Goals

- The owner sees in one place which episodes of their series to get.
- A series page says at a glance whether the show is complete on the NAS.
- The owner learns about a new season or a sequel before it comes out,
  without looking it up.
- A film not out yet can be "remembered" without cluttering Films to get.

## Non-goals

- Episode titles or plots for missing episodes. That would need one more
  TMDB call per season.
- Shows whose files are numbered without seasons ("Dragon Ball 113"), or
  whose numbering differs from TMDB's. They aren't followed by default and
  show the "not counted" note.
- Reading episode numbers from Kodi's library. A possible later
  improvement for files the parser can't read.
- Notifications. Nothing is pushed to phones.
- Per-profile follows or reminders. Picks are household-wide today.
- Specials (season 0).
- New films by directors or actors the owner likes.

## Anti-goals (would make this a failure even if it works)

- Any link to where an episode or film could be downloaded. The lists say
  what is missing, never where to get it.
- A list buried in noise: hundreds of kids' or anime episodes nobody wants.
  This is why following starts with the SERIES folders only.
- Writing to the NAS, the Google Sheet or Kodi. This feature only reads.
- A new background service, scheduled job or container. Everything runs
  inside the app, on request.
- Personal data in the public repo: no show titles from the owner's
  library, no country.

## Constraints (facts measured on 2026-10-29)

- **Library size:** 60 TV items on the NAS, 57 matched to TMDB (53
  distinct shows). 25 of them are in SERIES folders; the rest are anime (13),
  kids (15), shows (3) and films folders (4).
- **Dry run over every matched show:**
  - SERIES shows: 4 of 25 miss aired episodes: a whole season (twice), and
    a few episodes at the end of a season. One of the 4 is a false alarm,
    caused by a `S01E09E10` file the parser can't read.
  - Anime and kids shows: mostly noise. For example "418 missing" for a show
    with 7 files on the NAS, or every episode missing because files are
    numbered 1–153 without seasons.
- **Episode numbers:**
  - 1,070 of 2,146 episode files have no season and 1,079 no episode
    number. Nearly all are in anime and kids folders.
  - The parser's `SxxEyy` pattern needs a word boundary after the episode
    number, so `S01E09E10` gives no episode.
- **TMDB `/tv/{id}`:** has `seasons`, `last_episode_to_air`,
  `next_episode_to_air` and `status` for all 53 shows. Future seasons
  appear with no date and 0 episodes for some.
- **Existing behaviour:**
  - Set film lists are cached a week in `collections`.
  - The cinema lists are cached 6 hours in memory.
  - "Want it" / "Not interested" are household-wide (`picks`).
- **Kids mode:** the server lets a kids profile reach only an allowlist of
  routes (`KIDS_ROUTES`), so new routes are closed to kids without
  changes.

## Calls made by the designer (not discussed with the owner)

- **Follow by default:** only shows with a copy in a SERIES folder. Others
  are one tap away on their page. This follows from the dry run.
- **The list is automatic:** "Episodes to get" is every missing aired
  episode of followed shows. There is no per-episode "Want it": following
  is the choice.
- **Names:**
  - The list is called "Episodes to get", next to "Films to get".
  - The row is "Coming soon"; its page is `/row/soon`.
- **Cinema dates move:** "At the cinema" loses its "coming" films to Coming
  soon, so the same film isn't in two rows.
- **Reminders are "Want it":** a reminder is the existing "Want it" pick on a
  film not out yet, under another label. Films to get splits into out /
  "Reminders", so nothing the owner already wanted disappears.
- **Freshness:**
  - Show data is refreshed when more than a day old, on request.
  - Set lists stay weekly, as today.
- **Multi-episode file names** are read by the tracker. Whether the scanner's
  parser itself learns them is left to the builder (see below).

## Left to the builder

- **Storage:** table and column names for the show data and the follow
  choices, and whether follows are stored only when they differ from the
  default.
- **API:** route names and payload shapes. New routes stay outside the kids
  allowlist.
- **Multi-episode names:** either teach `parseName` an episode range, or read
  ranges in the tracker from the file name. They must not change how
  existing files are matched or listed.
- **Ties:** exact copy and date formats, and sort order between entries on
  the same day. Use the app's existing `formatDay` style.
- **Which home views show Coming soon:** All only, or also the Films and
  Series chips.
- **Refresh hand-off:** how the home row picks up data that finished
  fetching in the background, e.g. asking once more after a few seconds, or
  on the next library change.
