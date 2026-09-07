# Security model

## Non-negotiables (from the project brief)

1. **No customer tenant credentials are ever stored.** Not in Postgres, not in
   Redis, not in env, not in logs. An engineer signs in live (device-code flow)
   each time a connection is needed; tokens exist only in worker memory with a
   hard TTL and are wiped on completion/timeout/restart.
2. **No data is shared between customers.** Schema-per-tenant + a single
   resolution point for the target schema per request (see below).
3. **Every change made to any customer tenant is audited** — one row per cmdlet
   in that tenant's `deployment_changes`, immutable (append-only; no UPDATE/DELETE
   grants for the app role).

## Tenant isolation

- DB user used by the app has `USAGE`/`CREATE` on `platform` and on tenant
  schemas, but the application code only ever reaches tenant tables through
  `tenantDb(db, schema)` which calls Kysely `.withSchema()`. There is no
  `selectFrom('build_users')` without a schema anywhere — enforced by lint rule
  and code review.
- `TenantGuard` resolves the schema from the membership row, not from anything
  the client sends except the tenant id, which is then checked against
  memberships.
- Cross-tenant queries are only possible in `platform`-scoped admin endpoints,
  all gated by `audit:read:platform` / `user:*` / `tenant:*` (super admin only).

## Authentication

- Passwords: Argon2id (`argon2` lib, memoryCost 19456, timeCost 2, parallelism 1).
- MFA: TOTP mandatory. A user with `totp_enrolled = false` can only call the
  enrol/verify endpoints; every other endpoint returns 403 until enrolled.
- Tokens: short-lived access JWT (default 15 min) returned in the JSON body and
  held in memory by the SPA; rotating refresh token in an `HttpOnly`, `Secure`,
  `SameSite=Lax` cookie, one row per session in `auth_sessions` so it can be
  revoked. Refresh rotates the token and detects reuse (revoke the family).
- Lockout: 10 failed password attempts in 15 min locks the account for 15 min.

## Secrets & crypto

- `DATA_ENCRYPTION_KEY` (AES-256-GCM) encrypts *queued job payloads only* while
  they sit in Redis (they can contain UPNs and phone numbers, not credentials).
- All secrets come from env / Docker secrets. `.env` is git-ignored;
  `.env.example` documents every key.

## Transport & headers

- API sets `helmet` defaults, strict CORS to `WEB_ORIGIN`, `X-Tenant-Id` is the
  only custom request header accepted.
- In production terminate TLS at a reverse proxy in front of `web`; set
  `COOKIE_SECURE=true`.

## Audit

- `platform_audit_log`: auth events, user/tenant admin actions, membership
  changes, connection start/stop.
- tenant `audit_log`: module-level actions (discovery submitted, build row
  changed, deployment started, handover generated).
- tenant `deployment_changes`: the fine-grained per-cmdlet record. Written by the
  worker as it runs. Parameters are stored with a redaction pass
  (`password|secret|token|credential` keys → `***`).

## Known gaps in this scaffold (track as follow-ups)

- Rate limiting is basic (in-memory); move to Redis-backed for multi-instance.
- No secret-manager integration yet (env only).
- Device-code executor in the worker is stubbed (`SimulatedTeamsExecutor`); the
  real `PwshTeamsExecutor` interface is defined and ready to implement.
