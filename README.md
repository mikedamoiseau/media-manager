# Cinémathèque

A home media library you browse from your phone. It reads the films, series and anime on a NAS, matches them on TMDB, and plays them on Kodi (or in VLC on the phone). It runs on a Mac on the home network and installs on the iPhone home screen like an app.

Built for one household's setup: a Synology share mounted on a Mac, a Kodi box on LibreELEC, French and English titles side by side.

## What it does

**Browse and search**
- Poster grid of everything under the media folder, grouped by category (films, series, anime, kids, shows, fitness, courses). Two copies of the same film (1080p and 4K) show as one title.
- Instant search on French, English, original and alternate titles, director, cast and file name. A four-digit word also matches the year.
- Filters: category, decade, genre, quality and language (4K, HDR, MULTI, VF, VOSTFR), watched, in progress, needs a match, hidden.
- One switch for French or English titles and plots. Film sets (sagas) can be grouped into one tile.

**Play**
- *Play on TV* sends the file to Kodi and resumes where you stopped.
- *Play in VLC* streams the original file to the phone, with every audio and subtitle track.
- Trailers play in the app, or on the TV through Kodi's YouTube add-on.
- A Kodi remote: d-pad, play/pause, seek, volume, subtitle and audio tracks, and a now-playing bar.
- When Kodi shows its on-screen keyboard (a YouTube search, a password), the phone's keyboard comes up instead, on any screen.

**Discover**
- *Continue watching*: what you started, on Kodi or in the app.
- *Suggested for you*: unwatched titles on the NAS, from what you watched lately and the next film of a set you started.
- *Not on the NAS*: films you don't have yet, from the same tastes. Mark them *Want it* to build a *Films to get* list.
- *At the cinema*: what's showing and what's coming out soon in the country you pick, with release dates for that country.
- 👍 / 👎 on films you've watched. Likes pull suggestions their way; what TMDB pairs with a film you disliked drops down.

Each row can be turned on or off in Settings.

**Keep the library tidy**
- The NAS is rescanned every 10 minutes and on demand. New files are parsed from their release names, matched on TMDB, and given a poster, plot and trailer. Kodi is asked to update its own library too.
- Files that can't be identified with confidence go to *To review*, where one tap confirms a suggestion or you search TMDB yourself.
- Pick another poster from TMDB or upload your own. Videos with no match get a frame grabbed from the video.
- Reports: duplicate films, and sets with films missing.

## How it fits together

```
 iPhone / browser ──HTTP──▶  Mac: Node server (Hono + SQLite) + React app
                                 │
                                 ├── NAS share mounted on the Mac (/Volumes/…)
                                 ├── Kodi JSON-RPC on the LAN (library, playback, remote)
                                 ├── TMDB API (titles, posters, trailers, recommendations, cinemas)
                                 └── Google Sheet, optional (public CSV export, read only)
```

Kodi's own library comes first: it already knows most films with their TMDB ids, watched state and resume points. TMDB fills in French titles, plots, cast and trailers, and identifies files Kodi doesn't know.

The app never writes to the media folders or to the Google Sheet.

## Requirements

