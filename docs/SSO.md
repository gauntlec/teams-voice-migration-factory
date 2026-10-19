# Single sign-on (OpenID Connect) - design

Status: **decided 2026-10-18; phase 1 (the instance side) built 2026-10-18**, see section 8 for what exists, what was added to the contract while building it, and what is left. The hub side (phase 2) and the lifecycle work (phase 3) are not built in this repository. Owner decision: hub accounts (staff AND customers) can sign in to Voxshift installations without a second
sign-in, and customers can use their own identity provider (for example Microsoft Entra ID) the same way. This file is the contract the instance side
(this repository) and the hub side (private repository `voxshift-hub`) are both built against. The protocol is standard OpenID Connect; nothing in
this file is secret.

This reverses the earlier "no single sign-on" decision (see `docs/HUB-CONNECTION.md`). What stays true: **every instance still decides for itself**
whether to trust a provider, which role a person gets, and whether local passwords still work. Authentication is verified cryptographically on the
instance; the hub cannot sign anyone in to an instance that has not switched hub sign-in on.

## 1. Goals and non-goals

Goals
- One sign-in (hub password + authenticator code) opens any installation the person is allowed to use, from the hub's Open button or from the
  installation's own login page ("Sign in with Voxshift Hub").
- Customers can add their own OIDC provider (Entra ID, Okta, Google Workspace, Keycloak...). This also answers the most common security-team
  question about on-premises installs ("does it support SSO?").
- Hub accounts for Voxshift staff, MSP engineers and customer people. What a person may do is set per installation at the hub, and capped by the
  customer on the installation.
