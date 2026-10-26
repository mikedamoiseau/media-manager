# Profiles ("Who's watching?"): design

Status: agreed with the owner on 2026-10-26, ready to plan.

## Why

Several Kodi TVs (living room, bedroom) now share one Kodi library, and
more than one person uses the app, each from their own phone or tablet.
Today everything personal in the app is one pool: one Continue watching
row, one set of likes, one stream of suggestions. One person's series fill
the other's Continue watching, and suggestions mix two people's tastes.

Profiles give each person their own taste and progress in the app. The
library itself stays the same for everyone.

## What the user sees

### First open on a device: "Who's watching?"

- A device that has no profile chosen yet (or whose profile was removed)
  opens on a "Who's watching?" screen: one tile per profile and an
  "Add someone" button.
- Adding someone asks for a name and a colour, then picks that profile.
- The choice is remembered on that device and not asked again.
- Devices already in use see the screen once after the update.
- No passwords on profiles.

### Switching

- A small round badge (the profile's initial, in its colour) is in the top
  corner of every screen. Tapping it opens the same "Who's watching?"
  screen, to switch or add someone.

### Managing profiles

- Settings has a Profiles panel: rename, change colour, remove.
- Removing a profile deletes its likes, activity and progress.
- The main profile can't be removed (see below).

## What belongs to each profile

- Likes and dislikes ("Did you like it?").
- What they do in the app that feeds suggestions: pages opened, trailers,
  plays.
- Suggestions ("Suggested for you") and the films not on the NAS picked
  from their tastes, both built from that profile only.
- Continue watching, including titles removed from it by hand.
- Progress: how far into each film, which episodes of a series were
  finished, and the episode in progress.
- In the app, the watched badges on tiles and the "Not watched" and
  in-progress filters show the current profile's own history.
- Whether a film can be rated: the current profile watched it.
- Suggestions leave out only what that profile has watched, so a film one
  person watched alone can still be suggested to the other.

## What stays shared

- The library: the titles shown, matches, posters, hidden titles.
- Settings, TVs, and the home-screen row toggles. Those toggles are stored
  on each device today and stay that way: switching profile on a device
  doesn't change them.
- "Films to get" (and its "not interested" choices): one list for the
  household.
- Reports.

## Whose progress is it

- Played from the app (Play on TV, an episode on TV, VLC on the device,
  "Continue on this device"): the profile chosen on that device.
- Started on a TV from the app's Remote tab (moving through Kodi's menus,
  Select in Kodi's own resume dialog, next/previous): the profile of the
  device that last used the Remote on that TV, when the play starts soon
  after. Decided by the owner.
- Started on a TV without the app (the TV's own remote, Kodi's menus with
  that remote), or anything else the app can't tie to a device: the main
  profile.
- Watching together: whoever pressed Play gets the progress.

## Picking up where you left off

- Play from the app starts at that profile's own point: its place in the
  film, or for a series its next episode and its place in it. Not
  Kodi's shared resume point, which may be someone else's.
- Nothing played yet by that profile: from the start (for a series, its
  first unwatched episode).
- Started with the TV remote, Kodi uses its own single resume point, as
  today.
- Play in VLC (the title page's button and each episode's) stays as
  today: it doesn't start at the profile's point. VLC runs on each
  person's own device, so what VLC remembers is already mostly per person.
  Progress made in VLC still goes to the device's profile. "Continue on
  this device" already starts at the right moment and is unchanged.
  Decided by the owner.
- Kodi's watched ticks and resume points on the TV screens stay shared:
  there is one Kodi library.

## The main profile and existing data

- The update creates the main profile. Everything recorded so far becomes
  its own: Kodi's plays, resume points and last-played dates as synced,
  VLC progress, titles removed from Continue watching, likes and dislikes,
  and app activity.
- Other people start with an empty history.
- The code gives the main profile a neutral default name (the repo is
  public: no personal names in code). On this install it is renamed to
  the owner's name after the update.
- The main profile can't be removed: it receives everything started
  without the app.

## Later: kids mode (not built now)

A profile will later be able to be a kids profile: anyone can switch into
it freely, and leaving it needs a PIN. Build nothing for it now. Keep the
profile record and the switching flow simple to extend: a profile can
later gain a flag, and switching away from a profile can later be gated.

## Goals

- Each person sees only their own Continue watching, likes and
  suggestions.
- Progress from any device or TV lands on the right person under the
  rules above, without anyone having to think about it.
- Choosing who you are happens once per device; switching is one tap.

## Non-goals

- Different library contents, settings or home-screen rows per profile.
- Passwords or PINs on profiles (until kids mode).
- Kodi's own profiles, or separate watched ticks on the TV screens.
- Telling apart two people watching together.
- Kids mode.

## Anti-goals (would make this a failure even if it works)

- One person's viewing showing up in the other's Continue watching.
- Being asked "Who's watching?" again and again on the same device.
- Losing any history recorded before the update.
- A slower library screen: the library list is large and cached.

## Constraints (facts from the code today)

- Kodi's plays, resume points and last-played dates reach the app by a
  sync from the first TV (after each NAS scan, every 10 minutes by
  default; on new files; on pull to refresh). In the database they are
  per file and shared (`items` and `episodes`: `playcount`, `resume`,
  `last_played`). Per-profile progress made on a TV has to be worked out
  from what changes between syncs, and/or from Kodi's player events on the
  connection the app keeps open to each TV, and tied to the profile that
  started the play.
- The app knows which TV a play was sent to (`x-kodi-tv` header,
  `?tv=`). The device's choices are kept in `localStorage` (`mm.tv`,
  `mm.prefs`); the chosen profile can follow the same pattern.
- VLC fetches the handoff and media URLs itself, without the app's
  headers or storage: the profile has to travel inside those links, the
  way the TV id already does (`-v<id>` in the handoff options).
- Personal data today: `ratings`, `activity`, `watching` (VLC progress
  and dismissals, one row per item), `episodes.streamed` and
  `episodes.streamed_at`. `picks` ("Films to get") stays shared.
- The library list (`/api/library`) is one large cached payload with
  watched and in-progress flags per title (`w`, `rs`). Per-profile flags
  must not make it slow.
- Kodi's `Player.Open` accepts a boolean, a percentage or a time as
  `options.resume` (checked with `JSONRPC.Introspect` on the Pi, Kodi
  21.3), which allows starting at a profile's own point.
- Tests use `node:test`. Each feature gets a Codex review before it is
  committed.

## Calls made by the designer (not discussed with the owner)

- Removing a profile deletes its likes, activity and progress (no undo).
- The main profile can't be removed.
- "Not interested" choices go with "Films to get" and stay shared.
- The home-screen row toggles stay per device, as today.
- The switching badge is on every screen.
- The main profile's default name in code is neutral; renamed on this
  install.

## Left to the builder

- The storage schema and the migration.
- How TV progress is captured and tied to a profile (diffs between syncs,
  Kodi player events, or both), and how long after a Play from the app a
  change on that TV still counts as that profile's.
- The API shape, including how requests say which profile they are for.
- The colour palette, the badge and screen layout, and their wording.
- How the profile travels in VLC links.
