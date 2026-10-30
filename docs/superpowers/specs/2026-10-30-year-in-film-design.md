# Your year in film: design

Status: designed on 2026-10-30 with the owner. Roadmap item 7. The owner
saw clickable mockups of the question and the story (a private canvas) and
said "looks amazing". Calls marked *(designer's call)* are mine, listed again
at the end for the owner to check.

## Why

Roadmap item 7: "Hours watched, favourite genres, most-watched actors, and
which TV gets used most."

The owner's picture of it: like Spotify's year in review. At the end of the
year, the app offers each person a short animated story of their year in
film, "some nice animations of photos and text", for the profile picked on
that phone, and it asks before showing it.

Two parts:

1. **A play log**, started now: every play, by whom, on which TV, when and
   for how long. Today the app only keeps the last time each title was
   played (from Kodi), so a rewatch counts once, hours can only be guessed
   and which TV was used is not known at all. The owner agreed to start the
   log now, so December's story has exact numbers from today on and next
   year's is exact all year.
2. **The story**: from December, the question "Your year in film is ready",
   then about a minute of full-screen cards with the year's numbers over
   moving posters, backdrops and an actor's photo.

## What the owner decided

- It is the year of the profile picked on that device.
- It comes at the end of the year, "same as Spotify".
- It asks before showing. It never starts by itself.
- An animated story of photos and text, as in the mockups.
- The app keeps a log of every play from now on: who, what, which TV, when,
  how long. Plays shorter than about 5 minutes don't count (tests,
  mis-taps). Tests on the TVs do happen: another tool's checks start films
  for a few seconds.
- Everything played before profiles existed (they started on 26 October
  2026) went to the main profile, the family's viewing included. The owner
  said it is theirs: the main profile's 2026 counts it as its own, with no
  "household" wording. Every other profile's 2026 starts on 26 October.

## What the user sees

### The question

