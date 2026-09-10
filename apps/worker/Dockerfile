# ---- build ---------------------------------------------------------------
FROM node:20-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm install
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN npm run build:packages && npm run build --workspace @tvmf/worker

# ---- runtime ----------------------------------------------------------
# PowerShell 7 + the MicrosoftTeams module (Discovery and, later, real
# deployments drive it over an engineer's device-code sign-in), plus Node 20
# for the worker itself. TEAMS_EXECUTOR=simulated skips pwsh entirely.
FROM mcr.microsoft.com/powershell:7.4-debian-12 AS runtime
ENV NODE_ENV=production \
    POWERSHELL_TELEMETRY_OPTOUT=1 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && apt-get purge -y gnupg && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
RUN pwsh -NoLogo -NonInteractive -Command \
    "Set-PSRepository -Name PSGallery -InstallationPolicy Trusted; \
     Install-Module -Name MicrosoftTeams -Scope AllUsers -Force -AcceptLicense; \
     Install-Module -Name Microsoft.Graph.Authentication -Scope AllUsers -Force -AcceptLicense; \
     Import-Module MicrosoftTeams; Import-Module Microsoft.Graph.Authentication; \
     (Get-Module MicrosoftTeams).Version.ToString(); (Get-Module Microsoft.Graph.Authentication).Version.ToString()"
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
CMD ["node", "apps/worker/dist/main.js"]
