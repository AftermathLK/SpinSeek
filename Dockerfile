# syntax=docker/dockerfile:1

# Node 22 LTS. Build stage and runtime stage MUST use the same image so the
# better-sqlite3 native binary (Node ABI + musl libc) matches at runtime.
ARG NODE_VERSION=22

# ---- Build stage: compile the Vite React client and the TypeScript server ----
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
# better-sqlite3 downloads a prebuilt linuxmusl binary when one exists; if not
# (new Node release, no network to GitHub), it compiles from source with node-gyp,
# which needs Python, make and a C++ toolchain.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.client.json tsconfig.server.json vite.config.ts tailwind.config.js ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev --no-audit --no-fund \
    && node -e "require('better-sqlite3')(':memory:').prepare('select 1').get()"

# ---- Runtime stage ----
FROM node:${NODE_VERSION}-alpine AS runtime
# tzdata: honour TZ. su-exec: drop from root to PUID:PGID after fixing /config ownership.
RUN apk add --no-cache tzdata su-exec
ENV NODE_ENV=production \
    PORT=3080 \
    CONFIG_DIR=/config \
    PUID=99 \
    PGID=100 \
    UMASK=022 \
    TZ=Etc/UTC
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Strip CRLF in case the file was edited/checked out on Windows.
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod 755 /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /config
VOLUME ["/config"]
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3080}/api/health" >/dev/null 2>&1 || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server/index.js"]
