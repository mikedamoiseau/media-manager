# Live TV on the TVs: zapping from the phone, the guide in Kodi

Date: 2026-10-31. Follows [the live TV design](2026-10-28-live-tv-design.md).

## Why

The owner's channels are numbered (France, then Belgium, then Extra), and both TVs read them from the
list the app writes on the NAS. Two things are missing to watch them like television:

- **Zapping from the phone.** The Remote page has no channel buttons. To change channel you go back to
  the Live TV page and pick one.
- **The guide on the TV.** The app reads the TV guides, but Kodi doesn't: its TV guide grid is empty,
  and while a channel plays the TV shows only the channel's name.

## What the owner gets

### On the phone (the Remote page)

While one of the owner's channels plays on the TV this phone controls:

- The now-playing card shows the channel: its logo, its number and name, the programme on now with its
  times, how far into it the programme is, and what comes next. The position bar (meaningless for a live
  stream) is gone. The programme's picture, when the guide has one, is the card's backdrop.
- A channel row: **−** and **+**, like a TV remote's CH buttons, around the channel to come.
  - Each tap moves one channel along the owner's numbering, wrapping around (after the last channel, the
    first; before the first, the last). Categories don't stop the count.
  - Taps add up: the row shows the channel they lead to (number, name, what's on), and the TV changes
    once, 0.7 s after the last tap. Three quick taps go three channels on, without starting the two in
    between.
  - After the switch, the same check as on the Live TV page: if the channel doesn't play a few seconds
    later, a message says its stream may be down.
- On a computer, Page Up and Page Down do the same as + and −.

Not shown when the TV plays anything else (a film, an episode, a channel that isn't the owner's), nor
on a kids profile. Kids mode already sees no live TV at all: the live TV routes are closed to it, and
the now-playing answer hides what isn't one of the kid's titles.

### On the TV (Kodi)

- **The guide file.** Next to `channels.m3u` on the NAS, the app writes `guide.xml`: the guide of the
  owner's channels, in XMLTV, over the days the TVs show: one day back, four days ahead.
  - One `<channel>` per channel of the list: its id is the channel's `tvg-id` in `channels.m3u` (so
    Kodi matches them without a name lookup), with its name and logo.
  - One `<programme>` per programme: start, stop (UTC, `+0000`), title, sub-title, description,
    category and picture, as far as the guide has them.
  - A channel without a guide has its `<channel>` and no programme.
  - Written whole (a temporary file renamed), and only when the share is mounted, as `channels.m3u` is.
  - Written again: after each refresh of the guides (daily, or from Settings), when the owner changes
    their channels or a channel's guide, and when the app starts.
- **Where Kodi finds it.** The list's first line names it, as the TVs reach the NAS:
  `#EXTM3U x-tvg-url="smb://<nas>/<share>/IPTV/guide.xml"`. IPTV Simple reads that address when no guide
  is set on the TV, which is the case on both: no setting to change on the boxes. The address comes from
  each TV's media path (its path prefix) and the Mac's media folder; when the TVs reach the NAS
  differently, or no TV's path is known yet, the line names no guide. IPTV Simple reloads the list and
  the guide every hour (the boxes' "repeated refresh"), so a new guide shows within the hour.
- **Kodi's side** (the Kodi session's work, not this branch's): the skin shows, while a channel plays,
  the channel's name and number, and from the guide the programme's title, picture and description.
  Kodi's own TV guide grid fills from the same file.

## Decisions

- **The file, not an address on the app.** Kodi reads the guide from the NAS, as it reads the list:
  the TVs keep their guide when this Mac sleeps.
- **Ids are the `tvg-id`s.** Not the guides' own ids: one channel's guide may come from any of the
  three guides, under any id, and the owner may pick it by hand.
- **The phone zaps through the app**, with the existing "play this channel" call, not with Kodi's own
  channel up/down: Kodi's moves within its current group (one category), not the owner's numbering, and
  it can't show where a run of taps leads.
- **Which channel plays** is read from Kodi's player (`Player.GetItem`): a live channel is an item of
  type `channel`, its `channel` field named as in `channels.m3u` (read from IPTV Simple's and Kodi's
  source by the Kodi session, not yet measured in a play). Matched to the owner's channels by that name, as starting
  one is (exact, then ignoring case).

## Not in this

- Number keys (typing "12"), a "previous channel" key, recording, timeshift.
- The physical remotes' CH buttons: Kodi's (see above), the Kodi session's to tune.

## Checks

- `guide.xml` read back with the app's own XMLTV reader gives the programmes it was written from;
  special characters (`&`, `<`, quotes) survive.
- The Remote page, at phone width, while a channel plays (a stand-in Kodi in the sandbox): channel card,
  three quick taps on + start one channel, three on, wrapping past the last.
- A kids profile's Remote shows no channel row, and the zap's play call is refused for it.