- **macOS.** The background service is a LaunchAgent, and a few fallbacks are macOS-specific. The server itself is plain Node and should run elsewhere, untested.
- **Node 24 or later.** The server runs TypeScript directly, with no build step. Developed on Node 25.
- **The media share mounted on the Mac**, by default at `/Volumes/video/MEDIA`.
- **A TMDB API key**, free at [themoviedb.org](https://www.themoviedb.org/settings/api).
- **Kodi** with *Settings → Services → Control → Allow remote control via HTTP* on, and *Allow remote control from applications on other systems* for typing from the phone. Tested with Kodi 21 Omega.
- Optional: `ffmpeg` (frames for videos with no poster), VLC on the phone, Kodi's YouTube add-on (trailers on the TV).

## Install

```sh
git clone https://github.com/mikedamoiseau/media-manager.git
cd media-manager
npm install
npm run build        # builds the web app into web/dist
npm start            # http://localhost:8642
```

To keep it running in the background at login:

```sh
scripts/service.sh install     # also: uninstall | restart | status
```

On the iPhone, open `http://<mac-ip>:8642` in Safari, then Share → *Add to Home Screen*. It opens full screen. The server prints its LAN address when it starts (`data/logs/server.log` when it runs as a service).

`PORT` and `MM_DATA_DIR` change the port (default 8642) and the data folder (default `./data`).

## First-time setup

Everything is in **Settings** in the app.

1. **TMDB key.** Paste the v3 key or the API Read Access Token. Matching starts as soon as it's saved.
2. **Kodi.** *Find Kodi* looks for it on the network. The app works out how Kodi sees the share (for example `smb://192.168.1.10/video/MEDIA`) from Kodi's video sources; you can override it.
3. **Media folder.** Where the share is mounted on the Mac.
4. **Google Sheet (optional).** If you keep a list of your files in a sheet, share it as *Anyone with the link can view* and paste its link. Its English and French titles help the TMDB matching, and rows with no file show under the *Only in the sheet* filter.

### Folder names

Top-level folders under the media folder set the category: `MOVIES`, `SERIES`, `ANIMES`, `KIDS`, `SHOWS`, `FITNESS`, `COURSES`. A suffix such as `MOVIES2` or `ANIMES_TEMP` shares its base folder's rule. Any other folder lands in *Other*. The rules are in `server/scanner.ts`.

## Privacy and security

- **There is no login.** Anyone on your network can open the app, play files and control Kodi. Keep it on the home network; don't expose port 8642 to the internet.
- **Secrets stay in the local database.** The TMDB key, the Kodi password and the sheet id are stored in `data/media.db`, which is git-ignored. The API masks the TMDB key and the Kodi password when it sends settings to the browser.
- **Read only where it matters.** The sheet is only fetched through its CSV export. Files on the NAS are read and streamed, never moved, renamed or deleted.

## Good to know

- **The Mac must be awake** for the phone to reach the app. For a home server, turn on System Settings → Energy → *Prevent automatic sleeping when the display is off*.
- **macOS Local Network privacy** can stop Node from reaching Kodi. The app then falls back to `/usr/bin/curl`, and Settings says so. To use the direct path, allow your terminal (or `node`, for the service) under System Settings → Privacy & Security → Local Network.
- **Share not mounted:** Settings shows it, and scanning waits until the share is back.
- **`data/` is mostly a cache**, but not only: it also holds your settings, likes, *Films to get* list and app history. Back it up if you care about those.

## Development

```sh
npm run dev:server   # API on :8642, restarts on change
npm run dev:web      # Vite on :5173, /api proxied to :8642
npm test             # node --test
npm run typecheck    # server; the web app: npx tsc --noEmit -p web/tsconfig.json
```

Stack: Node with `node:sqlite` and [Hono](https://hono.dev) on the server; React 19, Vite and [wouter](https://github.com/molefrog/wouter) in the browser; live updates over server-sent events.

| Path | What |
| --- | --- |
| `server/parse.ts` | release-name parser: title, year, alternate titles, episodes, quality badges |
| `server/scanner.ts`, `server/library.ts` | NAS walk, add/move/remove reconciliation, sheet hints |
| `server/kodi.ts`, `server/net.ts` | Kodi JSON-RPC, discovery, path mapping, player and remote |
| `server/kodiEvents.ts` | Kodi's event stream (port 9090): its on-screen keyboard |
| `server/tmdb.ts`, `server/metadata.ts` | TMDB client and matcher, Kodi library sync, enrichment |
| `server/suggestions.ts`, `server/films.ts`, `server/watching.ts` | tastes, suggestions, films not on the NAS, cinemas, continue watching |
| `server/sheet.ts` | read-only Google Sheet import |
| `server/service.ts` | jobs (scan, sheet, Kodi, TMDB), scheduling, live events |
| `server/api.ts`, `server/views.ts` | HTTP API and the compact library payload |
| `server/db.ts` | schema, migrations, settings |
| `web/src` | React app: poster grid, title and film pages, review, remote, settings |
| `tests/` | parser, sheet, scanner, matcher, suggestions, cinemas, playback |

## License

[MIT](LICENSE)

This product uses the TMDB API but is not endorsed or certified by TMDB.
