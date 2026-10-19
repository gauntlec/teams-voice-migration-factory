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
  An account that exists only through a single sign-on provider has no password at all: its `password_hash` is the
  marker `!federated`, which is not a valid hash, so no password can ever match it (and local sign-in refuses it before
  trying one).
- MFA: TOTP mandatory for local sign-ins. A user with `totp_enrolled = false` can only call the
  enrol/verify endpoints; every other endpoint returns 403 until enrolled. A session that came through a single
  sign-on provider (see "Single sign-on" below) is not asked for a local authenticator: the provider does that step,
  and the `amr` claim in its ID token proves it when the provider is set to require it. Only an access token this
  installation signed itself, carrying the provider's id, skips the local enrolment check; a password sign-in never
  produces one.
- Local passwords can be switched off by a provider (Platform settings > Single sign-on, "Keep the password sign-in form
  for everyone"). Break-glass accounts are exempt: a Super Admin created locally (including the bootstrap
  administrator) keeps password + authenticator sign-in whatever a provider says (`users.break_glass`), so a provider
  outage or misconfiguration can never lock everyone out. Switching local passwords off on a provider that is on is
  refused unless at least one active break-glass administrator with a password exists. Break-glass accounts cannot be
  linked to a provider, and an identity row pointing at one is never honoured.
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

## Single sign-on (OpenID Connect)

The installation is an OpenID Connect **relying party** for the Voxshift Hub and for the customer's own providers (Entra ID, Okta, Google Workspace, Keycloak). The design and the contract
with the hub are in [SSO.md](SSO.md); this is what protects it. Code: `apps/api/src/sso`.

