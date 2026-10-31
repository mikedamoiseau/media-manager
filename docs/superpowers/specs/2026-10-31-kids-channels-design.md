# Kids channels

Date: 2026-10-31. Follows [live TV on the TVs](2026-10-31-live-tv-kodi-design.md). The TV side (Lumen's
kids view, its Kids group) is the Kodi session's design, approved by the owner the same day; this is the
app's side of the contract they share.

## Why

Kids mode has kept live TV out until now: the kids profiles in the app see no channel, and a TV in its kids
view refuses any. Several of the owner's channels are made for kids (cartoons), and the owner wants kids to
watch them, on the TV and from their own profile in the app, like their titles of the library.

## What the owner gets

- **A "For kids" switch per channel**, in Settings › Live TV, on the owner's channels. Off by default; the
  owner sets it on the cartoon channels they picked.
- **The TVs know them:** a kids channel is in its category's group and in a "Kids" group of the list both TVs
  read (`group-title="Extra;Kids"`; IPTV Simple puts it in both). Kodi's Kids group is what Lumen's kids view
  plays from.
- **Kids profiles in the app:**
  - A "TV" tab: the Live TV page with the kids channels only, the same guide, grid or list. No watching on
    the phone (VLC), as for their titles; no link to Settings.
  - Playing: when a kids channel plays on their TV, the card shows it (as on the owner's Remote) with the
    channel row, CH − and +, through the kids channels only; and their usual keys (play/pause, stop,
    volume, language, subtitles).
  - At bedtime no channel starts, as no title does ("It's bedtime").
  - A channel that isn't for kids stays hidden: "something else is playing", and its controls stay closed.

## Not in this (next, with the Kodi session)

- **A TV in its kids view** still refuses every channel. It will take the kids channels once the app starts
  channels the way Lumen needs: by their path in Kodi's Kids group (in the kids view) or its All channels
  group (otherwise), so a channel keeps the group it was started in. That waits for the Kodi session's test
  on the Pi.
- A kids channel that plays on at bedtime: as a title that plays, it isn't stopped.

## Checks

- The switch survives reordering the channels, and the list's group-title carries ";Kids".
- A kids profile: the guide holds the kids channels only; starting another channel is refused (403); at
  bedtime, every start is refused; what plays is shown when it is a kids channel, hidden otherwise; its
  remote keys work on a kids channel.
- The kids profile's TV tab and Playing card at phone width (a stand-in Kodi in the sandbox).
