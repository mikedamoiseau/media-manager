# Live TV: design

Status: agreed with the owner on 2026-10-28, ready to plan.

## Why

The household watches its NAS films on two Kodi TVs (living room: the Pi;
bedroom: the Mi Box) and drives them from the app. The owner wants live
French and Belgian TV the same way: open the app, see what's on, tap a
channel, and it plays on the TV. Today neither box has live TV and the app
has no guide.

The free channel lists of iptv-org (github.com/iptv-org/iptv) carry
thousands of channels, most of which the owner would never watch, and no
TV guide. So the owner picks the channels they want, the app builds the
small list both TVs read, and the guide lives in the app only (not in Kodi).

## What the user sees

### The Live TV page

- A new **Live TV** tab in the app's tab bar.
- Two views of the same channels, in the owner's order:
  - **Grid**: channels down the left (logo and name, pinned while
    scrolling sideways), time across, a red line for now, the programme on
    now marked. It opens scrolled to about 30 minutes before now; swipe
    sideways for later.
  - **List**: one row per channel: the programme on now, how far in it is
    (a progress bar), when it ends, and what's next.
- **Which view shows**: a wide screen gets the grid, a narrow one gets the
  list (a phone held upright: list; a phone on its side, an iPad, a
  computer: grid). A **Grid / List** switch next to the title overrides
  that until the screen's shape changes (rotating, resizing). Rotating
  keeps the place: the same channels stay in view.
- **Tapping a channel** (its logo or name in the grid, its row in the list)
  starts it on the TV chosen in the app's existing **Play on** picker.
- **Tapping a programme** in the grid opens its details: picture, title,
  episode, category, description, times, and **Watch on TV** when it's on
  now.
- **Watch on phone**: plays the channel in VLC on the phone (see "Playing
  on the phone").
- Times show in the device's local time. The household is in UTC+7, six
  hours ahead of Paris in winter, so French evening TV falls in the night:
  "what's on now" matters more than evening planning.
- A channel with no guide still has its row (logo and name), with no
  programmes.
- If a channel doesn't actually start on the TV, the app says so (see
  "Starting a channel on a TV").

Mockups shown to the owner (grid and list side by side, real guide data):
the grid and the list in the app's colours, logos on white tiles, the
programme on now with a yellow edge.

### Picking the channels (Settings)

- A Settings screen lists every French and Belgian channel from iptv-org
  (about 240) with logo, name and group (news, kids, movies…).
- Each channel shows whether its stream answers (checked by the app; a
  channel that answers may still fail to play).
- The owner ticks the channels they want and drags them into their order.
  That order is the channel numbers on both TVs and the order on the Live
  TV page.
- The screen shows, for each ticked channel, which guide channel it was
  matched to (or "no guide"), and lets the owner pick another guide channel
  or none.
- A note says the TVs see a changed list only after Kodi restarts or after
  its refresh (see Constraints).

### Kids

- No live TV in kids mode: the Live TV tab is hidden there, and the app
  never starts a channel on a TV that shows its kids view (Lumen's skin
  setting `CinemathequeKids` on), whoever asks. The app says why.