- **Off until switched on.** Every provider, including the hub's (created by the hub connection), starts disabled. Only a Super Admin (`sso:manage`) can add, change or switch one on; every change is audited (`sso.provider.changed`, with old and new values and never a secret).
- **Authorization code flow with PKCE (S256)**, `state` bound to the browser by a short-lived (10 minute) signed `HttpOnly` cookie scoped to `/api/auth/oidc`, a `nonce` checked in the ID token, and the exact redirect URI repeated in the code exchange. The redirect URI is built from the saved base URL; on the hub's gate address (`https://<slug>.<hub domain>`) it is that address, and only for the hub provider. The `returnTo` after sign-in must be a path inside the application (anything else becomes `/`).
- **ID token checks** (`apps/api/src/sso/oidc/id-token.ts`, library `jose` 5.10.0, pinned): algorithm allow-list RS256 / ES256 / EdDSA only, so `none` and every HS* algorithm are refused before any key is looked at; the key comes from the JWKS address in the provider's own discovery document, by `kid` (a cache that refetches once on an unknown `kid`, at most every 10 seconds); `iss` equals the configured issuer, `aud` contains our client id (and `azp` equals it when there are several); `exp`, `nbf` and `iat` within 60 seconds of clock skew; `sub`, `exp`, `iat` required; and when the provider is set to require it, `amr` contains `mfa`, `otp` or `hwk`.
- **Single use.** An authorization code is consumed the first time it is seen, and so is an ID token's `jti` when it has one (`platform.sso_replay_guard`, in Postgres so it holds across API processes); a replayed callback is refused before anything is sent to the provider.
- **Discovery and token traffic is https only** (plain http only to a loopback address, for tests), follows no redirects, has a 10 second timeout and never puts a code, token, secret or the provider's answer into an error or a log. The client secret is encrypted at rest (AES-256-GCM, `DATA_ENCRYPTION_KEY`, like the SMTP password) and never returned by the API; the hub's secret is the instance token.
- **No automatic linking by email.** A first sign-in with a new provider `sub` creates a user (when "create accounts automatically" is on) only if no local account has that email. If one does, the sign-in is refused, audited, and kept as a waiting sign-in the administrator can link on purpose (Users > Link to provider identity). This blocks taking over a local administrator by someone whose provider account has the same email.
- **Roles are capped on this installation.** The role a person gets is the lower of what the provider asks for (the hub's `vx_role`, or the generic provider's role claim and map, else its default role, Customer unless changed) and the **ceiling**: for the hub one ceiling for Voxshift/MSP staff (default Administrator, because staff install and look after an installation) and one for the customer's own people (default Engineer); for a generic provider one ceiling, default Project manager. The role is re-evaluated at every sign-in. A lowered ceiling, a provider switched off, an identity removed or a user disabled signs the person out at their next token refresh (within 15 minutes) and is audited as `sso.revoked`.
- **Administrator sign-ins are loud.** Every sign-in as Super Admin through a provider is in the audit log (provider, person, the provider's session id) and emailed to every active Super Admin (a setting; the master email switch also applies).
- **Sessions.** A federated session gets the same access token and rotating refresh cookie as a password sign-in, marked with the provider and the methods it reported, and has an **absolute maximum age** (12 hours by default, a Platform setting) that refreshing never extends. Local logout ends the session here; it does not sign the person out of the provider.
- **Opening through the hub is not limited to staff.** With the customer's remote-access switch on, anyone with a hub account and a grant for this installation (Voxshift staff, MSP engineers, the customer's own people) can reach it through the hub tunnel; the hub decides who, and this installation still decides what each may do: the sign-in here applies the staff ceiling or the customer ceiling by the account's `vx_kind`, exactly the same way through the hub address as through the direct one, and without single sign-on they need a local account. The switch can be turned off at any time.
- **The hub's Open button picks the route; that choice grants nothing.** It uses this installation's own address when the person is on the same network or their browser can reach it (a no-cors request to `<web address>/version.json`, which is public and carries no data; the hub never makes that request), and otherwise the tunnel. Either way the same sign-in rules and ceilings apply. A hub administrator can switch the browser test off.
- **The hub's tokens are short and narrow.** An ID token from the hub lives 5 minutes, names this installation as its audience, is signed ES256 with a key the hub rotates every 90 days, and carries only the person's id, email, name, how they authenticated, the role the hub grants and whether the account is staff or customer. The hub issues no refresh token and its access token opens nothing. The hub signs a person in to an installation only if the hub administrator has given them access to that installation, the hub-wide and per-installation switches are on, and the person's hub session has passed the authenticator step.
- **Rate limit.** `/auth/oidc/login` and `/auth/oidc/callback` have their **own** throttle (`apps/api/src/sso/sso-rate-limit.guard.ts`, Redis key prefix `sso-rl`): 60 requests a minute per source address, separate from the 20-a-minute password-form throttle, so an office signing in through the provider at nine o'clock does not use up the password allowance (or the other way round). These routes are reached by browser navigation, so a refusal, or any unexpected error, sends the browser to the login page with a plain-language message (`/?sso_error=rate_limited` or `failed`) instead of raw JSON; errors are logged on the server.
- **Test sign-in ticket.** The two-minute Test ticket travels in an HttpOnly `SameSite=Lax` cookie scoped to the sign-in path, never in the address, and is single use.
- **Audit events:** `sso.login.success`, `sso.login.refused` (a reason code such as `token_audience`, `code_replayed`, `email_exists_unlinked`; never a token), `sso.user.created`, `sso.user.linked`, `sso.user.unlinked`, `sso.provider.changed`, `sso.revoked`. The login page only ever shows a short, generic message; the reason is in the audit log.
- **Disabling and removing.** Disabling a user on this installation is effective at once (the next request is refused and their sessions are revoked). Unlinking a person, switching a provider off or lowering a ceiling ends the session at the latest at the next token refresh (15 minutes).
- **Not built yet (phase 3), and what that means today:** the hub's revocation channel (removing someone at the hub ends their sessions within about a minute), customer-approved or time-limited administrator access, OIDC back-channel logout. Until it exists, removing or switching off a person **at the hub** (or at the customer's own provider) stops their new sign-ins at once but does **not** end a session they already have on an installation: that lasts until its absolute limit (12 hours by default, a Platform setting), unless an administrator of the installation disables or unlinks them. Not supported: SAML, SCIM, delegated customer administration, WebAuthn as a sign-in method on the installation.

## Secrets & crypto

- `DATA_ENCRYPTION_KEY` (AES-256-GCM) encrypts *queued job payloads only* while
  they sit in Redis (they can contain UPNs and phone numbers, not credentials). It also
  encrypts the stored secrets: TOTP secrets, the SMTP password, the hub instance token,
  and single sign-on client secrets.
- All secrets come from env / Docker secrets. `.env` is git-ignored;
  `.env.example` documents every key.

## Transport & headers

- API sets `helmet` defaults, strict CORS to the base URL (the saved Administration > Platform settings, else `WEB_ORIGIN`), `X-Tenant-Id` is the
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

## AI agents (assistants)

- Each agent has its own identity and tokens. A token is `vxs_agent_<id>_<secret>`; only a sha256
  hash of the secret is stored, the secret is shown once at creation, tokens expire (90 days by
  default, 365 at most), can be revoked, and can be limited to IP ranges. Failed attempts are
  rate limited with everything else (240 requests a minute per token).
