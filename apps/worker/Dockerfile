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
# For real deployments swap this base for one with PowerShell + the
# MicrosoftTeams module, e.g.:
#   FROM mcr.microsoft.com/powershell:7.4-debian-12 AS runtime
#   RUN pwsh -c "Install-Module MicrosoftTeams -Scope AllUsers -Force"
#   ...and install Node 20 alongside it.
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
CMD ["node", "apps/worker/dist/main.js"]
