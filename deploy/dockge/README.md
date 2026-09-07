# Deploying to Dockge

Dockge (`http://192.168.200.148:5001`) manages a `compose.yaml` + `.env` per
stack on its host. This stack builds all three app images straight from the
public GitHub repo (`build.context` is a Git URL), so nothing else needs to be
copied to the host.

## Steps

1. Dockge → **+ Compose** → name the stack `teams-voice-migration-factory`.
2. Paste [`compose.yaml`](./compose.yaml) into the compose editor.
3. Open the **.env** editor and paste the contents of
   [`.env.example`](./.env.example) **with real values** — at minimum:
   `POSTGRES_PASSWORD`, `DATABASE_URL` (same password), `JWT_ACCESS_SECRET`,
   `JWT_REFRESH_SECRET`, `DATA_ENCRYPTION_KEY`, `BOOTSTRAP_ADMIN_PASSWORD`, and
   `WEB_ORIGIN` (the URL you browse the app on).
4. **Start**. First run builds 3 images (~3–6 min) — watch the build log.
5. The `api` container runs DB migrations and creates/updates the bootstrap
   super admin on every start (idempotent), then serves on `:4000`.

## After it's up

| URL | What |
|-----|------|
| `http://<host>:5173` | The app. Sign in as `BOOTSTRAP_ADMIN_EMAIL`, enrol TOTP. |
| `http://<host>:4000/health` | API health JSON. |
| `http://<host>:8080` | Adminer (DB browser). System *PostgreSQL*, server `postgres`. |

## Updating

Push to `main`, then in Dockge use the stack's **update / rebuild** action
(pull + `--build`). BuildKit re-clones the repo for the build.

## Notes

- Ports published: `5173` (web), `4000` (api), `8080` (adminer). Postgres and
  Redis are internal to the stack network only.
- `COOKIE_SECURE=false` because this runs over plain HTTP on the LAN. Put a TLS
  reverse proxy in front and set it to `true` before any non-LAN exposure.
- No customer tenant credentials are ever stored (see `docs/SECURITY.md`); the
  worker's `MS_DEVICECODE_CLIENT_ID` only starts the live device-code sign-in.
