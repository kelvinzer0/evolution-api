FROM node:24-alpine AS builder

RUN apk update && \
    apk add --no-cache git ffmpeg wget curl bash openssl \
    chromium nss freetype harfbuzz ttf-freefont

LABEL version="2.3.7-catalog-browser" description="Api to control whatsapp features through http requests. Adds browser-based catalog fetch provider."
LABEL maintainer="Kelvin Yuli Andrian" git="https://github.com/kelvinzer0/evolution-api"
LABEL contact="kelvinzer0@users.noreply.github.com"

# Tell Puppeteer to use system Chromium instead of downloading its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /evolution

COPY ./package*.json ./
COPY ./tsconfig.json ./
COPY ./tsup.config.ts ./

RUN npm ci --silent

COPY ./src ./src
COPY ./public ./public
COPY ./prisma ./prisma
COPY ./manager ./manager
COPY ./.env.example ./.env
COPY ./runWithProvider.js ./

COPY ./Docker ./Docker

RUN chmod +x ./Docker/scripts/* && dos2unix ./Docker/scripts/*

RUN ./Docker/scripts/generate_database.sh

RUN npm run build

FROM node:24-alpine AS final

RUN apk update && \
    apk add --no-cache tzdata ffmpeg bash openssl \
    chromium nss freetype harfbuzz ttf-freefont font-noto-emoji

# Install Poppins Bold font for watermark rendering (sharp/librsvg uses fontconfig)
# Source: Google Fonts (OFL license) — https://fonts.google.com/specimen/Poppins
RUN mkdir -p /usr/share/fonts/truetype/poppins && \
    wget -q -O /usr/share/fonts/truetype/poppins/Poppins-Bold.ttf \
      "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Bold.ttf" && \
    fc-cache -f

ENV TZ=America/Sao_Paulo
ENV DOCKER_ENV=true

# Puppeteer config — use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Catalog Browser Service config (overridable at runtime)
ENV CATALOG_BROWSER_ENABLED=false
ENV CATALOG_BROWSER_IDLE_TIMEOUT_MS=600000
ENV CATALOG_BROWSER_MAX_SESSIONS=5
ENV CATALOG_BROWSER_HEADLESS=true

WORKDIR /evolution

COPY --from=builder /evolution/package.json ./package.json
COPY --from=builder /evolution/package-lock.json ./package-lock.json

COPY --from=builder /evolution/node_modules ./node_modules
COPY --from=builder /evolution/dist ./dist
COPY --from=builder /evolution/prisma ./prisma
COPY --from=builder /evolution/manager ./manager
COPY --from=builder /evolution/public ./public
COPY --from=builder /evolution/.env ./.env
COPY --from=builder /evolution/Docker ./Docker
COPY --from=builder /evolution/runWithProvider.js ./runWithProvider.js
COPY --from=builder /evolution/tsup.config.ts ./tsup.config.ts

ENV DOCKER_ENV=true

EXPOSE 8080

ENTRYPOINT ["/bin/bash", "-c", ". ./Docker/scripts/deploy_database.sh && npm run start:prod" ]