- Removing someone at the hub (or at the customer's provider) takes effect quickly everywhere.
- Passwords, password hashes and authenticator secrets never leave the system that owns them.

Non-goals (first version)
- SAML. SCIM provisioning. Delegated administration (a customer administrator creating hub accounts). Per-tenant claim mapping beyond a role.
  Each is possible later on top of this design.
- Removing local accounts. They stay (customer choice), including a break-glass administrator.

## 2. Options considered

| Option | Verdict |
|---|---|
| Sync hub accounts (with password hashes / MFA secrets) into every installation | Rejected. Spreads credentials to every customer host (one stolen backup exposes hub staff credentials) and still means two sign-ins. |
| Sync identities only (no credentials) + each installation keeps its own passwords | Rejected as the main mechanism. It does not remove the second sign-in. A light form of it survives as just-in-time user creation (4.4). |
| Trusted header from the hub gate ("X-Hub-User") | Rejected. Only works through the tunnel, trusts the network path, and gives direct internal users nothing. |
| Shared cookie on `*.hub.voxshift.io` | Rejected. Does not work for direct internal access (customer's own address). |
| **OpenID Connect, hub as provider, instance as relying party (authorization code + PKCE)** | **Chosen.** Standard, auditable, works for both direct and via-hub access, and the same relying-party code serves customers' own providers. |

## 3. Architecture

```
 Browser                          Instance (customer host)                  Hub (hub.voxshift.io)
   | 1  open https://<base>/ or hub "Open"       |                                  |
   |-------------------------------------------->|                                  |
   | 2  302 /oidc/authorize?client_id&redirect_uri&state&nonce&code_challenge        |
   |<--------------------------------------------|                                  |
   | 3  GET authorize (hub session cookie; password+MFA if not signed in) ---------->|
   |<----------------------------------------------------------------- 4  302 redirect_uri?code&state
   | 5  GET /api/auth/oidc/callback?code&state   |                                  |
   |-------------------------------------------->| 6  POST /oidc/token (code, verifier, instance token as client secret)
   |                                             |--------------------------------->|
   |                                             |<---------- 7  id_token (+ access token not used)
   |                                             | 8  verify signature (JWKS), iss, aud, exp, nonce, amr
   |                                             | 9  find/create local user, apply role ceiling, start local session
   | 10 session cookie, app loads                |                                  |
```

- Steps 6-8 are server to server (the instance reaches the hub on 443, as it already does for the heartbeat). The browser only needs to reach the hub
  for steps 3-4. If the hub is unreachable the hub button simply fails and **local sign-in still works**.
- Through the hub's gated address (`https://<slug>.hub.voxshift.io`) the existing gate (launch ticket and gate session) still controls who can reach
  the tunnel. SSO adds the instance-level sign-in behind it; for the person it is one click. The hub's Open button sends the browser to the
  instance's `/api/auth/oidc/login?provider=hub`, and because the person already has a hub session the hub answers step 3 without a prompt.

## 4. Instance side (this repository)

### 4.1 Providers
A new table `platform.sso_providers`: `id`, `kind` (`hub` | `oidc`), `name`, `issuer`, `client_id`, `client_secret_enc` (AES-256-GCM with
`DATA_ENCRYPTION_KEY`, like the SMTP password), `scopes`, `enabled`, `jit_create` (bool), `require_mfa_claim` (bool, default true), the role
ceilings (`role_ceiling` for `oidc` providers; `role_ceiling_staff` and `role_ceiling_customer` for the `hub` provider, see 4.3), `default_role`,
`role_claim` (optional claim name) and `role_map` (json: claim value to role), `email_domains` (optional allow-list),
`allow_local_passwords` (bool, default true), `created_at`/`updated_at`.
- The `hub` provider is created automatically when the instance is connected to a hub: issuer = the hub address from the hub connection,
  `client_id` = the instance id, client secret = the instance token. **It starts disabled**: it is switched on in Platform settings > Single
  sign-on by an administrator of the installation (normally the Voxshift staff member doing the setup, with the customer's agreement, using the
  local administrator account). Changing the hub address or token updates it.
- `oidc` providers are added by an administrator (issuer URL, client id, client secret). Discovery (`/.well-known/openid-configuration`) fills the
  endpoints; keys come from the provider's JWKS, cached and refreshed on an unknown `kid`.

### 4.2 Flow requirements
- Authorization code flow with PKCE (S256), `state` bound to the browser (short-lived signed cookie), `nonce` in the ID token, exact redirect URI
  `https://<base-url>/api/auth/oidc/callback` (the current base URL setting). Through the hub the redirect URI is
  `https://<slug>.hub.voxshift.io/api/auth/oidc/callback`; the callback must work on any address the instance is reachable on that the provider has
  registered.
- Verify: signature (RS256/ES256/EdDSA only, never `none`/HS*), `iss` equals the provider's issuer, `aud` contains the client id, `exp`/`iat` within
  60 s skew, `nonce`, and (when `require_mfa_claim`) `amr` contains `mfa`, `otp` or `hwk`. ID tokens are single use (remember `jti` or the code).
- Never log tokens, codes or secrets. Errors shown to the user are generic; the reason goes to the audit log.
- The login page lists enabled providers as buttons next to the local form. `allow_local_passwords = false` hides the local form for everyone
  except break-glass accounts (4.6).

### 4.3 Roles and the ceiling
Instance roles are `SUPER_ADMIN`, `PROJECT_MANAGER`, `ENGINEER`, `CUSTOMER`. The provider says what the person should get (the hub's `vx_role`
claim, or an `oidc` provider's `role_claim`/`role_map`/`default_role`). **Effective role = the lower of the requested role and the ceiling.** The
ceiling exists so a mistake or compromise at a provider cannot hand out more than the customer accepted, and the customer can lower it at any time.
- **`hub` provider, two ceilings by the kind of hub account (`vx_kind`):**
  - `role_ceiling_staff` (Voxshift staff and MSP engineers): default **`SUPER_ADMIN`**. Voxshift staff normally install and configure an
    on-premises installation, so they need the top role through the hub. The customer sees this plainly on the Single sign-on screen ("Voxshift Hub staff
    can sign in as: Administrator") and can lower it, for example to `ENGINEER` for day-to-day work (and later, in phase 3, require customer
    approval or a time-limited window for administrator sign-in).
  - `role_ceiling_customer` (the customer's own people with hub accounts): default **`ENGINEER`**; a customer administrator can raise it.
- **Generic `oidc` providers** (customer's own identity provider): one `role_ceiling`, default `PROJECT_MANAGER`.
- The ceiling is always shown and editable by an administrator of the installation (SUPER_ADMIN, permission `sso:manage`). The role is re-evaluated
  at every sign-in and a lowered ceiling applies at the next sign-in (and revokes sessions above it, see 4.7).
- Every sign-in with the `SUPER_ADMIN` role through a provider is audited with the provider, the person and the hub's session id, and (if
  configured) emailed to the installation's administrators.

`CUSTOMER` users sign in with no customer (tenant) memberships; an administrator adds memberships afterwards (as for any customer user today). A
later version may carry tenant mapping in a claim.

### 4.4 Users
A new table `platform.external_identities`: `user_id`, `provider_id`, `subject` (the provider's `sub`), `email`, `created_at`, `last_login_at`,
unique on (`provider_id`, `subject`).
- First sign-in with a new `sub`: if `jit_create` is on, create a user (no password, `totp_enrolled` not required for federated sessions, `must_change_password`
  false) with the effective role, and the identity row. If off, refuse with a clear message.
- **No automatic linking by email.** If a local user with the same email already exists and is not linked, refuse ("an account with this email
  already exists, ask an administrator to link it") and write an audit event. An administrator can link explicitly (Users > Link to provider
  identity). This blocks takeover of a local administrator by someone whose provider account has the same email.
- A federated user has no usable password. Disabling the user (or removing the identity) blocks sign-in.

### 4.5 Sessions and MFA
The instance issues its normal access token and rotating refresh cookie, with a new claim `amr` and `idp` recorded in the session row. Federated
sessions have an absolute maximum age (default 12 hours, setting in Platform settings) after which the person signs in again at the provider.
Local TOTP is not asked for federated sessions (the provider did MFA, and the `amr` claim proves it when required).

### 4.5a Settings screen
Administration > Platform settings > **Single sign-on** (SUPER_ADMIN only, new permission `sso:manage`): list providers; per provider the fields in
4.1 with plain-language help; a "Test sign-in" button; the `hub` provider shown as "Voxshift Hub" with the off-by-default switch. Every change is
audited.

### 4.6 Break glass
SUPER_ADMIN users created locally (including the bootstrap administrator the setup is started with) keep local password + TOTP sign-in even when
`allow_local_passwords = false` (flag `break_glass`, default true for local SUPER_ADMINs). The setting is explained in the UI and in `docs/SECURITY.md`.

### 4.7 Revocation
- The `hub` provider: the heartbeat reply carries `ssoRevocations` (a list of `{sub, before}`, see section 5.3). The worker applies them: sessions
  of that identity created before `before` are revoked and the user is disabled if the hub says the grant was removed.
- Any provider: a user whose role would now exceed the ceiling, or whose identity row is removed or user disabled, is signed out at the next
  token refresh (access tokens last 15 minutes).
- Optional later: OIDC back-channel logout endpoint for generic providers.

### 4.8 Audit and logging
Audit events (platform audit): `sso.login.success`, `sso.login.refused` (reason code, never the token), `sso.user.created`, `sso.user.linked`,
`sso.provider.changed`, `sso.revoked`. Each carries provider, subject, email and the hub's session id where available.

## 5. Hub side (private repository)

### 5.1 Who has accounts
Hub users get a `kind`: `staff` (Voxshift/MSP; today's ADMIN/STAFF) or `customer` (a customer's own people). Customer users can only see and open
the installations they are granted and nothing else in the hub (no instance list for others, no audit, no people). Both need password + authenticator
code (existing). The grant table `user_instances` gains `role` (one of `SUPER_ADMIN`, `PROJECT_MANAGER`, `ENGINEER`, `CUSTOMER`; the instance
applies its own ceiling to it) and `granted_at`/`granted_by` stay. Hub administrators manage grants in the existing People screen. Creating
customer users uses the hub's invitation flow (mail relay) and the same password + TOTP enrolment as staff.

### 5.2 Provider endpoints
Served from `https://hub.voxshift.io`:
- `GET /.well-known/openid-configuration` (issuer `https://hub.voxshift.io`), `GET /oidc/jwks`, `GET /oidc/authorize`, `POST /oidc/token`.
- **Clients are instances**: `client_id` = the instance id; the secret is the instance token (the hub already stores only its hash and checks it in
  constant time, as for the heartbeat); client authentication `client_secret_basic` or `client_secret_post`. Registered redirect URIs are derived
  from the instance record: `<base_url>/api/auth/oidc/callback` and `https://<slug>.<hub domain>/api/auth/oidc/callback`; exact match only.
- Authorization code (single use, 60 s), PKCE S256 required, `response_type=code` only, scopes `openid email profile`, no refresh tokens, no
  consent screen (the grant is the consent). If the person has no hub session the normal hub login (password + authenticator) runs first and
  returns to authorize. If the person has no grant for that instance: a clear "you do not have access to this installation" page and an audit event.
- ID token (ES256, `kid`, 5 minute lifetime): `iss`, `sub` (hub user id), `aud` (instance id), `iat`, `exp`, `nonce`, `jti`, `email`,
  `email_verified: true`, `name`, `amr` (`["pwd","otp","mfa"]`), `auth_time`, **`vx_role`** (the grant's role), `vx_kind` (`staff` | `customer`).
- Signing keys: generated by the hub, stored encrypted (like other hub secrets), rotated on demand and automatically, previous key kept in the
  JWKS until all its tokens have expired.
- A hub-side switch per instance ("allow SSO", default on, but the instance still needs its own switch on) and the global hub kill switch.
- Audit at the hub: authorize, token issued (instance, user, role), refused (reason).

### 5.3 Revocation channel
The heartbeat reply gains `ssoRevocations: [{ sub, before }]`: entries for users whose grant for that instance was removed, who were disabled, or
whose sessions were revoked since the instance's last acknowledged heartbeat. Entries are kept for 7 days; the heartbeat request carries
`ssoRevocationsAck` (the highest id applied). This works whether or not remote access (the tunnel) is on.

## 6. Security analysis

| Threat | Control |
|---|---|
| Hub compromised or hub admin abuse | Instance has its own switch (off until enabled), role ceilings the customer can lower, break-glass local admin, audit and administrator-sign-in notification on both sides; tokens are 5 minutes, audience-bound, single use. A compromised hub could sign in to instances that trust it, up to their ceiling (administrator for staff accounts by default), which is why trusting it is the customer's explicit choice and why the customer can lower the staff ceiling. Phase 3 adds customer-approved, time-limited administrator access. |
| Token or code replay / theft | PKCE, `nonce`, single-use code and `jti`, TLS, exact redirect URI, back-channel code exchange. |
| Open redirect / redirect URI abuse | Exact-match registered URIs derived from the instance record. |
| Account takeover via matching email | No automatic linking; explicit administrator link. |
| Role escalation | Ceilings applied on the instance and editable by the customer; hub staff may reach `SUPER_ADMIN` by default (they do the setup), customer hub users and generic providers are capped lower; every provider sign-in as administrator is audited and notified; role re-evaluated each sign-in. |
| Stale access after removal | Heartbeat revocations (about a minute), 15 minute access tokens, 12 hour absolute session cap. |
| Algorithm confusion / key substitution | Algorithm allow-list, key by `kid` from the pinned issuer's JWKS only, never accept `none`/HS256. |
| Hub outage | Local sign-in unaffected; federated sessions already open continue until their cap. |
| Credential exposure | No password or secret crosses the boundary; provider client secrets are encrypted at rest. |

## 7. Phases and acceptance

1. **Instance relying party (this repository)**: sections 4.1-4.6 and 4.8 for generic OIDC providers, including the hub provider record and the
   login-page buttons, with tests (a fake provider with a JWKS in the test suite: success, wrong `aud`/`iss`/`nonce`/expired/`alg=none`, replay,
   unlinked email, ceiling, break glass, disabled user). Works end to end with Microsoft Entra ID.
2. **Hub as provider (private repository)**: section 5.1-5.2 and the Open button flow, with tests (PKCE, redirect URI exact match, single use,
   grant checks, key rotation).
3. **Lifecycle**: 4.7 and 5.3 (revocation), session cap, hub-side customer users and invitations, customer-approved or time-limited
   administrator access (optional).
4. Later: SAML, SCIM, delegated customer administration, tenant claim mapping.

Done means: a hub account assigned to an installation clicks Open and lands signed in (no second prompt), a Voxshift staff account with the
administrator grant gets `SUPER_ADMIN` on a freshly connected installation and a customer account does not, a removed account is out within about
a minute, a customer can lower the staff ceiling or turn the hub provider off and local sign-in still works, a customer can add Entra ID and sign in with it, and
`docs/SECURITY.md`, the on-premises guide and the hub documentation describe it.

## 8. Phase 1 as built (this repository, 2026-10-18)

Everything in sections 4.1-4.6 and 4.8 works for the Voxshift Hub and for generic OpenID Connect providers, with tests. Nothing in section 5 (the hub side) is here. Phase 3 (4.7's hub revocation channel, customer-approved or time-limited administrator access, back-channel logout) is not built, except the parts that need no hub: **a lowered ceiling, a provider switched off, an identity removed or a disabled user signs the person out at their next token refresh** (`sso.revoked`, reasons `ceiling-lowered`, `provider-off`, `identity-removed`, `user-disabled`).

### Where things are

| What | Where |
|---|---|
| Tables, `users.break_glass`, session columns, settings | `packages/db/migrations/platform/0031_sso.sql`, types in `packages/db/src/schema.ts`; `packages/db/src/sso-settings.ts` |
| Roles, ceiling, return-path check, DTOs, plain-language refusal messages | `packages/shared/src/sso.ts`; permission `sso:manage` in `rbac.ts` (Super Admin only) |
| OIDC client (discovery, PKCE, code exchange, ID token verification, JWKS cache, state cookie) | `apps/api/src/sso/oidc/` (library `jose` 5.10.0, pinned) |
| Sign-in rules (users, roles, replay, audit, notice email) | `apps/api/src/sso/sso-signin.service.ts` |
| Endpoints | `GET /api/auth/providers`, `GET /api/auth/oidc/login`, `GET /api/auth/oidc/callback` (`sso-auth.controller.ts`); the administrator API under `/api/sso/...` (`sso-admin.controller.ts`) |
| Hub provider record | `apps/api/src/sso/hub-provider.ts`, called by the hub connection code in `platform-settings.service.ts` |
| Federated sessions, refresh-time checks, local-password gate | `apps/api/src/auth/auth.service.ts`, `token.service.ts`, `jwt-auth.guard.ts` |
| Screens | login page (`apps/web/src/pages/Login.tsx`), Platform settings > Single sign-on (`pages/admin/Sso.tsx`, route `/admin/settings/sso`), Users > Link to provider identity (`pages/admin/LinkIdentityDialog.tsx`) |
| Tests | `apps/api/src/sso/**/*.test.ts` (token verification, state cookie, roles), `packages/shared/src/sso.test.ts`, and `tests/db/src/sso/*.db.test.ts` (the whole flow against a stand-in provider on a local port) |

### Added to, or made more precise than, the contract above

These are the places the build went beyond or interpreted the text. The hub side should not need to change for any of them, except where marked **(hub)**.

- **Role order.** "The lower of the requested role and the ceiling" uses the order the roles are listed in: `SUPER_ADMIN` > `PROJECT_MANAGER` > `ENGINEER` > `CUSTOMER` (`capRole` in `packages/shared/src/sso.ts`). So a ceiling of `ENGINEER` (the default for the hub's customer accounts) also caps `PROJECT_MANAGER` at `ENGINEER`, and a ceiling of `PROJECT_MANAGER` (the generic default) allows `PROJECT_MANAGER`, `ENGINEER` and `CUSTOMER`.
- **`default_role` defaults to `CUSTOMER`** (least privilege). It applies when the hub sends no valid `vx_role`, or a generic provider has no role claim or nothing matches. If the hub's `vx_kind` is missing or unknown, the **lower** of the two hub ceilings applies. **(hub)** always send `vx_role` and `vx_kind`.
- **Role is provider-managed.** At every sign-in the user's role is set to the effective role, for users created by the provider and for users an administrator linked. A role set by hand in Users does not survive the next sign-in.
- **Break-glass accounts are never federated.** An administrator cannot link a break-glass account (a locally created Super Admin), and a sign-in whose identity row points at one is refused (`break_glass_local_only`). They keep password + authenticator, always.
- **Local passwords:** `allow_local_passwords = false` on an **enabled** provider hides the form for everyone except break-glass accounts; with several providers it is off if any enabled provider says so. Saving it with the provider on is refused unless an active break-glass administrator with a password exists. A password sign-in for a non-break-glass account is refused only after the password is right (so it does not reveal who is break-glass).
- **`GET /api/auth/providers`** returns `{ providers: [{ id, name, kind }], localPasswords }`: the list is exactly id, name and kind as agreed; `localPasswords` is what the login page needs to hide the form.
- **Extra columns and tables** beyond 4.1 and 4.4: `external_identities.account_kind` (the hub's `vx_kind` at the last sign-in, so a lowered staff or customer ceiling applies at the next refresh); `sso_providers.last_test_at/ok/detail`; `platform.sso_link_requests` (sign-ins refused because the email exists, offered to the administrator, so nobody has to look up a provider's subject by hand; manual entry by subject is also possible); `platform.sso_replay_guard` (single use of codes and `jti`); `app_settings.sso_session_max_hours` (default 12) and `sso_notify_admin_signin` (default on).
- **Hub provider lifecycle.** Created by connecting to a hub, **disabled**. A new token for the same hub keeps its switch and ceilings. Connecting to a different hub address disables it, deletes its identities and waiting sign-ins and revokes its sessions (a `sub` from one hub must never be taken for the same person at another). Disconnecting disables it. It cannot be enabled without a hub connection, and its name, issuer, client id and secret cannot be edited on the SSO screen.
- **The heartbeat reports hub sign-in.** The heartbeat body gains an optional boolean `sso` (`packages/shared/src/hub-connection.ts`, `buildHubHeartbeat`; `apps/worker/src/hub-heartbeat.ts`): `true` exactly when the `hub` provider row exists and is enabled, `false` otherwise, omitted when the installation cannot tell (table missing or query failed). The hub uses it to show the Open button's one-click sign-in only for installations that have it (otherwise `/api/auth/oidc/login` would not exist, or the provider would be off). Every other field is unchanged. **(hub)** the heartbeat schema must allow `sso`; deploy the hub before the instance.
- **Connections made before this release.** An installation that was connected to a hub before single sign-on existed has no hub provider record, and its stored token is masked so it cannot simply reconnect. `ensureHubProvider` (`apps/api/src/sso/hub-provider.ts`) creates the record, switched off, from the saved connection (hub address, the instance id inside the token, the decrypted token as secret) when the API starts and whenever the SSO settings, the login-page list or `?provider=hub` are read; it only ever creates, never touches an existing record, so an administrator's switch and ceilings are safe.
- **Hub gate address.** When the request arrived on `<slug>.<hub domain>` (the host is one DNS label under the host of the hub address), the hub provider's redirect URI is `https://<that host>/api/auth/oidc/callback`; every other provider, and every other host, uses the base URL. The state cookie belongs to the host the sign-in started on, so the whole round trip stays on one host. Leave `COOKIE_DOMAIN` empty if people reach the installation through the gate (as for password sign-in today).
- **Test sign-in.** The Test button asks for a two-minute ticket (`POST /api/sso/providers/:id/test`, `sso:manage`), then does a real sign-in at the provider. At the callback it verifies everything, creates no user and no session, and stores what it found on the provider (`last_test_*`); the screen shows it. A disabled provider can be tested.
- **Email claim.** `email` is used; if absent, `preferred_username` when it looks like an email (Entra ID often sends the sign-in name). `email_verified: false` refuses the sign-in; absent is accepted. Domain allow-list applies to every sign-in.
- **Session marker.** The access token carries `idp` (provider id) and `amr`; the guard skips the local-TOTP-enrolment check only for a token that carries `idp`. `GET /api/auth/me` returns `signInMethod` (`local` | `sso`) and `ssoProviderName`.
- **Audit extras:** `sso.user.unlinked`; a test sign-in is recorded as `sso.provider.changed` with `change: "test sign-in"`; `sso.revoked` is written when a refresh signs someone out (reason code in the detail). The hub's session id is taken from the optional `sid` claim and shown in the notice email and in `sso.login.success`. **(hub)** sending `sid` is optional but useful.
- **What the hub must serve exactly** (the instance follows **no redirects** on discovery, JWKS or token requests, and allows only `https`, or `http` on a loopback address for tests): `GET <issuer>/.well-known/openid-configuration` whose `issuer` equals the configured hub address (a trailing slash is ignored), with `authorization_endpoint`, `token_endpoint` and `jwks_uri`; the token endpoint authenticates the client with `client_secret_basic` (used unless the document lists only `client_secret_post`) and answers JSON with `id_token`; the ID token is signed RS256, ES256 or EdDSA with a `kid` that is in the JWKS, has `iss`, `aud` (the instance id), `sub`, `iat`, `exp` (the instance allows 60 seconds of skew), `nonce`, and, because the hub provider requires it by default, `amr` containing `mfa`, `otp` or `hwk`. Scopes requested: `openid email profile`.
- **Entra ID needs the tenant-specific issuer** (`https://login.microsoftonline.com/<directory ID>/v2.0`), not `common` or `organizations`: the issuer in the discovery document must match what is configured.

- **Content-Security-Policy is unchanged** (`apps/web/security-headers.conf`): the flow is full-page redirects (the login button is a link, the callback is a redirect), so it needs no new `connect-src`, `form-action` or `frame-ancestors` entry; the browser only ever talks to this installation's own address and to the provider's page it is redirected to. The web build and the flow were checked with the policy as it is.

### Setting up Microsoft Entra ID (for the customer's administrator)

1. In the Entra admin center: App registrations > New registration. Name it for example "Voxshift". Supported account types: this directory only. Redirect URI: platform **Web**, value = the "Redirect address to register" shown on Platform settings > Single sign-on > Add a provider (it is `<base URL>/api/auth/oidc/callback`).
2. Certificates & secrets > New client secret. Copy the **value** now (it is shown once).
3. Token configuration > Add optional claim > ID > `email` (so the address arrives as `email`). Optional: Add groups claim, or define App roles (Voxshift Admins and so on) and assign people, to use the role map.
4. In Voxshift: Platform settings > Single sign-on > Add a provider. Provider address `https://login.microsoftonline.com/<Directory (tenant) ID>/v2.0`, Client ID = Application (client) ID, the secret. Choose the highest role, and optionally the role claim (`roles` for app roles) and role map lines such as `Voxshift Admins = Administrator`.
5. Press **Test sign-in**, sign in with a work account, and check the result. Turn the provider on only when it works. (Entra reports `mfa` in `amr` when the sign-in used MFA; if your tenant does not enforce MFA the provider will be refused with "did not confirm two-step verification" unless you turn that requirement off for this provider.)

### Still to do

Phase 2 (the hub as provider) and phase 3 (hub revocation channel, customer-approved or time-limited administrator access, back-channel logout), and in the later list SAML, SCIM, delegated administration and tenant claim mapping. Also not done: signing out of the provider when signing out here (local logout only), and per-provider tenant (customer) membership mapping: a `CUSTOMER` signs in with no customer memberships and an administrator adds them, as for any customer user.
