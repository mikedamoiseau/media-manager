# Roadmap

Feature ideas for Cinémathèque, best first. Each one goes through a design
discussion before it is built.

| # | Feature | Size | Status |
|---|---------|------|--------|
| 1 | Who's watching (profiles) | Medium | Done: [design](superpowers/specs/2026-10-26-profiles-design.md) |
| 2 | Kids mode | Medium | Done in the app: [design](superpowers/specs/2026-10-26-kids-mode-design.md) |
| 3 | Series tracker | Medium | Done: [design](superpowers/specs/2026-10-29-series-tracker-coming-soon-design.md) |
| 4 | Trailer on the TV | Small | Already in the app |
| 5 | Up next queue and sleep timer | Small to medium | Done |
| 6 | Coming soon | Medium | Done: [design](superpowers/specs/2026-10-29-series-tracker-coming-soon-design.md) |
| 7 | Your year in film | Small to medium | Idea |
| 8 | Live TV | Large | Done: [design](superpowers/specs/2026-10-28-live-tv-design.md) |
| 9 | Move the app off the M1 | Medium | Idea (parked) |

## 1. Who's watching (profiles)

Several Kodi TVs now share one library, so everyone's watched marks and
resume points end up mixed together. Each phone or tablet picks who is
watching, and that person gets their own Continue watching, ratings and
suggestions.

Done: "Who's watching?" on each device's first open, a badge on every screen
to switch, and Settings › Profiles to add, rename, recolour or remove someone.
Plays started with the TV's own remote go to the main profile.

## 2. Kids mode

A locked view that shows only kids' and family-rated titles, with big
posters and one tap to play on the chosen TV. It hides settings and the power
menu, and needs a PIN to leave. An optional bedtime stops playback at the end
of the current film or episode after a set hour. It fits well with profiles:
a kids' profile could open in this mode.

Done: a profile can be a kids profile (an FSK age limit, an optional bedtime).
On a phone in kids mode the app shows only that kid's titles (made for kids
and within age, from TMDB's ratings, or a parent's "OK for kids"), a simple
now playing card, and asks the parents' code to leave. After bedtime nothing
new starts and Kodi doesn't go on to the next episode. The titles every kid
may watch carry the tag `Cinematheque Kids` in Kodi's library; the kids view
on the TV itself is the Lumen skin's to build. While a TV is in that kids view
(Lumen's `CinemathequeKids` setting), what plays there counts as the kid's.

## 3. Series tracker

For each series on the NAS, compare the episodes on disk with TMDB and show
what is missing ("S02E05–E08 missing") or new ("Season 3 is out"). Missing
episodes feed a list of episodes to get, like "Films to get" does for films.

Done: a series page says which aired episodes aren't on the NAS and what
comes next, with a switch to follow the show. Shows in the SERIES folders are
followed to begin with. Settings › Lists › Episodes to get lists every
followed show with episodes missing. Files named for several episodes
(`S01E09E10`) count for each.

## 4. Trailer on the TV

Already in the app: a title page's trailer has "Play trailer on TV", through
Kodi's YouTube add-on. Each Kodi box needs that add-on.

## 5. Up next queue and sleep timer

Line up a few episodes or films to play one after another on a chosen TV.
Add "stop after this episode" or "stop in 45 minutes".

Done: a film or series page has an Up next button (a series adds its next
episode on each tap), and each episode row can add that episode. The Remote
lists the TV's Up next: tap one to play it now, or take it out. When a film
or episode plays to its end, the next one starts, from where whoever added it
stopped. The moon on the Remote's card sets a sleep timer: after this one, or
in 15 to 90 minutes. A list nobody touched for 6 hours is cleared. Both need
the app running (see item 9).

## 6. Coming soon

A row of sequels to films you own or liked, new seasons of your series, and
upcoming cinema releases in your country. Each can have a "remind me" that
adds it to the to-get lists once it is out.

Done: a "Coming soon" row after "At the cinema", soonest first. It shows:

- the next season of a followed show;
- films not out yet in sets with a film on the NAS;
- films coming to cinemas;
- films with a reminder.

On a film not out yet, "Want it" reads "Remind me". Films to get keeps such
films under "Reminders" until their release day.

## 7. Your year in film

Hours watched, favourite genres, most-watched actors, and which TV gets used
most.

## 8. Live TV

French and Belgian channels from iptv-org, with a TV guide, started on a
Kodi TV or watched on the phone in VLC.

Done: a Live TV tab (grid or list), the owner's channels picked and ordered
in Settings › Live TV, written to the channel list both TVs read.

## 9. Move the app off the M1

The app runs on the M1, a personal machine, and stops when it sleeps or
restarts. The owner would rather have it on the Mac mini that runs Home
Assistant OS. There, everything runs as a container (an add-on), and the
owner said "ideally no Docker" there. That box has plenty of room, but a
locally built add-on would be copied into every Home Assistant backup
(about 68 MB, daily, in three places). This is a project of its own, to
discuss first: see the parked note in the
[Live TV design](superpowers/specs/2026-10-28-live-tv-design.md).
