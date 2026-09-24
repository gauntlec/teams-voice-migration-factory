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
- Lockout: 10 failed attempts in 15 min locks the account for 15 min. Password
  and TOTP failures share one counter - a bad TOTP counts the same as a bad
  password, so a stolen/reused password alone cannot be used to grind MFA
  (`AuthService.login`/`confirmTotpEnrol`, `apps/api/src/auth/auth.service.ts`).
  This counter lives in `platform.users` (Postgres), so it's already correct
  across any number of API replicas - never in-memory.
  A limited "enrol" token (issued on first login before TOTP is set up, 10 min
  TTL) cannot re-arm an already-confirmed account even if it leaks -
  `AuthController.totpStart` refuses it once `totp_enrolled` is true.
- Rate limiting: `POST /auth/login` is also throttled per source IP (20
  requests/min, Redis-backed via `rate-limiter-flexible`,
  `apps/api/src/auth/login-rate-limit.guard.ts` - reuses the ioredis
  connection BullMQ already holds open) on top of the per-account lockout
  above. The lockout alone only trips once a specific account has been
  guessed at; this catches an attacker spraying many different emails from
  one IP before any single account's counter would fire. Already correct
  for multi-instance since the counter lives in Redis, not per-process
  memory.

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
- `trust proxy` is a fixed hop count (2: OpenResty, then web's nginx -
  `apps/api/src/main.ts`), not `true` (trust everything). The `api` container
  has no published host port in `deploy/dockge/compose.yaml` - it's reached
  only through that proxy chain, so `req.ip` can't be spoofed via a direct
  connection forging `X-Forwarded-For`, and audit-log IPs / login lockout stay
  trustworthy.
- Adminer (`deploy/dockge/compose.yaml`) is a full unauthenticated DB browser
  and does not start by default (`profiles: ["debug"]`) - bring it up
  deliberately from the host when needed, take it back down after.

## PowerShell cmdlet construction

- Every cmdlet invocation is built by `renderCommand` (`packages/shared/src/
  deployment.ts`) and run inside a live `pwsh` session that can call
  `Set-Cs*`/`Remove-Cs*` against a customer's real tenant
  (`apps/worker/src/teams/pwsh-executor.ts`). String parameters are rendered
  as PowerShell single-quoted literals with the embedded-quote doubled
  (`psQuote`) - **not** `JSON.stringify`, which escapes `"` the JS way
  (`\"`) and does not close cleanly inside a PS string (PS backslash isn't an
  escape character), letting a value containing `"` break out of the literal
  and run as live PowerShell. Any new call site that interpolates a value into
  a `pwsh` script must go through `psQuote`, never string-template it directly.

## Audit

- `platform_audit_log`: auth events, user/tenant admin actions, membership
  changes, connection start/stop.
- tenant `audit_log`: module-level actions (discovery submitted, build row
  changed, deployment started, handover generated).
- tenant `deployment_changes`: the fine-grained per-cmdlet record. Written by the
  worker as it runs. Parameters are stored with a redaction pass
  (`password|secret|token|credential` keys → `***`).

## Known gaps in this scaffold (track as follow-ups)

- No secret-manager integration yet (env only).

## Worker PowerShell module version pinning

