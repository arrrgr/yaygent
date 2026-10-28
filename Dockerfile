# Stage 1: Build
FROM node:22-slim AS build

WORKDIR /app

# Set BEFORE npm ci: without it the build stage downloads ~150MB of Playwright browsers
# on every deploy and then throws them away (the run stage uses the system chromium).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json* ./
RUN npm ci

COPY src/ ./src/
COPY tsconfig.json ./

# Compile, then drop typescript/vitest/tsx/@types so the run stage ships prod deps only.
RUN npx tsc && npm prune --omit=dev

# Stage 2: Run
FROM node:22-slim AS run

WORKDIR /app

# Install Chromium system dependencies for Playwright (Debian/slim)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    libglib2.0-0 \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libxshmfence1 \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Tell Playwright to use the system Chromium instead of downloading its own.
# PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH is not a Playwright variable - pool.ts reads it.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY templates/ ./templates/

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/index.js"]
