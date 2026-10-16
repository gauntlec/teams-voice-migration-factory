# ---- build ---------------------------------------------------------------
FROM node:26-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
# Only this service's own dependencies (not the web app's or the MCP tool's), which keeps the image small and its advisories relevant.
RUN npm install --workspace @tvmf/worker
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN npm run build:packages && npm run build --workspace @tvmf/worker
# The runtime image carries production dependencies only (no test runner, compiler or bundler).
RUN npm prune --omit=dev --workspace @tvmf/worker

# ---- runtime ----------------------------------------------------------
# PowerShell 7 + the MicrosoftTeams module (Discovery and deployments drive
# it over an engineer's device-code sign-in) + Microsoft.Graph.Authentication
# (an optional second, read-only device-code sign-in for M365 group lookup),
# plus Node 20 for the worker itself. TEAMS_EXECUTOR=simulated skips pwsh entirely.
FROM mcr.microsoft.com/powershell:7.4-debian-12 AS runtime
ENV NODE_ENV=production \
    POWERSHELL_TELEMETRY_OPTOUT=1 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1
# upgrade: pick up fixes Debian has published since this (older) base image was built.
RUN apt-get update && apt-get upgrade -y --no-install-recommends && apt-get install -y --no-install-recommends ca-certificates libatomic1 \
  && rm -rf /var/lib/apt/lists/*
# (libatomic1: the Node binary links it and the PowerShell base does not include it.)
# Node comes from the official node image (the same one the other images are built on), not from a downloaded install script. The
# build fails here, not at run time, if the binary cannot start on this base.
COPY --from=node:26-bookworm-slim /usr/local/bin/node /usr/local/bin/node
RUN node --version
# Pinned so production always installs the exact, already-verified-working
# module version (day-one pin = whatever was running live when this was
# introduced) instead of silently grabbing whatever's newest on PSGallery on
# every deploy. Bump only via a manual PR after checking the weekly
# :candidate build below - see docs/SECURITY.md.
#
# Either ARG can be left blank to fall back to "install whatever's newest" -
# only the weekly candidate build (build-images.yml) does that, deliberately,
# so upstream breakage surfaces on a non-production :candidate tag before
# anyone considers bumping the pin.
ARG TEAMS_MODULE_VERSION=8.0.0
ARG GRAPH_MODULE_VERSION=2.40.0
# Only needed to force a real reinstall for the unpinned candidate build -
# the pinned production path is deterministic (same version every time) and
# doesn't need its cache busted.
ARG CACHE_BUST=0
RUN pwsh -NoLogo -NonInteractive -Command \
    "Write-Output 'cache bust: ${CACHE_BUST}'; \
     Set-PSRepository -Name PSGallery -InstallationPolicy Trusted; \
     \$teamsArgs = @{ Name = 'MicrosoftTeams'; Scope = 'AllUsers'; Force = \$true; AcceptLicense = \$true }; \
     if ('${TEAMS_MODULE_VERSION}') { \$teamsArgs.RequiredVersion = '${TEAMS_MODULE_VERSION}' }; \
     Install-Module @teamsArgs; \
     \$graphArgs = @{ Name = 'Microsoft.Graph.Authentication'; Scope = 'AllUsers'; Force = \$true; AcceptLicense = \$true }; \
     if ('${GRAPH_MODULE_VERSION}') { \$graphArgs.RequiredVersion = '${GRAPH_MODULE_VERSION}' }; \
     Install-Module @graphArgs; \
     Import-Module MicrosoftTeams; Import-Module Microsoft.Graph.Authentication; \
     (Get-Module MicrosoftTeams).Version.ToString(); (Get-Module Microsoft.Graph.Authentication).Version.ToString()"
# Visible without shelling in (docker inspect, or the Dockge UI's image tab).
LABEL com.voxshift.microsoftteams-version="${TEAMS_MODULE_VERSION}" \
      com.voxshift.graph-authentication-version="${GRAPH_MODULE_VERSION}"
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
# Unprivileged user (PowerShell and the Teams module keep their per-user state in its home directory).
RUN useradd --create-home --uid 1000 --shell /usr/sbin/nologin voxshift
USER voxshift
# Which release this is (yyyy.mm.N, set by CI; "dev" when built by hand), shown in Platform settings and sent to a Voxshift Hub. Last on purpose: it changes every build.
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ENV APP_VERSION=${APP_VERSION} APP_GIT_SHA=${GIT_SHA}
LABEL org.opencontainers.image.version="${APP_VERSION}" org.opencontainers.image.revision="${GIT_SHA}"
CMD ["node", "apps/worker/dist/main.js"]
