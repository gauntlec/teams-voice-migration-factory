# Versions

Voxshift releases are numbered **`yyyy.mm.N`**: the year and month of the build (UTC), then a release counter that **starts at 1 each month**.
`2026.10.1`, `2026.10.2`, ... then `2026.11.1` in November.

## How a release is made

Every push to `main` that changes more than documentation is a release (pushes that only touch `docs/**` or `*.md` do not build). The `build-images` workflow:

1. **`version`** works out the next number once, from the existing `v<yyyy.mm.N>` git tags (the three image builds run in parallel and must agree).
2. **`build`** builds the api, worker and web images with `APP_VERSION=<number>` and `GIT_SHA=<commit>`, and pushes them as `:latest`, **`:<number>`** (for example `ghcr.io/gauntlec/tvmf-api:2026.10.3`) and `:sha-<commit>`.
3. **`release`**, only after all three images are pushed, tags the commit `v<number>` and publishes a GitHub release with generated notes. A failed build therefore never uses up a number.

## Where the number shows

| | |
|---|---|
| Administration > Platform settings | "Voxshift 2026.10.3" under the title |
| `GET /health` on the web address (Voxshift) or `GET /api/health` (the hub) | `"version": "2026.10.3"` |
| `GET /version.json` on the web address | `{"version":"2026.10.3","commit":"<sha>"}`: the quickest check that a deploy landed, never cached |
| A Voxshift Hub's instance list | the version each instance reports, once a minute |
| `docker inspect` | image labels `org.opencontainers.image.version` and `.revision` |

A hand-built image (no CI) reports `dev`.

## Pinning and rolling back

The compose files use `:latest`. To pin a host to a release, or go back to one, change the image tags to that number (for example `tvmf-api:2026.10.2`, and the same for `tvmf-worker` and `tvmf-web`) and Deploy. Database migrations only move forward, so rolling back across a release that added a migration is not supported without a backup restore.
