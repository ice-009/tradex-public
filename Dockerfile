# syntax=docker/dockerfile:1
# Tradex as a container. `docker compose up -d` (compose.yaml) runs it with a
# Market Data Hub; on its own:
#   docker build -t tradex .
#   docker run -p 127.0.0.1:3000:3000 -v tradex-data:/data -e HUB_URL=… -e HUB_KEY=… tradex
# Everything it keeps (accounts database, candle cache, generated secret) is
# under /data.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------- dependencies
# All dependencies, including dev ones for the build. better-sqlite3 is a
# native addon: prebuilt binaries cover linux amd64/arm64, the compiler is the
# fallback. Prisma needs OpenSSL to pick its engine; postinstall runs
# `prisma generate`, so the schema and config come in first.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ openssl \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------- build
# NEXT_OUTPUT=standalone (next.config.ts): .next/standalone holds server.js and
# only the node_modules files the server actually loads.
FROM deps AS build
# The context has no .git, so the commit for run stamps comes in as a build arg.
ARG TRADEX_COMMIT=dev
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=standalone \
    TRADEX_COMMIT=${TRADEX_COMMIT}
COPY . .
RUN npm run build

# ---------------------------------------------------------------- prisma CLI
# The standalone output has no Prisma CLI, which the start script needs for
# `prisma db push`. Install just the CLI (and dotenv, which prisma.config.ts
# imports) at the versions in package-lock.json, beside the config and schema.
FROM deps AS prisma-cli
RUN mkdir -p /opt/prisma/prisma \
 && node -e "const v = (n) => require('/app/node_modules/' + n + '/package.json').version; require('fs').writeFileSync('/opt/prisma/package.json', JSON.stringify({ private: true, dependencies: { prisma: v('prisma'), dotenv: v('dotenv') } }))" \
 && cd /opt/prisma \
 && npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force
COPY prisma.config.ts /opt/prisma/
COPY prisma/schema.prisma /opt/prisma/prisma/

# ---------------------------------------------------------------- runtime
# No compilers, no source, non-root.
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_URL=file:/data/tradex.db \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
WORKDIR /app
COPY --from=prisma-cli /opt/prisma /opt/prisma
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY docker/entrypoint.sh /usr/local/bin/tradex-entrypoint
# /data is the volume (owned by the app user so a new named volume is too).
# The app keeps its caches in ./.cache, which points into it.
RUN chmod 0755 /usr/local/bin/tradex-entrypoint \
 && mkdir -p /data .next/cache \
 && chown node:node /data .next/cache \
 && ln -s /data/cache /app/.cache
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
ENTRYPOINT ["tradex-entrypoint"]
CMD ["node", "server.js"]
