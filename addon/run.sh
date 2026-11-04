#!/bin/sh
# Home Assistant starts the add-on here. On the first start only (no library in /data yet), a library brought
# over from another machine is taken from the first of these folders that has one: media.db (a `sqlite3 .backup`
# copy) and the posters/ folder; img/ and thumbs/ are optional, the app fetches them again.
set -e
for from in /share/cinematheque /media/nas_video/IPTV/cinematheque_import; do
  if [ ! -f /data/media.db ] && [ -f "$from/media.db" ]; then
    echo "First start: taking the library from $from"
    # Copied aside first, and media.db moved in last: if the copy breaks off, the next start tries again.
    rm -rf /data/.import
    cp -R "$from" /data/.import
    for f in /data/.import/*; do
      # Anything already there is from an import that broke off (no media.db yet): replaced.
      [ "$f" = /data/.import/media.db ] || { rm -rf "/data/${f##*/}"; mv "$f" /data/; }
    done
    mv /data/.import/media.db /data/
    # Left: hidden files a Mac adds (.DS_Store).
    rm -rf /data/.import
  fi
done
exec node server/index.ts
