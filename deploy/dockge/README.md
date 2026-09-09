# Deploying to Dockge

Dockge (`http://192.168.200.148:5001`) manages a `compose.yaml` + `.env` per
stack on its host. Images are prebuilt by GitHub Actions and pulled from GHCR,
so nothing is compiled on the Dockge host.

## One-time setup

1. **GitHub Action:** `.github/workflows/build-images.yml` builds and pushes
   `ghcr.io/gauntlec/tvmf-{api,worker,web}` on every push to `main`.
2. **Make the packages public** so Dockge can pull without credentials:
   GitHub → your profile → **Packages** → open each of `tvmf-api`,
   `tvmf-worker`, `tvmf-web` → **Package settings** → **Change visibility** →
   Public. (Do this after the first Action run creates them.)
3. **Create the stack in Dockge:** + Compose → name `teams-voice-migration-factory`
   → paste [`compose.yaml`](./compose.yaml) → paste [`.env.example`](./.env.example)
   with real values into the `.env` editor → **Start**.
   - Real values needed: `POSTGRES_PASSWORD`, `DATABASE_URL` (same password),
     `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `DATA_ENCRYPTION_KEY`,
     `BOOTSTRAP_ADMIN_PASSWORD`, `WEB_ORIGIN`.
   - Optional (email): `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`,
     `SMTP_PASS` (`MAIL_FROM` defaults to `no-reply@voxshift.io`). Leave
     `SMTP_HOST` empty to disable delivery — the worker then logs each message
     instead. See [`docs/EMAIL.md`](../../docs/EMAIL.md).
4. The `api` container runs DB migrations (platform **and** every tenant
   schema) and upserts the bootstrap super admin on each start. The `worker`
   container sends queued email and runs Discovery / deployments against
   customer tenants.
5. **Worker image is PowerShell-based** (`mcr.microsoft.com/powershell` + Node +
   the MicrosoftTeams module, ~1 GB) so Discovery can drive the Teams PowerShell
   module. It builds slower than the others. Optional env: `TEAMS_EXECUTOR=pwsh`
   (default) or `simulated` (fake data, no Microsoft calls), and
   `TEAMS_SESSION_TTL_MINUTES=60`. Running a Discovery needs an engineer with a
   **Teams Administrator** account in the customer tenant — they sign in with a
   device code each time; nothing is stored. See [`docs/DISCOVERY.md`](../../docs/DISCOVERY.md).

## Redeploy loop

```
git push origin main         # ~5 min: GitHub Action builds + pushes images
                             # Dockge → stack → Update   (pulls :latest, ~30 s)
```

`Restart` just restarts the containers (no pull). `Update` = pull + recreate.

## After it's up

| URL | What |
|-----|------|
| `http://<host>:5173` | The app. Sign in as `BOOTSTRAP_ADMIN_EMAIL`, enrol TOTP. |
| `http://<host>:4000/health` | API health JSON (`epoch` should track real time — TOTP needs it within ~60 s). |
| `http://<host>:8080` | Adminer. System *PostgreSQL*, server `postgres`, user/db `tvmf`. |

## Notes

- Ports published: `5173` (web), `4000` (api), `8080` (adminer). Postgres and
  Redis are internal to the stack network only.
- Images are `linux/amd64`. If the Dockge host is arm64, add `linux/arm64` to
  the `platforms:` line in the workflow.
- `COOKIE_SECURE=false` — LAN HTTP only. Put TLS in front and set it `true`
  before any non-LAN exposure.
- No customer tenant credentials are ever stored (see `docs/SECURITY.md`).
