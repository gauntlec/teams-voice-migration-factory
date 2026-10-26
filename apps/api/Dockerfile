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
# Only this service's own dependencies (not the web app's or the MCP tool's), which keeps the image small and its advisories relevant.
RUN npm install --workspace @tvmf/api

COPY packages ./packages
COPY apps/api ./apps/api
RUN npm run build:packages && npm run build --workspace @tvmf/api
# The runtime image carries production dependencies only (no test runner, compiler or bundler).
RUN npm prune --omit=dev --workspace @tvmf/api
# npm puts a dependency in this service's own node_modules folder when another package in the tree needs a different version of it (the API needs jose 5,
# the MCP tool pulls in jose 6). That folder must reach the runtime image, so make sure it exists to copy.
RUN mkdir -p apps/api/node_modules

# ---- runtime ------------------------------------------------------------
FROM node:26-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Pick up fixes Debian has published since the base image was built, and drop npm/corepack: nothing runs them here, and they bring
# their own bundled packages (and advisories) along.
# Debian's security index: BuildKit re-fetches a remote ADD and only reuses the layer when the file is unchanged, so this line makes the
# upgrade below run again whenever Debian publishes a security update (a cached upgrade layer would otherwise keep old packages).
ADD https://security.debian.org/debian-security/dists/bookworm-security/InRelease /tmp/debian-security-InRelease
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/* /tmp/debian-security-InRelease \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
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
