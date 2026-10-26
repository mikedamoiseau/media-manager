# Kids mode: design

Status: agreed with the owner on 2026-10-26, ready to plan.

## Why

A parent hands their phone to their 10-year-old so the child can pick
something to watch on the living-room TV. Today the phone shows the whole
library (2,000+ films, many for adults), every setting, the TV power menu
and a full remote. Kids mode turns a profile into a safe, simple version of
the app: only titles fit for that child, one tap to play on the TV, the
controls a child actually needs, and a bedtime.

When a parent browses on the TV with the Kodi remote (or the app's Remote
tab) for the kids, nothing changes: the parent is the one choosing.

## What the user sees

### Making a kids profile

- In Settings › Profiles, a profile can be switched to **Kids profile**.
  The main profile can't.
- A kids profile has its own age limit, picked on Germany's FSK steps
  (0, 6, 12, 16). For the owner's 10-year-old: **FSK 12**.
- A kids profile has an optional **bedtime** (a time of day, off by default).
- A kids profile keeps everything a profile has today: its own Continue
  watching, likes and suggestions. Its plays never touch a parent's.
- The household has one **parents' code** (4 digits), set the first time a
  kids profile is made. It can be changed in Settings from any device that
  is not in kids mode; that is also the way out when it's forgotten.

### Entering and leaving

- Entering is free: picking the kid's tile on "Who's watching?" (or with
  the badge) puts the phone in kids mode. No code.
- Leaving asks for the parents' code: switching to another profile from the
  badge or from "Who's watching?". The kids don't know the code.
- Kids mode stays on through closing and reopening the app, like any
  profile choice on that device.

### What a kid can browse

- The library, its search and its filters, showing only titles allowed for
  this kid (see "Which titles a kid sees").
- Title pages of those titles, with **Play on TV** (and the episode list for
  series).
- Their own Continue watching and suggestions, both limited to allowed
  titles.
- Nothing else leads out: no actor or director pages, sets, "elsewhere",
  cinema or "Films to get" rows that could reach other titles.

### What a kid can do while something plays

- The full remote is replaced by a simple **now playing** card with big
  buttons: pause/resume, stop, volume, audio language, subtitles.
- The card shows and controls what is playing on that TV when it is a title
  allowed for this kid, whoever started it (a cartoon a parent put on can be
  paused for a bathroom break). Anything else playing there: the card only
  says something else is playing, without its title or poster, and offers
  no buttons.
- No arrow pad, Home/Back, keyboard, skipping forward/back, TV power, or
  choice of TV. The TV is the one the phone was set to when kids mode
  started.

### What is hidden in kids mode

- Settings, To review, the full Remote tab, TV power and the TV switcher.
- Play in VLC, trailers, matching and poster pickers, hiding titles, and the
  parents' "OK for kids / Not for kids" control.

### Bedtime

- After the kid's bedtime, nothing new can start from kids mode: the app
  shows that it's bedtime instead of Play on TV.
- A film or episode already playing finishes. When it ends, Kodi does not go
  on with the next episode: if Kodi starts one by itself, the app stops it.
- Bedtime lasts until 6:00 the next morning.
- Only kids plays are concerned: a parent starting something (from the app
  outside kids mode, or with the TV remote) is never stopped.

### Parents: OK for kids / Not for kids

- On any title page, outside kids mode, a parent can set the title to
  **OK for kids**, **Not for kids** or back to **Automatic**. This beats the
  rule below, for every kids profile.
- These are for the gaps the rule gets wrong: a rated-6 film that would
  upset a child (*Grave of the Fireflies*), a teen anime that slips under
  FSK 12, an unrated cartoon outside KIDS.

### Part 2: the same list on the TV

The owner wants the kids to be able to use the TV's own remote too, on a
kids view of the TV that shows only their titles.

- The app keeps a **Kids** tag in Kodi's shared library on every film and
  series allowed for the kid (one write reaches both TVs). It adds and
  removes only that tag and never touches anything else on a title.
- The tag follows the list: when the rule, an override, the age limit or
  the files change, and again at each sync with Kodi (a title Kodi
  re-scraped may have lost it).
- The kids view on the TV (its home built from the tag, and the code to
  leave it) belongs to the Lumen skin, built in the Kodi skin session.
  The app's side is only the tag.
- Prerequisite: the titles must be in Kodi's library. Today only 11 of
  the 311 KIDS files and 9 of the 82 ANIMES files are (KIDS and ANIMES
  look set to TV shows, so their loose film files were never scanned).
  The Kodi skin session was asked on 2026-10-26 to check and fix this.
- With more than one kids profile, the tag would need to be per kid; with
  one kid, one tag.

## Which titles a kid sees

A title is allowed for a kids profile when either:

- a parent marked it **OK for kids**; or
- it is **made for kids** and **within the kid's age**, and no parent marked
  it **Not for kids**.

**Made for kids:** the file is in the KIDS folder (category `kids`), or TMDB
tags the title Family or Animation.

