# Up next and sleep timer: design

Status: designed on 2026-10-29. The owner asked for roadmap item 5 ("work on
item 5") after skipping the questions for items 3 and 6, so every call below
is the designer's, listed at the end for the owner to check.

## Why

Roadmap item 5: "Line up a few episodes or films to play one after another
on a chosen TV. Add 'stop after this episode' or 'stop in 45 minutes'."

Today Play on TV starts one film or one episode. When it ends, nothing
follows: the living-room Kodi has "Play next video automatically" off (its
`videoplayer.autoplaynextitem` is empty, read on 2026-10-29), so even the
next episode of a series needs someone to pick up a phone. And nothing stops
the TV for someone who falls asleep in front of it.

Two things:

1. **Up next**: a list per TV of films and episodes that play one after
   another. Anyone adds to it from a title page; the Remote shows it.
2. **Sleep timer**: "stop after this one" or "stop in N minutes", per TV,
   from the Remote.

## What the user sees

### Adding to Up next

- **A title page** (film or series, on the NAS, Kodi connected, not kids
  mode, not bedtime) gets an **Up next** button next to Play on TV.
  - A film: adds the film. Already in the list: the button reads
    "In Up next" and is disabled.
  - A series: adds the episode that comes next for that TV: the one after
    the last episode of this series already in the list; else the one after
    the episode of this series playing on that TV now; else the episode
    Play on TV would start (where the series stands for this profile). Each
    tap adds one more episode, so three taps line up three episodes.
    Nothing left (the last episode is already queued or playing): the toast
    says so and nothing is added.
- **An episode row** on a series page gets a small add button (beside the
  VLC one on iPhones): adds that episode. Already in the list: the toast says
  so.
- A toast confirms: "Added S2 E5 to Up next on Living room".
- The list belongs to the TV this device controls (the TV bar's choice), and
  each entry to the profile that added it: when it plays, it plays from
  where that profile stopped, and Kodi's changes are theirs (as Play on TV
  does today).

### The Remote

- Under the transport buttons, an **Up next** section lists the entries in
  order: poster, title, and for an episode "S2 E5 · episode title". Each row
  has a remove button. Tapping a row plays it now (it leaves the list).
  A "Clear" button empties the list. Empty: one line of help ("Add films
  and episodes from their pages; they play here one after another.").
- The now-playing card shows the first entry under the progress bar:
  "Next: S2 E6 · The Return".
- A **sleep timer** button (moon) sits in the now-playing card beside the
  power button. It opens a sheet:
  - "After this episode" / "After this film" (only while something plays),
  - "In 15 minutes", 30, 45, 60, 90,
  - "Turn off" when one is set.
- When a timer is set, the card shows it: "Stops in 42 min" or "Stops after
  this episode", tappable to open the sheet again. Every device controlling
  that TV sees the same list and timer (they live on the server).

### What happens on the TV

- When a film or episode **plays to its end** on a TV whose Up next isn't
  empty, the first entry starts a moment later and leaves the list.
- **Stopped by hand** (the Stop button, Kodi's remote, another Play): the
  list waits. It goes on after the next play that runs to its end, or when
  someone taps a row.
- A failed start (the file left the NAS, Kodi refused it) drops that entry
  and tries the next one.
- **Stop in N minutes**: at that time, whatever plays on that TV stops. The
  list stays as it was (a stop by the timer is a stop by hand).
- **Stop after this one**: when what plays now ends, nothing follows: the
  list waits, and if Kodi goes on to the next episode by itself (a TV with
  "Play next video automatically" on), that play is stopped, as at a kid's
  bedtime. Stopped by hand before its end: the timer is done.
- An Up next nobody added to or played from for **6 hours** is cleared, so
  yesterday's list doesn't start after tonight's film.

## How it works

### Where the list lives

In the app's database, per TV, not in Kodi's own playlist. Kodi's playlist
would play on without the app, but it starts each entry Kodi's way: from
Kodi's own resume point, for whoever Kodi thinks is watching. The app already
works out, per profile, where to start (`startPoint`) and whose play it is
(`TvOwners`, `notePlay`); an entry the app starts goes through the same Play
as the button. The cost: the list moves on only while the app runs and hears
the TV (see Constraints).

A table `up_next` (migration 14): one row per entry, `tv_id`, `item_id`,
`episode_id` (null for a film), `profile_id`, `at` (when added; refreshed for
the whole TV's list when something is added or played from it, for the
6-hour rule). Order is by row id; there is no reordering.

### Moving on

The Service already hears each TV's `Player.OnStop` with Kodi's `end` flag
(`PlayerEvent {kind: 'stop', ended}`). On a stop with `ended`:

1. A "stop after this" timer on that TV: clear it, start nothing, and stop a
   play Kodi chains to by itself within `CHAIN_WINDOW` (the same test as
   `bedtimeStop`: `owners.chained(tvId)`).
2. Else, the TV's list (stale entries cleared) has a first entry: take it off
   the list and Play it, after a short pause (about 2 s, so Kodi has finished
   closing the last one), as that entry's profile. The Play is the one the
   route `/items/:id/play` does today, moved out of the route into one
   function both use.

A kid's bedtime still applies: an entry whose profile is a kids profile in
its bedtime is not started (kids can't add entries, so this only guards
against a profile that became a kids profile).

### The timer

A table `tv_sleep` (migration 14): `tv_id`, `at` (when to stop; null for
"after this"), `until` (for "after this": when the timer lapses, so one left
behind by a missed stop event doesn't stop something days later; 6 hours).
The Service checks every 15 s: a timer whose `at` has passed stops that TV
(`remote(tv, 'stop')`) and is removed; one past its `until` is removed.
Checking the clock instead of one long `setTimeout` keeps it right after the
Mac sleeps or the app restarts.

### What the devices see

`TvStatus` (sent to every device with the status) gets, per TV:

- `upNext: UpNextEntry[]`: `{ id, itemId, episodeId, title, label?,
  episodeTitle? }`, where `title` is the film or show title and `label`
  is "S2 E5" for an episode.
- `sleep: { at: number } | { afterThis: true } | null`.

The status is sent again whenever either changes.

A TV removed in Settings takes its list and timer with it; a profile removed
takes its entries.

### Routes (all refused to kids, as any route not in the kids list)

- `POST /api/upnext` `{ itemId, episodeId? }`: adds to the device's TV
  (`x-kodi-tv`), for the device's profile. 404 not on the NAS or no episode
  left to add; 409 already in the list.
- `DELETE /api/upnext/:id`: removes one entry. `DELETE /api/upnext`: clears
  the TV's list.
- `POST /api/upnext/:id/play`: takes it off the list and plays it now.
- `PUT /api/kodi/sleep` `{ minutes }` (whole number, 1 to 240) or
  `{ afterThis: true }` (409 when nothing plays on that TV);
  `DELETE /api/kodi/sleep` turns it off.

## Goals

- Line up films and episodes per TV from the phone, and they play one after
  another, each from where its profile stopped.
- Stop after this one, or in 15 to 90 minutes, per TV.
- Every phone controlling a TV sees the same list and timer, live.

## Non-goals

- Reordering the list (remove and add again).
- Up next or the timer in kids mode (a parent sets them from their own
  phone for the kids' TV).
- Turning the TV set off (CEC) or dimming; the timer stops playback only.
- Queueing on the phone (VLC) or queueing live TV channels and trailers.
- Kodi's own playlist, or changing Kodi's "Play next video automatically".
- A timer or list shown on the TV bar.

## Anti-goals (would make this a failure even if it works)

- Something starting on a TV that nobody there expects (an old list after
  tonight's film; a timer from last week).
- A queued episode starting from someone else's resume point, or its watched
  state landing on the wrong profile.
- The timer failing silently after the Mac slept or the app restarted.

## Constraints (facts measured on 2026-10-29)

- Living-room Kodi (Pi, 21.3): `videoplayer.autoplaynextitem` is `[]`
  (options: Music videos 0, TV shows 1, Episodes 2, Movies 3,
  Uncategorized 4). Its video playlist (id 1) is empty. The bedroom Mi Box
  did not answer (off), so its setting is unknown; the design works either
  way.
- Kodi's event stream (TCP 9090) reports `Player.OnStop` with
  `data.end: true` for a play that ran to its end; the app parses it into
  `PlayerEvent.ended` today.
- The app runs on the M1 and stops when it sleeps (roadmap item 9): the list
  moves on and the timer fires only while the app runs and hears the TV.
- Node ≥24 with type stripping only (no enums, no parameter properties).

## Calls made by the designer (not discussed with the owner)

1. The list lives in the app, not in Kodi's playlist (per-profile start
   points and attribution; costs: needs the app running).
2. A series' Up next button adds one episode per tap, continuing after the
   last one queued or playing.
3. A play stopped by hand pauses the list; it goes on after the next play
   that runs to its end, or from a tap on a row.
4. The list is cleared after 6 hours without being added to or played from.
5. No reordering; remove and add again.
6. Timer choices: after this one, 15, 30, 45, 60, 90 minutes. The API takes
   any 1 to 240 minutes.
7. The timer stops playback; the list stays.
8. "Stop after this" also stops Kodi going on by itself to the next episode,
   as bedtime does.
9. Up next and the timer are hidden in kids mode and refused to kids.
10. Up next sits on the Remote tab, with the next entry on the now-playing
    card; nothing on the TV bar.

## Left to the builder

- Names of functions and modules, the poster thumbnail in rows (reuse what
  the library uses), the moon and add icons, exact copy of toasts and help.
- How long the pause before the next entry is (about 2 s).
- Whether the episode playing now is known from the TV's events (the Service
  sees which film or episode started) or asked of Kodi.
