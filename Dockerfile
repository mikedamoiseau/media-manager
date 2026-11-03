# The app as a Home Assistant add-on (see addon/). Built and published by .github/workflows/addon.yml.

FROM node:26-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.ts tsconfig.json ./
COPY web web
RUN npm run build

FROM node:26-alpine
# ffmpeg: frames for films with no poster. curl and nc: the fallbacks in server/net.ts and server/kodiEvents.ts
# (a macOS workaround that a TV off the network can also trigger here).
RUN apk add --no-cache ffmpeg curl netcat-openbsd
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server server
COPY --from=web /app/web/dist web/dist
COPY addon/run.sh /run.sh
ENV MM_DATA_DIR=/data PORT=8642
ARG VERSION=dev
LABEL io.hass.type="addon" io.hass.arch="amd64" io.hass.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/mikedamoiseau/media-manager"
CMD ["/bin/sh", "/run.sh"]
