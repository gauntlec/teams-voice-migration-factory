# Security model

> **Found a vulnerability?** Please report it privately, following [SECURITY.md](../SECURITY.md) in the repository root (GitHub private
> report, or email <!--SECURITY_CONTACT_EMAIL-->security@voxshift.io<!--/SECURITY_CONTACT_EMAIL-->; the same details are served at `/.well-known/security.txt`). We acknowledge within
> 3 working days and fix in the newest release.

## Non-negotiables (from the project brief)

1. **No customer tenant credentials are ever stored.** Not in Postgres, not in
   Redis, not in env, not in logs. An engineer signs in live (device-code flow)
   each time a connection is needed; tokens exist only in worker memory with a
   hard TTL and are wiped on completion/timeout/restart.
2. **No data is shared between customers.** Schema-per-tenant + a single
   resolution point for the target schema per request (see below).
3. **Every change made to any customer tenant is audited** — one row per cmdlet
   in that tenant's `deployment_changes`, append-only. The application never
   updates or deletes those rows, and the database also refuses to (a trigger,
   tenant migration `0054`), even for the account the application connects as. It does
   not stop a database administrator, who can switch the trigger off (see "Database
   access" below).

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
- Lockout: 10 failed attempts lock the account for 15 min. The count is cumulative,
  not a rolling window: it is only reset by a sign-in that fully succeeds, so ten
  failures spread over days still lock the account, and after the 15 minutes
  are up the very next failure locks it again for another 15. Password
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
- **Roles are capped on this installation.** The role a person gets is the lower of what the provider asks for (the hub's `vx_role`, or the generic provider's role claim and map, else its default role, Customer unless changed) and the **ceiling**: for the hub one ceiling for Voxshift/MSP staff (default Administrator, because staff install and look after an installation) and one for the customer's own people (default Engineer); for a generic provider one ceiling, default Project manager. The role is re-evaluated at every sign-in. A lowered ceiling, a provider switched off, an identity removed or a user disabled signs the person out at their next token refresh (within 15 minutes) and is audited as `sso.revoked`; removing an identity also stops the access token at once (the request guard checks the identity on every call).
- **Administrator sign-ins are loud.** Every sign-in as Super Admin through a provider is in the audit log (provider, person, the provider's session id) and emailed to every active Super Admin (a setting; the master email switch also applies).
- **Sessions.** A federated session gets the same access token and rotating refresh cookie as a password sign-in, marked with the provider and the methods it reported, and has an **absolute maximum age** (12 hours by default, a Platform setting) that refreshing never extends. Local logout ends the session here; it does not sign the person out of the provider.
- **Opening through the hub is not limited to staff.** With the customer's remote-access switch on, anyone with a hub account and a grant for this installation (Voxshift staff, MSP engineers, the customer's own people) can reach it through the hub tunnel; the hub decides who, and this installation still decides what each may do: the sign-in here applies the staff ceiling or the customer ceiling by the account's `vx_kind`, exactly the same way through the hub address as through the direct one, and without single sign-on they need a local account. The switch can be turned off at any time.
- **The hub's Open button picks the route; that choice grants nothing.** It uses this installation's own address when the person is on the same network or their browser can reach it (a no-cors request to `<web address>/version.json`, which is public and carries no data; the hub never makes that request), and otherwise the tunnel. Either way the same sign-in rules and ceilings apply. A hub administrator can switch the browser test off.
- **The hub's tokens are short and narrow.** An ID token from the hub lives 5 minutes, names this installation as its audience, is signed ES256 with a key the hub rotates every 90 days, and carries only the person's id, email, name, how they authenticated, the role the hub grants and whether the account is staff or customer. The hub issues no refresh token and its access token opens nothing. The hub signs a person in to an installation only if the hub administrator has given them access to that installation, the hub-wide and per-installation switches are on, and the person's hub session has passed the authenticator step.
- **Rate limit.** `/auth/oidc/login` and `/auth/oidc/callback` have their **own** throttle (`apps/api/src/sso/sso-rate-limit.guard.ts`, Redis key prefix `sso-rl`): 60 requests a minute per source address, separate from the 20-a-minute password-form throttle, so an office signing in through the provider at nine o'clock does not use up the password allowance (or the other way round). These routes are reached by browser navigation, so a refusal, or any unexpected error, sends the browser to the login page with a plain-language message (`/?sso_error=rate_limited` or `failed`) instead of raw JSON; errors are logged on the server.
- **Test sign-in ticket.** The two-minute Test ticket travels in an HttpOnly `SameSite=Lax` cookie scoped to the sign-in path, never in the address, and is single use.
- **Audit events:** `sso.login.success`, `sso.login.refused` (a reason code such as `token_audience`, `code_replayed`, `email_exists_unlinked`; never a token), `sso.user.created`, `sso.user.linked`, `sso.user.unlinked`, `sso.provider.changed`, `sso.revoked` (reasons include `hub-grant-removed`, `hub-user-disabled`, `hub-session-revoked`, `hub-role-changed`, `access-window-ended`, `staff-access-restricted`), `sso.access.requested`, `sso.access.approved`, `sso.access.denied`, `sso.access.expired`, `sso.access.ended`. The login page only ever shows a short, generic message; the reason is in the audit log.
- **Disabling and removing.** Disabling a user on this installation is effective at once (the next request is refused and their sessions are revoked). Unlinking a person ends their session at once; switching a provider off or lowering a ceiling ends it at the latest at the next token refresh (15 minutes).
- **Revocation from the hub (`apps/worker/src/hub-heartbeat.ts`, `packages/db/src/sso-revocations.ts`).** A person removed from this installation at the hub, switched off there, whose password or authenticator was reset, or whose role changed, is named in the reply to the heartbeat (every minute, with or without remote access). Their hub sign-ins that began before the removal end at once: the refresh cookies are revoked and the identity's `revoked_before` makes the request guard refuse any access token issued before it. An account that exists only through the hub is switched off when the grant was removed; a linked local account is unlinked. Audited as `sso.revoked` with a `hub-*` reason. The lines carry a hub user id, a time and a reason, and nothing else; a time too far ahead of the clock is cut back; the acknowledgement of what was applied is a number; an older hub that refuses the extra field is simply not sent it. If the installation cannot reach the hub, nothing can be told to it until it can (the hub keeps the notes a week), and the absolute session cap still applies.
- **Voxshift staff access: approval and a time limit** (`apps/api/src/sso/sso-staff-access.service.ts`; [SSO.md](SSO.md) 4.3a). The customer can set, per installation, that sign-ins from hub **staff** accounts need an administrator's approval (for a time they choose, 1 to 24 hours), or are refused. A waiting sign-in has no session: the browser holds a random token in an HttpOnly cookie (only its hash is stored) and the session is created once, only from an approved request still inside its window, and ends with the window; the identity's `access_until` is checked by the request guard on every call, so access ends exactly then, and an administrator can end it early. Whoever decides must not have signed in through the hub (so staff cannot approve themselves), and the setting can be tightened by any administrator but loosened only by one who did not come in through the hub. Customer-kind hub accounts, the customer's own providers and local accounts, break-glass included, are never affected. Audited as `sso.access.requested`, `.approved`, `.denied`, `.expired`, `.ended`. Residual risk, stated plainly: an approved Administrator window is full administrator access for its duration (including creating users); the audit log and approving only what is expected are the controls, and a lower staff ceiling limits it.
- **Not built:** OIDC back-channel logout, and signing out of the provider when signing out here. Removing someone at the customer's **own** provider (Entra ID and so on) is not pushed to the installation: their new sign-ins stop at once, an existing session ends at its absolute limit (12 hours by default) unless an administrator disables or unlinks them. Not supported: SAML, SCIM, delegated customer administration, WebAuthn as a sign-in method on the installation.

## Secrets & crypto

- `DATA_ENCRYPTION_KEY` (AES-256-GCM) encrypts, in the database, the secrets the
  application has to read back later: **TOTP secrets**, the **SMTP password**, the
  **hub instance token**, **single sign-on client secrets**, **assistant webhook
  secrets**, **MSP Microsoft Teams webhook URLs**, and (briefly) an **invitation's
  one-time password** while its email waits to be sent
  (`apps/api/src/common/crypto.ts`; the worker has the matching decrypt). Each value
  is encrypted before it is written and never returned by the API.
  It does **not** encrypt anything else: queued Redis job payloads (which can hold
  UPNs, display names and phone numbers, never credentials) and all ordinary
  business data in Postgres are stored as they are. There is no application-level
  encryption at rest beyond the list above; protect the disks, volumes and backups
  of the host (disk encryption) for the rest. Without the key the listed secrets
  cannot be read: `voxshift backup` saves `.env` with every database backup (and the
  Caddy certificates and private keys, so a backup folder is as sensitive as the host
  itself: root-only on the host, and keep a copy off the host; `voxshift restore` puts it back,
  after checking each file's checksum and refusing a backup from a newer release; see
  [INSTALL-LINUX-REFERENCE.md](INSTALL-LINUX-REFERENCE.md)). **Backups can be encrypted** (`voxshift backup-encryption on <public key>`,
  optional, off by default): each backup then becomes one `.tar.age` file ([age](https://age-encryption.org) public-key
  encryption), so the host holds only a public key and cannot read its own backups; the private key is kept off the host
  and is needed to restore. If the private key is lost the encrypted backups cannot be read. While encryption is on a backup is
  never saved unencrypted (it fails instead), and the nightly update and `uninstall.sh --backup-to` follow the same rule. Note that
  changing the key makes them unreadable (people re-enrol TOTP, the SMTP password,
  hub token, SSO secrets and webhooks are entered again).
- **Invitation passwords are not kept.** A new user's one-time password is shown to
  the administrator once, is stored encrypted only until the email has been handled
  (then deleted from `platform.email_messages.context`), and is never written to
  the worker log (`[hidden]` when no mail server is set up). Earlier releases kept
  it in plain text; migration `0034` scrubbed those rows. See [EMAIL.md](EMAIL.md).
- All secrets come from env / Docker secrets. `.env` is git-ignored;
  `.env.example` documents every key.

## Transport & headers

- API sets `helmet` defaults, strict CORS to the base URL (the saved Administration > Platform settings, else `WEB_ORIGIN`), `X-Tenant-Id` is the
  only custom request header accepted.
- In production terminate TLS at a reverse proxy in front of `web`; set
  `COOKIE_SECURE=true`.
- `trust proxy` is a fixed hop count (2: the outer reverse proxy, then web's nginx -
  Caddy with the Linux installer, OpenResty on the hosted service;
  `apps/api/src/main.ts`), not `true` (trust everything). The `api` container
  has no published host port in `deploy/dockge/compose.yaml` - it's reached
  only through that proxy chain, so `req.ip` can't be spoofed via a direct
  connection forging `X-Forwarded-For`, and audit-log IPs / login lockout stay
  trustworthy.
- **Database access.** The api, worker and migrations all connect with one
  Postgres account (`tvmf`, from `DATABASE_URL`), which is the image's bootstrap
  superuser/owner. It owns every schema and table, so database *permissions* cannot
  stop it changing the audit tables (`platform.platform_audit_log`,
  `deployment_changes`, a tenant's `audit_log`). Instead a **database trigger on
  each of those tables refuses UPDATE, DELETE and TRUNCATE** (error "audit table ... is
  append-only"), for every account including the owner; INSERT is unaffected. It is
  added by platform migration `0035` and tenant migration `0054`; the tenant one runs for
  every existing customer when the api starts and for every customer created later, so
  new customers are protected from the first day. Removing a whole customer (`DROP
  SCHEMA ... CASCADE`) does not fire a row trigger and still works. There is no
  application feature that needs to change an audit row, so there is deliberately no
  switch or setting to bypass it. **What this does and does not do, plainly:** it stops
  an application bug, a SQL injection or a compromised application code path from
  rewriting or erasing the audit trail. It does **not** stop a database administrator
  or anyone holding the owner password or root on the host: they can run
  `ALTER TABLE ... DISABLE TRIGGER` (or drop the trigger, the table or the schema).
  Only copying the audit log off the host protects against that. Postgres is not published on the host in the installer's compose or `deploy/dockge/compose.yaml` (compose network only); the development `docker-compose.yml` at the repo root does publish 5432, for developers.
  A separate low-privilege runtime role is not built; the design, what it would and would not protect, and the risks are in
  [DB-LEAST-PRIVILEGE.md](DB-LEAST-PRIVILEGE.md) (the trigger step is built, the role split is what remains).
- **Outbound traffic that carries customer data.** Besides the hub, the mail
  server, an identity provider and Microsoft (Teams PowerShell, Graph), two
  OpenStreetMap services are used. (1) When an engineer clicks *Get coordinates
  from address* on a site, the API sends that **street address** over https to
  OpenStreetMap's Nominatim geocoder (`nominatim.openstreetmap.org`,
  `apps/api/src/modules/data-collection/geocode.service.ts`), with a generic
  User-Agent and no customer or user name, at most one request a second, results
  cached in API memory only (up to 500, lost on restart). Nothing is sent unless
  someone clicks; there is no setting to switch it off, and no outbound HTTP-proxy
  support, so the API host needs direct outbound https to reach it. An installation
  that must not send addresses out should block that host (the button then says no
  coordinates were found and they can be typed in). (2) The site map in the
  *browser* loads map tiles from `*.tile.openstreetmap.org` (the CSP allows
  exactly that); the tile numbers reveal roughly where the map is looking, never an
  address.
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

- `platform_audit_log`: auth events, user/tenant admin actions (including deleting a
  customer: `tenant.delete_started`, `tenant.deleted`, `tenant.delete_refused`), membership
  changes, connection start/stop. (This table, the tenant `audit_log` and
  `deployment_changes` are append-only at the database: see "Database access".)
- tenant `audit_log`: module-level actions (discovery submitted, build row
  changed, deployment started, handover generated).
- tenant `deployment_changes`: the fine-grained per-cmdlet record. Written by the
  worker as it runs. Parameters are stored with a redaction pass
  (`password|secret|token|credential` keys → `***`).

## Deleting a customer

A Super Admin can delete a customer and **all** of its data for good: **Administration > Customers > Delete customer...** (route
`POST /api/tenants/:id/delete`, permission `tenant:delete`, which only the Super Admin role holds: `docs/RBAC.md`). The server is the authority:
every other role gets 403 whatever the page shows. This closes the earlier gap "no in-app per-customer erase". Code:
`apps/api/src/tenants/tenant-deletion.service.ts`; the list of everything that refers to a customer:
`apps/api/src/tenants/tenant-data-inventory.ts`.

**It is deliberate, not accidental.** The dialog shows the customer's name and real counts (sites, stored files and their size, incidents,
service requests, Discovery runs, deployments, number porting requests, email log entries, the people who will be deleted and the people
who only lose access). It says the deletion cannot be undone and that backups already taken still hold the data. It needs (1) the
customer's exact name typed and (2) a **current 6-digit code from the Super Admin's own authenticator app**, checked again at that moment
(`AuthService.requireFreshMfa`; a wrong code counts towards the same lock-out as signing in, so it cannot be used to guess codes). A Super
Admin who signed in through single sign-on and has no authenticator on the account is told to set one up first. Refused attempts (wrong name,
wrong code, busy) are written to the audit log as `tenant.delete_refused` with a reason, never with what was typed.

**It is refused, with a plain message, while work cannot be cut off safely**: a deployment that is running or waiting to run, or a Discovery
run that is running or waiting to run. Wait for it to finish and try again (there is no cancel button for these runs). An open Microsoft
Teams sign-in that is not running anything is not a reason to refuse: it is closed as part of the deletion.

**What happens, in this order** (each step can be run again if one fails; the Customers page then shows the customer under "Deletion not
finished" with a **Finish deleting** button, and the same dialog finishes the job):

1. The customer is marked `deleting` (platform migration `0036`). From this moment it is hidden from every list, nobody can open it (the
   tenant guard answers "not found"), the start-up migration skips it (it would otherwise create the dropped schema again) and the worker's
   sweeps and jobs skip it. The counts shown in the dialog are saved on the row (numbers only).
2. The people who will be deleted are disabled and their sign-in sessions revoked, so their access stops at once (every request re-reads the
   account).
3. The queue is cleared of this customer's jobs (waiting, delayed, finished and failed ones; the mail jobs for the email rows that go). The
   worker is asked to close the customer's Microsoft Teams sign-ins (they live only in the worker's memory) and refuses any later job for the
   customer. If the worker does not answer, nothing is deleted and the Super Admin is told to check the worker and try again.
4. The customer's files are deleted from disk (`<files folder>/<schema>/...` and the logo under `branding/<customer id>/`).
5. The customer's whole database schema is dropped (`DROP SCHEMA ... CASCADE`). The append-only triggers on the customer's own audit tables
   refuse row changes but do not stop a schema being dropped (tested).
6. In **one database transaction**: the platform rows are removed, the audit entry is written, and the customer row is deleted last.

**What is deleted**: the customer's database schema (sites, discovered Microsoft Teams data, design, deployments, handover, incidents,
service requests, files index, its own audit log); the files and logo on disk; its memberships, assistant permissions and events, monitoring
sources, reply tokens, invitations, MSP Teams notifications; **customer-role people who belong only to this customer** (their account,
sessions, authenticator, single sign-on links, memberships, and invitations to their address).
**Never deleted**: Super Admins, project managers, engineers and any person who also belongs to another customer. They only lose their
membership of this customer.

**The email log.** Rows of `platform.email_messages` that are about the customer (`tenant_id`) or were sent to a person deleted with it are
**deleted** (not scrubbed), because they hold names, addresses and the incident or request text in `context`. The same goes for
`inbound_email_log` rows. Unrelated mail to staff stays. A bug report's "affected customer" field is emptied when it holds exactly the
customer's name; free text inside a report is not searched.

**The audit entry.** One `tenant.deleted` row in `platform_audit_log` records who deleted (id, email, address), when, the customer's id and
name and slug, and **counts** of what was removed. It holds no customer content: no site names, people, ticket text, addresses or file
names (tested). Two companion entries exist: `tenant.delete_started` (once, when the customer is marked) and `tenant.delete_refused`.

**What can still hold something about the deleted customer** (be honest with the customer's security team):

| Where | What | Why / what to do |
|---|---|---|
| Backups taken earlier (`voxshift backup`, off-host copies) | Everything, until the backup is deleted or expires | The deletion cannot reach them. Take a backup first if a copy may be needed; delete old backups to complete a legal erasure. |
| The platform audit log | The customer's id, name and slug, the counts, who did what, and older entries that carry the customer's id (and, for example, the email of someone who signed in) | It is append-only by design. See "Erasure requests that cover the audit trail" below. |
| Redis append-only file | Payloads of removed jobs, until Redis rewrites its file (`docker exec <redis> redis-cli BGREWRITEAOF` forces it) | Jobs hold ids, UPNs and names, never credentials. |
| Postgres files and write-ahead log | Deleted platform rows stay in the table files until autovacuum reuses the space, and in any archived write-ahead log | The customer's own schema is dropped outright (its files are removed). |
| Container logs | Anything the API or worker printed (capped at 3 x 10 MB per container) | They rotate out. |
| Free text in platform boards | A bug or feature request that mentions the customer in its text | Not searched. Remove by hand if needed. |
| Customers' own Microsoft 365 tenants | Nothing is stored there by Voxshift beyond what deployments changed | Not part of Voxshift. |
| The Voxshift Hub | Nothing customer-specific: the heartbeat carries a version, a health word and two switches only | |

**Erasure requests that cover the audit trail.** If a customer's legal request also covers the platform audit log, that is a **policy
decision for the organisation, not something the application does**. The log is append-only on purpose, and it is how you can show who
accessed or deleted what. The choices are to keep the minimal record (customer name, id, counts, actor) on the grounds of legitimate interest
or a legal duty to keep security records, or to have a database administrator edit the rows by hand
(`docs/DB-LEAST-PRIVILEGE.md` describes how, and says to record that action). Decide which applies before promising an erasure
"including the audit trail", and put the decision in the customer contract.

## Known gaps in this scaffold (track as follow-ups)

- No secret-manager integration yet (env only).
- A customer's data can be deleted from the app ("Deleting a customer" above); the places it can still remain (backups, the audit log, Redis and Postgres files) are listed there.

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
  `TEAMS_SESSION_TTL_MINUTES` idle (default 240, in code and in the installer), on worker restart (every
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
- **Dependencies (2026-10-16):** `npm audit --omit=dev` is down from 19 advisories (10 high) to 6 moderate, none high. Updated: nodemailer 10, kysely 0.29, bullmq 5.81 (+ ioredis 5.11), react-router-dom 6.30 (since moved to React Router 7, see below), SheetJS xlsx 0.20.3 (installed from SheetJS's own tarball, https://cdn.sheetjs.com, because npm's `xlsx` stops at the vulnerable 0.18.5; the lockfile pins its hash), NestJS 10.4.22 (since moved to NestJS 11.2.7, see below), and `overrides` in the root package.json that gave `@nestjs/platform-express` multer 2, express 4.22 and body-parser 1.20.8 (since removed: NestJS 11 brings Express 5.2, multer 2.4 and body-parser 2 itself). The api and worker images install only their own workspace's dependencies.
- **zod 4, body-parser 2.4, multer 2.5 (2026-10-26):** three newly published fixable HIGH advisories failed the image scan (body-parser DoS on compressed bodies, multer DoS on aborted uploads, zod memory exhaustion on large constrained arrays; zod's fix exists only in 4.x). body-parser comes from the lockfile; `multer` is pinned by a root `overrides` entry because `@nestjs/platform-express` pins an exact older version (remove the override once platform-express ships 2.5+); every workspace is on zod 4.6.7. Code changes for zod 4: `z.record` takes a key schema, `errorMap`/`invalid_type_error` became `error`, ids are checked with `z.guid()` (zod 4's `uuid()` insists on RFC version/variant bits and would reject well-formed ids), and an enum-keyed record that may be partial is `z.partialRecord`.
- **NestJS 11 (2026-10-19):** the api runs on NestJS 11.2.7 with Express 5.2 (and `@types/express` 5), which clears the `@nestjs/core` and `@nestjs/common` (via `file-type`) advisories; the root `overrides` for express, body-parser and multer are gone because `@nestjs/platform-express` 11 pins safe versions itself. Express 5 treats an unset body as `undefined` instead of `{}`; the shared `ZodBody` pipe maps that back to `{}`. There is exactly one copy of `@nestjs/common` (`npm ls @nestjs/common`).
- **React Router 7 (2026-10-19):** the web app uses `react-router` 7.18 (library mode: `BrowserRouter`, `Routes`, `Link`; the old `react-router-dom` package is gone and every import now comes from `react-router`), which clears the open-redirect (backslash in `<Link>`/`useNavigate`) and hydration advisories. The app is a plain single-page app with no data routers, loaders or server rendering; the built page still has exactly one script tag (the app bundle), so the Content-Security-Policy is unchanged. `npm audit` now lists only dev tooling (vite/esbuild, tsx, source-map-js), none of which is in a production image.
- **Web security headers** (`apps/web/security-headers.conf`, included by the static locations in `apps/web/nginx.conf`; checked in the image smoke test): `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, and an enforcing `Content-Security-Policy` (scripts and connections only from the app's own address; map tiles from OpenStreetMap; inline styles allowed because Fluent UI and Leaflet need them). It ran report-only first and logged no violation on any page of a live instance. Anything new the app loads from another address must be added to `security-headers.conf`. nginx no longer announces its version. HSTS is not set here (nginx cannot tell if the address is https). The API sends its own headers (helmet), with helmet's HSTS switched off (`apps/api/src/common/security-headers.ts`; its default, 180 days plus `includeSubDomains`, would have reached browsers next to the front door's value).
- **HSTS (2026-10-19):** the installer's Caddyfile sends `Strict-Transport-Security: max-age=31536000` in every https mode (`acme`, `internal`, `custom`) and never with `--tls none`, without `includeSubDomains` or `preload` (those would also bind every other site on the customer's domain). `install.sh --hsts-max-age SECONDS` changes it, `0` switches it off. It is set in that one layer only, so a browser sees one value. Behind a customer's own reverse proxy (the Dockge compose), set HSTS on that proxy. See `INSTALL-LINUX.md`.
- **Certificates (2026-10-20):** besides Let's Encrypt (`acme`), Voxshift's own private CA (`internal`) and the customer's own certificate (`custom`), the installer can make a **self-signed certificate** (`--tls selfsigned`, 365 days by default, RSA 2048, valid for the exact address, server use only). `voxshift certificate status|selfsigned|install|export` checks and swaps certificates on a running installation: a certificate must be readable, match its key, be unexpired and cover the address, or nothing changes, and the old files are put back if the front door does not start. A self-signed or `internal` certificate is only as trustworthy as the way it reaches each computer (the public file from `voxshift certificate export`, never the key); each renewal of a self-signed one has to be trusted again. The private key stays on the host (`/opt/voxshift/certs/server.key`, mode 600) and is part of every backup, which is why a backup is as sensitive as the host. See `INSTALL-LINUX.md`.
- **Container hardening** (`deploy/dockge/compose.yaml`, the compose the installer writes, and the hub's `deploy/compose.yaml`): every service has `no-new-privileges` and all Linux capabilities dropped, with only the few each image needs added back (postgres: CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID; redis: CHOWN, DAC_OVERRIDE, SETGID, SETUID (its start-up step runs as root and must read redis's own 0700 appendonlydir); api: CHOWN, SETGID, SETUID for the entrypoint that hands an older root-owned files volume to the app user; web: CHOWN, SETGID, SETUID, NET_BIND_SERVICE; worker and hub: none; caddy: NET_BIND_SERVICE). api, web, redis and the hub have a read-only root filesystem (writable only on their volumes and small tmpfs mounts). api, worker and web have healthchecks (the worker touches `/tmp/worker-alive` every 15 s and the check fails if that goes stale). Logs are capped at 3 x 10 MB per container. Not read-only: postgres and the worker (PowerShell and its modules keep state in the home directory). No memory limits are set: a large tenant discovery can legitimately use a lot.
- **Open:** a host firewall for the published web port (5173) and the hub's (5190) so only the reverse proxy can reach them.
- Images are not signed; the SBOM and provenance are attached to each image in GHCR.

## Build and supply chain

- **What runs automatically (2026-10-20).** Separate from the release workflow, so none of it can hold up or block a release:
  - **Release gates** (`build-images.yml`, unchanged): typecheck and all tests (`verify`), then build + smoke test + Trivy scan of each image (`check`), then publish and release. Details under Container images above.
  - **Code scanning, CodeQL** (`.github/workflows/codeql.yml`): GitHub's static analysis of the TypeScript / JavaScript code (injection, unsafe redirects, path traversal, weak crypto, secrets in logs and similar). Runs on every push to `main`, on every pull request and once a week (Wednesday), with the `security-extended` query set and `build-mode: none` (reads the source; no build). Permissions: `contents: read`, `security-events: write`. Results are under Security > Code scanning on GitHub. It reports; it does not fail a release. Someone has to look at the alerts: a new alert on a pull request is shown as a check on that request.
  - **Dependency updates, Dependabot** (`.github/dependabot.yml`): every Monday, pull requests for newer npm packages (one grouped request for minor and patch updates, each major update on its own), for the versions of the GitHub Actions the workflows use, and for the base images of the three Dockerfiles (never a new Node major; that is moved by hand). At most 5 requests open per kind. Nothing merges by itself: each request runs the normal checks and a person merges it. Dependabot's own *security* alerts and automatic security pull requests are a separate repository setting (Settings > Code security) and are not switched on by this file.
  - **Secret scanning with push protection** is a repository setting and is on.
  - **Not covered:** the private Voxshift Hub repository cannot use CodeQL (it needs GitHub Advanced Security on a private repository), so it has no static analysis yet; its images get the Trivy scan.
- **Installer integrity (2026-10-20).** Each release (`release` job in `.github/workflows/build-images.yml`) attaches `install.sh`, `uninstall.sh`, a `SHA256SUMS` file for them and `SHA256SUMS.sigstore.json`, a keyless [Sigstore](https://www.sigstore.dev) signature of `SHA256SUMS` made with `cosign` using the workflow's GitHub identity (no signing key exists to leak). If signing fails the release is still made, without the signature file, and the job summary says so. To check a download by hand, or to pin a release instead of `main`:

  ```bash
  BASE=https://github.com/gauntlec/teams-voice-migration-factory/releases/latest/download   # or .../releases/download/v2026.10.20
  curl -fsSLO $BASE/install.sh && curl -fsSLO $BASE/SHA256SUMS && curl -fsSLO $BASE/SHA256SUMS.sigstore.json
  grep ' install.sh$' SHA256SUMS | sha256sum -c -
  cosign verify-blob --bundle SHA256SUMS.sigstore.json \
    --certificate-identity https://github.com/gauntlec/teams-voice-migration-factory/.github/workflows/build-images.yml@refs/heads/main \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS
  ```

  `voxshift self-update` does this itself: it takes `install.sh` from the newest release, requires it to match that release's `SHA256SUMS`, verifies the signature when `cosign` is installed (one-line notice when it is not), and changes nothing on a mismatch. It falls back to the old unchecked `main` address, with a visible warning, only when the newest release has no `SHA256SUMS` at all. What this proves and does not prove is written out in [INSTALL-LINUX.md](INSTALL-LINUX-REFERENCE.md#installer-checks-and-pinning-a-release): in short, the file is the one this repository's workflow published and was not altered in transit; it does not prove the code has no mistakes. The program images are not cosign-signed (SBOM and build provenance are attached to each).

- **Reporting a vulnerability (2026-10-20).** The policy is [SECURITY.md](../SECURITY.md) in the repository root (GitHub shows it as the repository's Security policy): how to report privately (GitHub private vulnerability reporting, or email), what to include, what we do (acknowledge within 3 working days, assess, fix in the newest release because there are no back-ports, credit on request), what is in and out of scope and a modest safe-harbour statement. The same contact is published as `/.well-known/security.txt` (RFC 9116) by every web container (`apps/web/public/.well-known/security.txt`; `apps/web/nginx.conf` serves it as `text/plain; charset=utf-8` with the usual security headers and a one-hour cache, never the app's HTML page; `.github/scripts/smoke-image.sh` checks that before an image is pushed). **The contact email address is kept in exactly one place, `deploy/security/SECURITY_CONTACT_EMAIL`.** Change it with `bash deploy/security/set-contact.sh <address>`, which updates SECURITY.md and security.txt; the `verify` job runs `set-contact.sh --check` and fails if they disagree. The address is security@voxshift.io; the mailbox exists (confirmed 2026-10-20) and must stay monitored, because the policy promises an acknowledgement within 3 working days. `set-contact.sh` keeps this document's first paragraph in step too. The `Expires` line in security.txt is one year ahead (2027-10-20) and must be renewed before then; the image smoke test warns when it is within 30 days. GitHub's private vulnerability reporting is a repository setting that must be switched on (Settings > Code security) for the first reporting route to work.