- An agent sees only customers it is enabled for (and only if Managed Services and the customer's
  assistants switch are on), and only as far as its autonomy policy for that customer allows.
  Autonomy has hard caps that no setting can exceed: customer-visible text and deployments are
  never unattended. A direct write needs the highest level for that kind of action **and** a held
  claim; everything else is a proposal a person decides. Declaring a major incident is only ever
  done by a person.
- **An assistant works in one area: incidents, service requests, or both (a deliberate choice).** The guard refuses a route in another area
  with `403 wrong_area`, and the events feed, `GET /me` and webhooks carry only the assistant's own area. The point is containment: incident
  text (customers, email, monitoring) is untrusted, so an assistant that reads it should not also be able to prepare and propose changes.
- Kill switches (all, one customer, one agent) take effect on the next request. A person can take
  over any incident at once and the agent becomes read-only.
- Writes are idempotent (`Idempotency-Key`) and version-checked (`expectedVersion`), so retries and
  races cannot duplicate or overwrite.
- Webhooks are signed (HMAC-SHA256 over `timestamp.body`); the signing secret is encrypted at rest
  with the same key as the other secrets. Delivery is at-least-once; receivers should check the
  timestamp and de-duplicate by event id.
- The assistants Voxshift ships (`platform.agents.builtin_key`) run inside the API through the same agent service and
  limits as any agent: no tokens, no webhooks, no outside calls, only customers they are enabled for, and the same kill
  switches. Diagnostic checks read Discovery and the design only and never touch a customer's Teams tenant.
- The MCP server (`apps/mcp`) is a client of the agent API: it holds one agent token in its environment and adds no
  access of its own.
- **A live change by an assistant needs one human approval, command for command.** The assistant proposes; the server computes the
  plan (the rendered commands and their SHA-256 fingerprint) and refuses unless the What-If is clean; a person approves onto **their
  own** tenant session; at run time the approval, the fingerprint, the change window, read-only mode and every other guardrail are
  checked again. It runs as the approver on their session (never a stored credential, never unattended), and the request is only
  marked Deployed after the live tenant is re-read and matches the design (docs/SERVICE-REQUEST-AGENTS.md). `change_deploy` is
  capped at "act with approval" in the policy itself.
- Everything an agent does is on the incident timeline, labelled "(AI)" for staff, and in the audit
  log with the agent as the actor. Agent text is data to everyone who reads it, never an instruction.

## Incident intake (alerts and inbound email)

- An alert source token (`vxs_intake_<id>_<secret>`) is hashed at rest, shown once, rotatable, optionally limited to IP ranges, rate
  limited (120 a minute) and bound to one customer: it can only raise or update incidents there, never read anything. Alert text is data
  and is shown as plain text.
- `/api/public/inbound-email` answers 404 until `INBOUND_EMAIL_ADDRESS` and `INBOUND_EMAIL_SECRET` are set, then needs the shared
  secret (compared in constant time). A message is only acted on when the forwarder vouches `authenticated` (SPF/DKIM/DMARC), the
  reply token matches the incident **and** the sender, the user is active and still has access. Auto-replies and no-reply senders are
  ignored. No reply is ever sent to an unrecognised sender.