- Lumen also blocks live TV in its kids view (Kodi session's side), so the
  TV remote can't reach it either. A kids channel list may come later; not
  in this design.

## How it works

### The channel list on the NAS

- The app reads iptv-org's French and Belgian lists
  (`https://iptv-org.github.io/iptv/countries/fr.m3u`, `…/be.m3u`).
- It writes **one** list with only the ticked channels to the NAS:
  `video/IPTV/channels.m3u` (on the Mac: `/Volumes/video/IPTV/`), next to
  `MEDIA`, never inside it, with an empty `.nomedia` file in the folder so
  Kodi's library scan skips it. The owner approved this folder on
  2026-10-28; it is the only place on the NAS the app writes.
- Both TVs read that file from `smb://192.168.0.24/video/IPTV/channels.m3u`.
  The NAS is always on, so the TVs never need the Mac to get their
  channels.
- Each entry keeps iptv-org's `tvg-id`, `tvg-logo`, `group-title` and any
  `#EXTVLCOPT` header lines (user agent, referrer), and gets a `tvg-chno`
  (its position in the owner's order) so both TVs number channels the same.
- The app refreshes the iptv-org lists once a day while it runs and
  rewrites the file when the owner's channels change or when a ticked
  channel's stream address changes upstream.

### The guide

- The app downloads the guide files once a day while it runs (and at start
  when the last download is over a day old). They are XMLTV, the standard
  TV-guide format; nothing is converted, only matched.
- Sources, in priority order, editable in Settings:
  1. xmltvfr.fr, full file: `https://xmltvfr.fr/xmltv/xmltv.xml.gz`
     (17 MB compressed, 135 MB unpacked, 770 channels including the
     Belgian ones, programmes about 10 days ahead).
  2. Pluto TV France: `https://i.mjh.nz/PlutoTV/fr.xml.gz` (0.4 MB), for
     the Pluto channels in iptv-org's French list.
- The app reads each file as a stream (the big one can't be loaded whole)
  and keeps only the programmes of the ticked channels.
- **Matching** a ticked channel to a guide channel, first hit wins:
  1. The owner's manual pick in Settings.
  2. The channel's `tvg-id` without its `@…` part, ignoring case, equal to
     a guide channel id (`TF1.fr@SD` → `TF1.fr`).
  3. An alias table for channels the guide still lists under their old
     names: `TFX.fr` → `NT1.fr`, `LCP.fr` → `LaChaineParlementaire.fr`,
     `RMCStory.fr` → `Numero23.fr`, `LEquipe.fr` → `LEquipe21.fr`.
  4. Pluto channels: the Pluto id in the stream address
     (`jmp2.uk/plu-<id>.m3u8`) equals the Pluto guide's channel id.
  5. Otherwise: no guide.
- When two sources have the same channel, the higher one in the list wins.

### Starting a channel on a TV

- Channel ids differ between the two TVs (each box keeps its own TV
  database). At play time the app asks that TV for its channels
  (`PVR.GetChannels`, group `alltv`) and finds the channel **by name**
  (the app writes the names, and makes them unique), using the number only
  to break a tie; it never reuses one TV's id on the other. Numbers can't
  be trusted on their own: after the owner reorders, the TV keeps the old
  numbers until it rereads the list.
- If that TV doesn't have the channel yet (ticked after Kodi last read the
  list), the app says the TV hasn't loaded the new list yet.
- It starts it with `Player.Open {"item":{"channelid":N}}`.
- About 10 seconds later it checks that the TV is really playing
  (`Player.GetActivePlayers`): many streams die without an error. If
  nothing plays, the app shows that the channel didn't start and the stream
  may be down.
- A channel playing on a TV is not a library play: it is not recorded in
  any profile's history, Continue watching or watched marks.

### Playing on the phone

- **Watch on phone** gives VLC the channel's own stream address (as VLC
  for iOS is opened today, `vlc-x-callback://x-callback-url/stream?url=…`).
  The phone pulls the stream straight from its source: the Mac carries no
  video and the phone never gets the whole list. This was the owner's
  condition: if it needed the full list or the Mac in the middle, no phone
  playback at all.
- Channels whose entry carries a user-agent or referrer line (31 of the
  French and Belgian entries) can't go in a bare VLC link. For those, the
  Mac hands VLC a one-channel playlist of three lines (name, the header
  line, the stream address), the way films are handed over today
  (`vlcPlaylist` in `server/media.ts`); VLC then pulls the video straight
  from the source. The owner OK'd this on 2026-10-28: no video through the
  Mac, never the full list. Not verified yet: that VLC for iOS honours
  `http-user-agent` / `http-referrer` in such a playlist (only start time
  and tracks were checked, 2026-10-25).

## Who builds what

- **This app** (this repository): the channel picker, the file on the NAS,
  the guide download and matching, the Live TV page, starting channels on a
  TV and on the phone, the kids block in the app.
- **The Kodi/Lumen session** (agreed with it on 2026-10-28): installs the
  "IPTV Simple Client" add-on (`pvr.iptvsimple`) on both TVs once the file
  exists, one configuration each, pointing at the NAS file ("Local path");
  checks that `smb://` works there; sets a refresh interval; makes Lumen's
  player screen behave on a live stream; blocks live TV in Lumen's kids
  view. It reports each test play.
- The app's work comes first: the Kodi side needs the file to exist.

## Goals

- Open the app, see what's on now on the owner's channels, tap one, and it
  plays on the chosen TV.
- The owner picks and orders their channels once, in the app.
- Most of the channels the owner is likely to tick have a guide.
- Watching on the phone with no video going through the Mac.

## Non-goals

- Recording, reminders, timeshift or catch-up.
- A guide inside Kodi.
- Channels from other countries (the design allows more lists later).
- Moving the app off the M1 (parked, see below).
- A kids channel list.
- Android phones for "Watch on phone": it follows the existing VLC handoff,
  which is VLC for iOS.

## Anti-goals (would make this a failure even if it works)

- A new background service, scheduled job outside the app, or container on
  the M1 or on Home Assistant. Everything runs inside the existing app.
- Live video passing through the Mac.
- The TVs needing the Mac to be awake to get their channels.
- Writing anywhere on the NAS other than `video/IPTV/`, or anything inside
  `MEDIA`.
- A child reaching live TV from kids mode or a TV's kids view.
- Live TV plays showing up in a profile's history or watched marks.

## Constraints (facts measured on 2026-10-28)

- iptv-org: `fr.m3u` has 198 entries (192 distinct channels), `be.m3u` 51
  (49). Every entry has a `tvg-id` with a feed suffix (`@SD`, `@HD`,
  `@French`…); the lists have no guide address. 24 French and 7 Belgian
  entries carry an `#EXTVLCOPT` user agent or referrer.
- Belgium is thin: no RTBF (La Une, Tipik, La Trois); RTL-TVI is marked
  "Not 24/7". The rest is local TV, radios with video and Flemish channels
  at 360p.
- Streams come and go. Of the main French channels, 13 tested answered
  from the house, but TF1, France 2, France 4, France 5, LCI, TFX,
  Franceinfo, TF1 Séries Films and 6ter all come from one unknown relay
  (`149.62.177.107`); M6 and Gulli from another (`99.27.51.147`). Any of
  them can vanish.
- Guide coverage with the matching above, measured against the lists:
  58 of 192 French channels and 22 of 49 Belgian channels by id (before
  aliases); 52 of the 54 Pluto streams by Pluto id. Main French channels:
  all covered once the four aliases are in. Misses are mostly regional
  BFM, radios and small channels.
- Kodi side (read by the Kodi session): `pvr.iptvsimple` 21.11.0.3 is
  available, not installed. It accepts several lists since Kodi 20, but
  each gets its own numbering, hence one file. It reads the list at Kodi
  start and on its refresh interval only. Its local-file cache applies to
  web addresses only. `PVR.GetChannels` gives name, number, icon and a
  hashed `uniqueid`, never the `tvg-id`. HLS goes through ffmpeg by
  default; `inputstream.adaptive` 21.5.25.1 is installed on the Pi.
- Kodi's TV database is local to each box (only the video library is
  shared, in MariaDB).