- `apps/worker/Dockerfile` pins `MicrosoftTeams` and
  `Microsoft.Graph.Authentication` via `-RequiredVersion` (build args
  `TEAMS_MODULE_VERSION`/`GRAPH_MODULE_VERSION`, defaulted in the Dockerfile).
  Production (`build-images.yml`'s push-triggered `build` job) always
  installs exactly those pinned versions - deterministic, and the layer is
  now cache-stable (no `CACHE_BUST`), unlike before this pin existed, when
  every push silently installed whatever was newest on PSGallery.
- **Bumping the pin**: a weekly, worker-only `build-candidate` job (the same
  `schedule` trigger that used to rebuild production) builds an *unpinned*
  image to `ghcr.io/.../tvmf-worker:candidate` - never `:latest`, never
  pulled by Dockge/production. If a new PSGallery release has landed and
  looks safe (check `docker run --rm ghcr.io/.../tvmf-worker:candidate pwsh
  -c "(Get-Module -ListAvailable MicrosoftTeams).Version"` and a manual
  smoke test against a non-production tenant if possible), bump
  `TEAMS_MODULE_VERSION`/`GRAPH_MODULE_VERSION` in the Dockerfile via a
  normal PR - that's what actually changes what `:latest` installs next.
  The pinned versions are also visible on the running image without
  shelling in, via `docker inspect` (`com.voxshift.microsoftteams-version` /
  `com.voxshift.graph-authentication-version` labels).

## Customer tenant sessions (Discovery / Deployment)

- The worker runs `Connect-MicrosoftTeams -UseDeviceAuthentication` in a `pwsh`
  child per connection (`apps/worker/src/teams/pwsh-executor.ts`). The engineer
  signs in with their own **Teams Administrator** account; Microsoft's first-party
  app is used, so no Voxshift app registration or admin consent exists in the
  customer tenant.
- Access/refresh tokens exist only inside that child process. The worker reads
  stdout solely to pick out the device-code line and to parse JSON it explicitly
  requested between sentinel markers; stderr is discarded; raw output is never
  logged. The `connections` table has no token columns by design.
- Sessions end on `Disconnect-MicrosoftTeams` + process exit: after
  `TEAMS_SESSION_TTL_MINUTES` idle (default 60), on worker restart, or on any
  sign-in error. The row is marked `expired`; a new run needs a fresh sign-in.
- Discovery is read-only (`Get-Cs*` only) and stores configuration, never
  credentials. What it stores per customer is listed in `docs/DISCOVERY.md`.
- `TEAMS_EXECUTOR=simulated` (dev/demo) never talks to Microsoft at all.
- **Optional second sign-in, to Microsoft Graph.** Discovery's primary sign-in
  is MicrosoftTeams-only; an engineer can *additionally* connect the same
  session to Microsoft Graph, read-only (`Group.Read.All`), from the Discovery
  page's "Connect to customer tenant" card, to search M365 groups by name for
  the Shared Voicemail `groupId` field instead of typing a raw Object ID. Same
  governance as the Teams sign-in: Microsoft's first-party Graph PowerShell
  app, no Voxshift app registration, token lives only in the same worker
  process (`connections.graph_*` columns carry no tokens, same rule as
  above). A one-time full group list (`/groups`) is cached in `tenant_groups`
  (id/name/mail only) so search is a fast DB read afterward, not a live call
  per keystroke. (An earlier, unrelated use of this same mechanism - a
  short-lived second Graph sign-in for the Teams device inventory - was added
  and reverted, only because that specific Graph endpoint was retired by
  Microsoft; the sign-in mechanism itself is unchanged from that attempt.)
- **Session ownership.** A `connections` row is bound to the engineer who
  established it (`started_by`). Only that engineer, or a `SUPER_ADMIN`, may
  *use* it — enforced in `TenantDiscoveryService.startRun` and
  `DeploymentService.createDeployment` (403 otherwise), and in
  `getConnection` (an engineer cannot read another engineer's row, so cannot
  see their `user_code`). `summary()` and `listConnections()` show a normal
  engineer only their own live session; a `SUPER_ADMIN` sees every engineer's
  and picks which one a sync runs on. A `SUPER_ADMIN` running on another
  engineer's session is written to both audit logs (`sessionOwnerId`, `ranAs`).
- **Per-customer read-only safeguard.** `platform.tenants.teams_read_only`
  (SUPER_ADMIN-only, `tenant:update`, toggled from the admin Customers page)
  guarantees no write cmdlet (`Set-Cs*`/`Grant-Cs*`/`New-Cs*`/`Remove-Cs*`)
  ever reaches that customer's live Microsoft Teams tenant, regardless of
  deployment mode or the operator's `deployment:execute` permission. This is
  a tenant property, not a role property: a `SUPER_ADMIN` requesting
  `execute` on a read-only tenant is refused the same as anyone else.
  Enforced twice: `DeploymentService.createDeployment` refuses to even queue
  an `execute` deployment (fast 403); and independently, `handleDeploymentRun`
  re-reads the flag from `platform.tenants` fresh at run time (never trusts
  the queued job payload) and forces every cmdlet to `whatif` before it
  reaches `exec.invoke()` - the single call site in the codebase capable of
  writing to a customer tenant. Discovery and live-vs-target validation are
  unaffected; they only ever call the separate read-only `exec.query()`
  method, which this flag does not touch.
