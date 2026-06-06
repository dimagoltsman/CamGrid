FROM node:20-bookworm-slim

# ffmpeg for go2rtc's transcode paths; curl/ca-certs to fetch go2rtc.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# go2rtc — the streaming engine (RTSP -> WebRTC/MSE). Single static binary.
ARG GO2RTC_VERSION=1.9.9
ARG TARGETARCH
RUN curl -fsSL "https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/go2rtc_linux_${TARGETARCH:-amd64}" \
      -o /usr/local/bin/go2rtc \
 && chmod +x /usr/local/bin/go2rtc

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY server ./server
COPY web ./web

ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000
VOLUME /data

CMD ["node", "server/index.js"]
