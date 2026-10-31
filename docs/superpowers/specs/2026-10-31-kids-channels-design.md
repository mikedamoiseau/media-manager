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

## Starting a channel by its path (second part, after the Kodi session's test on the Pi)

Kodi plays a channel inside a group, and the TV's own CH − / + and ↑ / ↓ then stay in that group. Started by
its channel id, a channel plays in whichever group the TV last opened. The app now starts every channel by its
path, so it plays in the group it should:

- **The Kids group** when a kids profile starts it, or when the TV shows its kids view: the TV's own keys then
  go through the kids channels only. A TV in its kids view takes the kids channels, and still refuses the
  others ("This TV is showing its kids view").
- **The box's all-channels group** otherwise, so the owner's keys go along the owner's numbering.

The path, as the Kodi session measured it on the Pi (2026-10-31) and read in Kodi's code:
`pvr://channels/tv/<group label, %-encoded>@<group client id>/<instance id>@<add-on id>_<channel unique id>.pvr`.

- The all-channels group's client id is always -1. Its label is the box's own, in its language ("All
  channels" on the Pi), read each time from `PVR.GetChannelGroupDetails` on `alltv`.
- The Kids group's client id is the IPTV Simple client's. The group is found by its label in
  `PVR.GetChannelGroups`.
- The instance id and add-on id come from `PVR.GetClients`, for the channel's client. The unique id comes from
  the group's channels. All of these are read at each start: they are each box's own, and the client id can
  change after a reinstall.
- A TV whose Kids group doesn't have the channel yet (it hasn't read the new list) says so, as for a channel
  it doesn't have.

## Not in this

- A kids channel that plays on at bedtime: as a title that plays, it isn't stopped.

## Checks

- The switch survives reordering the channels, and the list's group-title carries ";Kids".
- A kids profile: the guide holds the kids channels only; starting another channel is refused (403); at
  bedtime, every start is refused; what plays is shown when it is a kids channel, hidden otherwise; its
  remote keys work on a kids channel.
- The kids profile's TV tab and Playing card at phone width (a stand-in Kodi in the sandbox).
- A start by path: the all-channels group's own label and -1; the Kids group's id and the client's id; the
  client's instance id, never its client id, in the second part; a kids channel in the kids view, another
  refused; a Kids group without the channel.