- From **1 December** until **31 January** *(designer's call)*, a profile
  with a year to show gets, on its next open of Home, a sheet over Home:
  "Me · 2026", "Your year in film is ready", one line of teaser ("N films,
  N episodes and one actor you kept coming back to"), and two buttons:
  **See my year** and **Later**. Small print: "Later keeps it on Home until
  31 January."
- It asks **once per profile**, whichever device opens Home first
  *(designer's call)*: either answer, or closing the sheet, counts as asked.
  The answer is kept on the server, so a second phone of the same person
  doesn't ask again.
- After that, Home shows a slim card at the top ("2026 · Your year in
  film · Ready until 31 January") that opens the story. It stays until
  31 January, and the story can be replayed as often as wanted.
- In December the story is of the current year so far, up to today; in
  January, of the year just ended *(designer's call)*.
- A profile with too little to show (fewer than 3 films and episodes
  watched in the year) gets no question and no card *(designer's call)*.
- **Kids profiles** get it too, in the kids view, with the same question
  and story *(designer's call)*. Their numbers only cover what is theirs.

### The story

Full screen, over everything (no tab bar). Cards move on by themselves
after about 6 seconds, with a progress bar per card at the top (as in
stories apps). Tap the right side to go on, the left to go back; a close
button at the top right. Each card's text, numbers and pictures come in
with motion: posters drift in columns, poster walls pop in, a film strip
runs, a backdrop slowly zooms, numbers count up. With the system's
"reduce motion" on, cards fade in place and nothing drifts *(designer's
call)*.

The cards, in order. A card with nothing to say is left out; the first and
the last are always there.

1. **Opening**: the profile's badge, the year in very large type, "Your
   year in film", the dates covered ("1 January to 29 October" in
   December; nothing in January). Behind it, columns of the year's posters
   drift slowly up and down.
2. **How many**: a wall of the year's posters pops in; "You watched", the
   number of films counting up, "films", then "and N episodes."
3. **Hours**: the hours counting up, "hours", then a line putting it in
   days ("More than three days"). A film strip of posters runs underneath.
   Hours from before the log are estimates, so the number is said as
   "about" when any of it is estimated *(designer's call)*.
4. **Genres**: "Mostly", the top genre in very large type, how many of
   the year's titles had it, then bars for the top five growing one after
   another.
5. **The actor**: the actor in the most of the year's titles: their photo,
   their titles' posters fanning out, "You kept coming back to", the name,
   "N films", and a tie said plainly ("Tied with …").
6. **The series**: the series with the most episodes watched: its
   backdrop slowly zooming, the episode count counting up, the name, then
   the next three series with their counts.
7. **Prime time**: the hour of the day most plays started ("10 PM"), a
   line with how many, and a 24-hour bar chart growing bar by bar, that
   hour highlighted.
8. **Which TV** (new, not in the mockups): where the year was watched,
   from the log only: the TV most used, a bar per TV and one for "on the
   phone". In 2026 the log only covers part of the year, so the card says
   since when ("Since 30 October") *(designer's call)*.
9. **The card**: a summary card: films, episodes, hours, prime time, top
   genre, top series, the actor, the oldest film watched. Two buttons:
   **Watch again** and **Done**.

The mockups used stand-in pictures. The real story uses TMDB's posters and
backdrops through the app's image cache, and the actor's TMDB photo (which
the app doesn't keep today: it has to be fetched; see Left to the builder).

## What counts

These rules are the same for every card.

- **A play** is one film or episode played, on a TV or on the phone, for
  at least **5 minutes** *(the 5 minutes: designer's call within the owner's
  "about 5 minutes")*. Shorter plays count nowhere.
- **A film watched**: played to the end in the year (Kodi marked it
  watched, or a play got to the app's "finished" point, 90 %). A film
  started and stopped earlier counts toward hours, not toward films
  *(designer's call)*. The same rule for **an episode watched**.
- **A rewatch** counts again (films, hours, everything), once the log
  has it. Before the log, a title counts once.
- **Hours**: the minutes actually played. From the log: the time from
  start to stop, without pauses, at most the runtime. Before the log: the
  runtime times how far it got (the whole runtime when watched).
- **Genres**: each title watched in the year counts once for each of its
  genres; a series counts once, however many episodes *(designer's call)*.
- **The actor**: the first eight names of each title's cast, over the
  films and series watched; a series counts once. Directors aren't shown
  *(designer's call)*.
- **Prime time**: the hour each play started. Before the log, Kodi's
  last-played time stands in for it.
- **Which TV**: the TV of each play, or "on the phone" for VLC. Only
  from the log.
- **Not counted**: Live TV, trailers, anything not in the library, and in
  the library only titles matched on TMDB as a film or a series count: the
  fitness, courses and other folders and unmatched files have no runtime,
  poster, genres or cast. The log still records their plays, so a later
  card could use them *(designer's call)*.
- **Whose**: the profile the app already gives each play to (who's
  watching on that TV, the kids view, the profile that pressed Play; for
  the phone, the profile on that phone).

### Before the log: what the app has already

When the log starts, each profile's earlier plays are put into it once, as
**estimated** plays, from what the app has today *(designer's call)*:

- Kodi's last play of each film and episode for that profile, when Kodi
  marked it watched or it got past the app's "started" point (2 %). Titles
  only opened (no play count, no resume point) are left out: that also
  leaves out the few-second test plays.
- The phone's last stream of each film and episode, the same way.
- A title in both keeps the one that got further.

A known gap, accepted *(designer's call)*: Kodi moves a title's last play
even for a start of a few seconds, and keeps one play count for the whole
title. So a few-second start this year of a film watched in an earlier year
looks like a viewing this year. The checks run on the TVs by another tool
play two fixed films that were never watched (no play count), so they are
left out; any other such start counts, and only before the log.

Estimated plays have a date and how far they got, but no TV and no
duration of their own (the duration is the runtime times how far it got).

### Plays the app missed

The log only fills while the app runs (it runs on the M1, see roadmap
item 9). A play the app missed still reaches it later: after each Kodi
sync, a film or episode whose last play changed without a play in the log
since gets an estimated play, for the profile the app gives that change to
(as it does today) *(designer's call)*.

## Non-goals

- Sharing or saving the story or the card as a picture *(designer's
  call: not asked; easy to add later)*.
- Past years. The log keeps every year, so a "your earlier years" list can
  come later, but before 2026 the app only has Kodi's last plays.
- A statistics page open all year.
- The story on the TVs (Lumen). The phone app only.
- Sound or music.

## Anti-goals

- Never shows by itself, and never another profile's year: only the
  profile picked on that device.
- Test plays and mis-taps never show up in anyone's year.
- No made-up numbers: a card without data is left out, and estimates say
  "about".
- No new services and nothing new running on the M1 beyond the app
  itself; no new outside services beyond TMDB, which the app already uses.
- The repository is public: no titles, names or numbers from the owner's
  library in code, tests or docs.

## Constraints

- Node 24, TypeScript run as is (no enums, no parameter properties),
  `node:sqlite`, Hono, React 19 + Vite + wouter. Animations in CSS; no new
  libraries *(designer's call)*.
- A database migration adds the log; existing data is put into it in the
  same migration (see Before the log).
- Kids mode only lets kids reach the routes on its list (`KIDS_ROUTES`);
  the story's route has to be added there for kids profiles.
- The app follows Kodi through its events (`Player.OnPlay`,
  `Player.OnStop` today, see `server/kodiEvents.ts`) and decides whose a
  play is in `server/owners.ts`; the phone's plays are noted as they
  stream (`server/watching.ts`). The log hangs off those.

## Left to the builder

- The log's table and how a play is opened and closed: a play still open
  when the app stops or restarts, a TV that never says it stopped, pauses
  (Kodi also has `Player.OnPause` and `Player.OnResume`), and how a
  phone stream's minutes are worked out (how far it got times the
  runtime is fine).
- Episode runtimes: TMDB's series runtime isn't stored today; any source
  (Kodi's episode details, TMDB) is fine.
- Fetching and caching the actor's photo from TMDB.
- The exact copy and motion of each card, staying with the mockups' look
  (the app's petrol night, screen-white text, projector-bulb gold, Big
  Shoulders Display for the large type).
- Where the "asked" answer and the year's numbers are worked out (on
  each open, or kept).

## Designer's calls, for the owner to check

1. The question comes from 1 December; the card stays until 31 January.
2. It asks once per profile, on whichever device opens first.
3. December shows the year so far; January the year just ended.
4. Fewer than 3 films and episodes watched: no question, no card.
5. Kids profiles get it too, in the kids view.
6. "Reduce motion" turns the motion into fades.
7. A new card, Which TV, from the log only, said "since" its start.
8. A play counts from 5 minutes.
9. A film started but not finished counts toward hours, not films.
10. Genres and the actor count each title once, a series once.
11. Directors aren't shown.
12. Earlier plays are put into the log once, as estimates; titles only
    opened are left out.
13. Plays the app missed come back as estimates after a Kodi sync.
14. No sharing as a picture, for now.
15. No new libraries.
16. Only titles matched on TMDB as films or series count; fitness,
    courses, other folders and unmatched files don't (their plays are
    still logged).
17. Before the log, a short start of a film watched in an earlier year
    can count as watched this year: accepted.