- MSP Teams webhook URLs are encrypted at rest with the same key as other secrets, must be HTTPS on Microsoft hosts (so the worker
  cannot be pointed at an internal address), and are never returned by the API.

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
  `TEAMS_SESSION_TTL_MINUTES` idle (default 60), on worker restart (every
  release - check *Administration → Release check* first, see
  [`ARCHITECTURE.md`](ARCHITECTURE.md#operations-releasing-safely)), or on any
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

## Container images

Reviewed 2026-10-16. What the images do, and what is still open:

- **Node 26** in every image and in CI (it becomes LTS on 2026-10-28 and is supported to April 2029; Node 20 reached end of life in April 2026, Node 22 ends April 2027). The worker takes Node from the official `node` image instead of a downloaded install script.
- **Unprivileged.** The API runs as `node`, the worker as `voxshift`. The API entrypoint (`apps/api/docker-entrypoint.sh`) starts as root only to hand an older, root-owned `filesdata` volume to the app user once, then drops root. The web image is nginx (master process root, workers `nginx`).
- **Production dependencies only** in the api and worker images (`npm prune --omit=dev`).
- **Checked before it is pushed** (`build-images.yml`): the image is built locally, started by `.github/scripts/smoke-image.sh` (runs unprivileged, dependencies resolve, PowerShell loads the Teams modules, nginx accepts its config), scanned by Trivy (fixable HIGH/CRITICAL vulnerabilities and embedded secrets), and only then pushed with an SBOM and build provenance. The findings are in the job summary. A weekly job scans the published `:latest` images too.
- **The scan blocks releases for every image** (`scan_exit` per image in the `check` job of `build-images.yml`; `TRIVY_EXIT_CODE` in the hub's `build.yml`): a fixable HIGH/CRITICAL vulnerability or an embedded secret fails the build. The build is split into `check` (build, smoke test, scan, all three images) and `publish` (push), so nothing is published unless all three pass. The weekly scan of the published images only reports. A blocked release is cleared by fixing the finding (usually: wait for the base image or package to be updated, or bump the dependency); a finding that truly does not apply can be listed in a `.trivyignore` file with the reason beside it.
- **One file is excluded from the worker scan:** the Microsoft Teams module's `_manifest/spdx_2.2/manifest.spdx.json`. It is Microsoft's build bill of materials and names the npm and .NET packages used to build the module (axios, the MCP SDK, System.Security.Cryptography.Xml and others, about 20 advisories between them); they are not code in our image, but Trivy reads the file as if they were installed. Checked 2026-10-16 against the MicrosoftTeams 8.0.0 package.
- **Dependencies (2026-10-16):** `npm audit --omit=dev` is down from 19 advisories (10 high) to 6 moderate, none high. Updated: nodemailer 10, kysely 0.29, bullmq 5.81 (+ ioredis 5.11), react-router-dom 6.30, SheetJS xlsx 0.20.3 (installed from SheetJS's own tarball, https://cdn.sheetjs.com, because npm's `xlsx` stops at the vulnerable 0.18.5; the lockfile pins its hash), NestJS 10.4.22, and `overrides` in the root package.json that give `@nestjs/platform-express` multer 2, express 4.22 and body-parser 1.20.8. The api and worker images install only their own workspace's dependencies.
- **Known and accepted (moderate):** NestJS `@nestjs/core` (SSE event-field injection) and `@nestjs/common` via `file-type` are fixed only in NestJS 11+; we use neither Server-Sent Events nor `FileTypeValidator`/`ParseFilePipe`. React Router's remaining advisories are fixed only in v7 (an open redirect through a backslash in `<Link>`/`useNavigate` with user-supplied targets, and server-side-render hydration, which we do not use). The NestJS 11 and React Router 7 upgrades are planned separately because both are major changes.
- **Web security headers** (`apps/web/security-headers.conf`, included by the static locations in `apps/web/nginx.conf`; checked in the image smoke test): `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, and an enforcing `Content-Security-Policy` (scripts and connections only from the app's own address; map tiles from OpenStreetMap; inline styles allowed because Fluent UI and Leaflet need them). It ran report-only first and logged no violation on any page of a live instance. Anything new the app loads from another address must be added to `security-headers.conf`. nginx no longer announces its version. HSTS is not set here (nginx cannot tell if the address is https); set it on the https front door. The API sends its own headers (helmet).
- **Container hardening** (`deploy/dockge/compose.yaml`, the compose the installer writes, and the hub's `deploy/compose.yaml`): every service has `no-new-privileges` and all Linux capabilities dropped, with only the few each image needs added back (postgres: CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID; redis: CHOWN, DAC_OVERRIDE, SETGID, SETUID (its start-up step runs as root and must read redis's own 0700 appendonlydir); api: CHOWN, SETGID, SETUID for the entrypoint that hands an older root-owned files volume to the app user; web: CHOWN, SETGID, SETUID, NET_BIND_SERVICE; worker and hub: none; caddy: NET_BIND_SERVICE). api, web, redis and the hub have a read-only root filesystem (writable only on their volumes and small tmpfs mounts). api, worker and web have healthchecks (the worker touches `/tmp/worker-alive` every 15 s and the check fails if that goes stale). Logs are capped at 3 x 10 MB per container. Not read-only: postgres and the worker (PowerShell and its modules keep state in the home directory). No memory limits are set: a large tenant discovery can legitimately use a lot.
- **Open:** a host firewall for the published web port (5173) and the hub's (5190) so only the reverse proxy can reach them, HSTS on the installer's Caddy front door, NestJS 11 and React Router 7.
- Images are not signed; the SBOM and provenance are attached to each image in GHCR.