- The Mac mounts the NAS share `video` (SMB, the owner's NAS login) on
  `/Volumes/video` (only while mounted). Writing there works: on
  2026-10-28, at the owner's request, a hand-made starter list of 25
  channels was written to `/Volumes/video/IPTV/channels.m3u` (with
  `.nomedia`) so the Kodi side could start. It was made by a throwaway script, not by
  the app; the app takes the file over, same path and format.
- From the house, on 2026-10-28: France 3's stream is raw MPEG-TS over
  HTTP, not HLS (a stream check must not insist on an HLS playlist).
  RTL-TVI and Bel RTL answered 400, TV Lux and Télé MB 403 (probably
  limited to Belgium), so they're not in the starter list.
- The app: Node ≥ 24, Hono, `node:sqlite`, no XML parser among its
  dependencies. Kodi calls are in `server/kodi.ts` (`Player.Open` for
  library items today), TV events in `server/kodiEvents.ts`
  (`Player.OnPlay`/`OnStop`), play owners in `server/owners.ts`, the kids
  view setting name in `server/kidsTag.ts` (`KIDS_VIEW`), the VLC link in
  `web/src/vlc.ts` (`vlcLink`), tabs in `web/src/App.tsx`, the periodic
  scan timer in `server/service.ts`.
- Tests use `node:test`. Each feature gets a Codex review before it is
  committed. The repository is public: no personal data in code or tests
  (the NAS address and paths are settings, not code).
- The M1 is the owner's personal computer: no new services there. Home
  Assistant's box runs everything as containers, which the owner would
  rather avoid there.

## Calls made by the designer (not discussed with the owner)

- Grid/list breakpoint by width (about 700 px), not by orientation; the
  override lasts until the screen's shape changes.
- The grid opens at now minus 30 minutes.
- Times in the device's local time only (no Paris time shown).
- Tapping a programme opens details; only the channel starts playback.
- Channel numbers are the owner's order, 1 to n, renumbered when the owner
  reorders (the TVs catch up when they reread the list).
- When the app can't read whether a TV shows its kids view (Kodi doesn't
  answer), it doesn't start the channel.
- Daily refresh of both the iptv-org lists and the guide, inside the app.
- The two guide sources and their order; the four aliases.
- The app blocks a channel on a TV in its kids view even when a parent asks
  from their own phone.
- Live TV is a fifth tab, "Live TV", hidden in kids mode.

## Left to the builder

- Storage for channel picks, order, manual guide picks, sources and
  programmes; how long programmes are kept.
- How the guide files are read as a stream (a small parser or a
  dependency), and making the daily download light on the M1.
- How stream checks run in Settings (when, how many at once, timeouts).
- What the key of a pick is (`tvg-id` with its feed suffix; what to do
  when iptv-org drops or renames an entry the owner ticked).
- Writing the NAS file safely (no half-written file for Kodi to read), and
  what the app shows when the NAS isn't mounted. If the share ever turns
  out read-only for the Mac, the owner fixes the NAS permissions (every
  workaround breaks an anti-goal).
- Making the grid fast on a phone with many channels and several days.
- What the Remote tab's now-playing card shows for a channel.
- Layout details and wording.

## Parked: moving the app to the Home Assistant box

The owner would like the app off the M1, on the Mac mini that runs Home
Assistant OS. On HAOS everything runs as a container (an add-on), and the
owner said "ideally no Docker" there. The Home Assistant session measured
plenty of room (16 GB RAM, about 1.2 GB used, 200 GB free) but a locally
built add-on would be copied into every backup (about 68 MB today, daily,
three places). That's a separate project, to discuss on its own; nothing
in this design depends on it.
