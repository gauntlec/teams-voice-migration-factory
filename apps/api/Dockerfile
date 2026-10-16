# ---- build ---------------------------------------------------------------
FROM node:26-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install with the full workspace context so @tvmf/* resolve.
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm install

COPY packages ./packages
COPY apps/api ./apps/api
RUN npm run build:packages && npm run build --workspace @tvmf/api
# The runtime image carries production dependencies only (no test runner, compiler or bundler).
RUN npm prune --omit=dev

# ---- runtime ------------------------------------------------------------
FROM node:26-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
# Which release this is (yyyy.mm.N, set by CI; "dev" when built by hand). Last on purpose: it changes every build.
# Runs as the unprivileged "node" user. The entrypoint starts as root only to hand an older, root-owned files volume to that user once,
# then drops root for the whole process (see docker-entrypoint.sh).
RUN mkdir -p /data/files && chown node:node /data/files && setpriv --version >/dev/null
COPY --chmod=755 apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ENV APP_VERSION=${APP_VERSION} APP_GIT_SHA=${GIT_SHA}
LABEL org.opencontainers.image.version="${APP_VERSION}" org.opencontainers.image.revision="${GIT_SHA}"
EXPOSE 4000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "apps/api/dist/main.js"]
