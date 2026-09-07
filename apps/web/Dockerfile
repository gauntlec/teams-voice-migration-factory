# ---- build ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
# --ignore-scripts: skip native builds (argon2 etc.) we don't need here.
# esbuild / rollup resolve their platform binaries via optional deps.
RUN npm install --ignore-scripts
COPY packages ./packages
COPY apps/web ./apps/web
RUN npm run build --workspace @tvmf/shared && npm run build --workspace @tvmf/web

# ---- serve ----
FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
