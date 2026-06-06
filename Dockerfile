# =================================================================
# YT Studio v1.0 — Combined Waz Clipper + Bulk YT Downloader
#
# Stack:
#   - Node 20 (slim) + Express + googleapis
#   - yt-dlp (Python venv) — POT (bgutil) REMOVED per user request
#   - Pillow + libraqm + harfbuzz + fribidi (for Bengali title rendering)
#   - BtbN ffmpeg GPL build (libass, harfbuzz, freetype)
#   - Deno 2.x — REQUIRED for YouTube JS challenge (n-sig solver)
#   - Xray-core — VMess/VLESS/Trojan/SS/SOCKS5 tunnel
# =================================================================
FROM node:20-bookworm-slim

ARG APP_VERSION=1.0.0
ARG BUST_CACHE=2026-05-13-yt-studio-v1.0
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    COOKIES_FILE=/app/data/cookies/cookies.txt \
    OUTPUT_DIR=/app/data/output \
    TEMP_DIR=/tmp/waz \
    CONFIG_FILE=/app/data/config.json

RUN echo "Building YT Studio v${APP_VERSION} (cache=${BUST_CACHE})" && \
    apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv python3-dev \
        curl xz-utils unzip ca-certificates \
        fonts-noto fonts-noto-cjk fonts-beng fonts-beng-extra fonts-noto-color-emoji \
        fontconfig \
        libraqm0 libraqm-dev \
        libfreetype6 libfreetype6-dev \
        libharfbuzz0b libharfbuzz-dev \
        libfribidi0 libfribidi-dev \
        libjpeg-dev zlib1g-dev libpng-dev \
        build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f

# ---- BtbN ffmpeg (with libass, harfbuzz, freetype) ----
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64)  url="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz" ;; \
      aarch64) url="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linuxarm64-gpl.tar.xz" ;; \
      *) echo "Unsupported arch: $arch"; exit 1 ;; \
    esac; \
    curl -fsSL "$url" -o /tmp/ffmpeg.tar.xz; \
    mkdir -p /tmp/ffmpeg && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg --strip-components=1; \
    install -m 755 /tmp/ffmpeg/bin/ffmpeg  /usr/local/bin/ffmpeg; \
    install -m 755 /tmp/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe; \
    rm -rf /tmp/ffmpeg /tmp/ffmpeg.tar.xz; \
    /usr/local/bin/ffmpeg -version | head -n 3

# ---- Xray-core ----
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64)  xarch="64" ;; \
      aarch64) xarch="arm64-v8a" ;; \
      *) echo "Unsupported arch: $arch"; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-${xarch}.zip" -o /tmp/xray.zip; \
    unzip -j /tmp/xray.zip xray -d /usr/local/bin/; \
    chmod +x /usr/local/bin/xray; \
    rm /tmp/xray.zip; \
    /usr/local/bin/xray version | head -1

# ---- Python venv: Pillow with Raqm + yt-dlp (NO bgutil-pot-provider) ----
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \
 && /opt/venv/bin/pip install --no-cache-dir cmake ninja pybind11 \
 && /opt/venv/bin/pip install --no-cache-dir --no-binary Pillow --force-reinstall Pillow \
 && /opt/venv/bin/pip install --no-cache-dir -U "yt-dlp[default]" \
 && /opt/venv/bin/yt-dlp --version \
 && echo "=== VERIFYING PILLOW + RAQM ===" \
 && /opt/venv/bin/python3 -c "from PIL import features; assert features.check('raqm'), 'raqm NOT enabled!'; print('✓ raqm:', features.check('raqm')); print('✓ freetype:', features.check('freetype2')); print('✓ fribidi:', features.check('fribidi'))"

ENV PATH="/opt/venv/bin:${PATH}"

# ---- Deno 2.x ----
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
 && deno --version

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN ls -la src/public/fonts/ && \
    fc-cache -fv src/public/fonts/ && \
    fc-list :lang=bn | head -10

RUN mkdir -p /app/data/output /app/data/cookies /tmp/waz \
 && chmod -R 777 /app/data /tmp/waz

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s \
  CMD curl -fsS http://localhost:3000/health || exit 1

CMD ["sh", "-c", "echo '🔄 Updating yt-dlp...' && yt-dlp -U 2>&1 | head -3 || true; echo '⚡ Deno:'; deno --version | head -1; node src/server.js"]