**Within the kid's age:** the title's age rating is at or under the kid's
limit. The rating comes from TMDB: Germany's (FSK) when there is one; when
not, the stricter of France's and the US's. A title with no rating at all is
within age only when it is in the KIDS folder.

Files never move on the NAS for this.

What the owner's library gives (surveyed 2026-10-26 from TMDB, read-only):

- Ratings exist for 96% of matched KIDS titles, 91% of anime and 94% of
  films when combining Germany, France and the US; Germany alone covers
  83–88%. Kodi's own ratings cover only 6% of KIDS titles. Thailand's (the
  app's cinema country) cover about 10%.
- France is lenient (it rates *Ghost in the Shell* and *Cowboy Bebop* "Tous
  publics"; the US rates them R), which is why Germany comes first.
- With FSK 12, about 410 titles are allowed: about 235 from KIDS, 145
  family films from the MOVIES folders and 30 anime. 70 files in KIDS have
  no TMDB match: they count as unrated, so they are allowed.

## Goals

- A 10-year-old can find and start something on the TV alone, from a phone
  in kids mode, and only sees titles fit for them.
- Pausing for a bathroom break, changing the audio language and turning on
  subtitles are possible without a parent.
- Bedtime ends the evening without cutting a film in the middle.
- A parent fixes a wrong call on a title in one tap.

## Non-goals

- Changing how a parent browses on the TV: the normal TV view is unchanged
  (the kids view on the TV is the skin's, from the app's tag).
- Protecting against a child who knows the code, or who uses the TV remote
  or another device. That includes opening the app's address in another
  browser on the same phone (the device's profile choice lives in the
  browser): the owner doesn't worry about such workarounds.
- Different overrides per kid (overrides are for the household; the age
  limit is per kid).
- Screen-time limits other than bedtime.
- Reorganising the folders on the NAS.

## Anti-goals (would make this a failure even if it works)

- A kid reaching a title outside their list by any path: search, a people
  page, a set, a suggestion, Continue watching, a link, or Kodi's next
  episode.
- A kids' title missing because the data is incomplete (an unmatched or
  unrated cartoon in KIDS).
- Parents asked for the code in their own normal use.
- Bedtime stopping a film halfway, or stopping a parent's film.

## Constraints (facts from the code today)

- Profiles exist: `profiles` table (id 1 is the main profile), the
  `x-profile` header and `?p=` in VLC links, the device's choice in
  `localStorage` (`mm.profile`), the "Who's watching?" screen, the badge on
  every screen and the profile form (`web/src/components/WhosWatching.tsx`).
- The KIDS folder maps to category `kids` (`server/scanner.ts`). Titles
  store TMDB genres as English names (`titles.genres`, JSON). About 2,440
  titles are matched to TMDB.
- TMDB details are fetched with `append_to_response` (`server/tmdb.ts`);
  age ratings are `release_dates` for films and `content_ratings` for
  series. They are not stored today; all existing titles need them fetched
  once (about 2 minutes at the app's TMDB pace), new titles when matched.
- Kodi player controls exist (`server/kodi.ts`): play/pause, stop, volume,
  audio stream, subtitles.
- The app keeps a connection to each TV and hears `Player.OnPlay` /
  `Player.OnStop`; whose a play is comes from `server/owners.ts` (a play
  started from the app on a TV belongs to that device's profile).
- The bedtime stop sends `Player.Stop` to Kodi on its own; approving this
  design is the owner's consent to that one automatic Kodi action.
- Today the app writes nothing into Kodi's library (no tags, no
  `VideoLibrary.Set*Details`). The Kids tag is its first write there;
  approving this design is the owner's consent to it.
- The library list (`/api/library`) is one large cached payload; marks are
  fetched per profile separately (`/api/marks`).
- Tests use `node:test`. Each feature gets a Codex review before it is
  committed. The repository is public: no personal data in code or tests.

## Calls made by the designer (not discussed with the owner)

- Germany first, then the stricter of France and the US.
- The main profile can't be a kids profile.
- One parents' code for the household, 4 digits; changed from any device
  not in kids mode.
- Overrides are for the household, not per kid.
- Bedtime lasts until 6:00.
- Kids can like or dislike titles (it only feeds their own suggestions).
- No trailers in kids mode (YouTube leads elsewhere), no Play in VLC.
- The now playing card works on anything allowed for the kid, whoever
  started it, and hides anything else playing on that TV.
- Kids mode is a lock in the app on that phone, not on the server: another
  browser on the same phone starts fresh (accepted, see Non-goals).

## Left to the builder

- Storage for ratings, overrides, the kids settings and the code.
- How the server keeps every path (library, search, people, sets,
  suggestions, Continue watching, title pages, Play) within a kid's list,
  and how that stays fast with the cached library.
- How "Kodi starts the next episode after bedtime" is noticed and stopped.
- The mapping of each country's ratings to ages (including TV ratings).
- The layout of the kids' screens and the now playing card, and wording.
