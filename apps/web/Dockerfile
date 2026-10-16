# ---- build ----
FROM node:26-bookworm-slim AS build
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
# The current stable nginx branch, plus any Alpine fixes published since the image was built.
FROM nginx:stable-alpine AS runtime
RUN apk upgrade --no-cache
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
# Which release this is (yyyy.mm.N, set by CI; "dev" when built by hand), served as /version.json so a deploy can be checked with curl.
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
RUN printf '{"version":"%s","commit":"%s"}\n' "$APP_VERSION" "$GIT_SHA" > /usr/share/nginx/html/version.json
LABEL org.opencontainers.image.version="${APP_VERSION}" org.opencontainers.image.revision="${GIT_SHA}"
EXPOSE 80
