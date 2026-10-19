# Single sign-on (OpenID Connect) - design

Status: **phases 1 and 2 built and deployed 2026-10-19; phase 3 built 2026-10-19 (not yet deployed at the time of writing).** The instance side (this repository) and the hub side (private repository `voxshift-hub`) are both built; section 8 describes what exists, what was added to the contract while building it, and what is left. Phase 3 is the hub's revocation channel (removing a person at the hub reaches an installation within about a minute) and customer-approved, time-limited access for Voxshift hub staff accounts; OIDC back-channel logout was deliberately left out (section 8, "Phase 3 as built"). For the person setting it up, start with [SSO-ADMIN-GUIDE.md](SSO-ADMIN-GUIDE.md). Owner decision: hub accounts (staff AND customers) can sign in to Voxshift installations without a second
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
- Removing someone at the hub takes effect quickly everywhere: new sign-ins stop at once and, through the revocation channel (4.7), an open session on an installation ends within about a minute. (Removing someone at a customer's own provider ends their session here at the next 15-minute token refresh; the hub's push channel exists only for the hub.)
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
    can sign in as: Administrator") and can lower it, for example to `ENGINEER` for day-to-day work, and can require approval for every staff sign-in (4.3a).
  - `role_ceiling_customer` (the customer's own people with hub accounts): default **`ENGINEER`**; a customer administrator can raise it.
- **Generic `oidc` providers** (customer's own identity provider): one `role_ceiling`, default `PROJECT_MANAGER`.
- The ceiling is always shown and editable by an administrator of the installation (SUPER_ADMIN, permission `sso:manage`). The role is re-evaluated
  at every sign-in and a lowered ceiling applies at the next sign-in (and revokes sessions above it, see 4.7).
- Every sign-in with the `SUPER_ADMIN` role through a provider is audited with the provider, the person and the hub's session id, and (if
  configured) emailed to the installation's administrators.

`CUSTOMER` users sign in with no customer (tenant) memberships; an administrator adds memberships afterwards (as for any customer user today). A
later version may carry tenant mapping in a claim.

### 4.3a Voxshift staff access: approval and time limit
The hub provider has one more setting, chosen by an administrator of the installation (Platform settings > Single sign-on, "Voxshift staff access"): `staff_access` = `allowed` (the default: nothing changes), `needs_approval`, or `off`. It applies to a hub sign-in whose `vx_kind` is not `customer` (so `staff`, and also a missing or unknown kind, the stricter reading). The customer's own people with hub accounts (`vx_kind: customer`), the customer's own providers and local accounts (break-glass included) are never affected.
- **`off`**: a staff sign-in is refused (`staff_access_off`, shown as "This installation has switched off sign-in for Voxshift staff"); no account is created.
- **`needs_approval`**: the sign-in is verified in full (token, MFA claim, domain, no linking by email, ceiling, user rules) and then **no session is created**. A request (`platform.sso_access_requests`) is made, every active Super Admin who did not come in through the hub is emailed (`sso_staff_access_request`), and the browser is sent to the page `/sso/waiting`, holding a random wait token in an HttpOnly cookie (`tvmf_staff_wait`, path `/api/auth/staff-access`; only its hash is stored). An administrator **approves** for a number of hours (default 4, 1 to 24) or **denies**; an unanswered request lapses after 60 minutes. On approval the waiting page asks once for the session (`POST /api/auth/staff-access/continue`); the session's absolute end is the earlier of the window's end and the federated session cap, and the person's identity carries the window's end (`external_identities.access_until`), which the request guard checks on every call, so access ends exactly then (not at the next refresh). Another sign-in inside a running window needs no new request and ends with the same window. When the window ends the person must ask again.
- **Who decides**: an administrator (`sso:manage`) who did **not** sign in through the Voxshift Hub: local password sign-in or the customer's own provider. Otherwise the person asking, or a colleague, could approve themselves. The same rule protects the setting: any administrator may **tighten** it, only one who did not come in through the hub may **loosen** it (from `off` or `needs_approval` towards `allowed`), so approved staff cannot switch the approval off for themselves.
- **Changing the setting acts at once**: moving to `needs_approval` or `off` signs out every hub staff person who is in (the customer's own people stay), closes waiting requests and running windows (`cancelled`); moving to `allowed` closes them and removes every window limit.
- **An administrator can end a window early** (End now): the person is signed out immediately.
- A window gives the person the role the ceiling allows for the time chosen: **an approved administrator window is full administrator access** (they can change settings and add users like any administrator; the audit log shows it). Approve only what you expect, check Users afterwards, and lower the staff ceiling to Engineer when the work does not need administrator rights.
- Audit (platform audit log): `sso.access.requested`, `sso.access.approved`, `sso.access.denied`, `sso.access.expired` (`stage` `window` or `request`), `sso.access.ended` (ended early, or closed because the setting changed), plus the usual `sso.login.success` (with `accessRequestId` and `accessWindowEndsAt`) and `sso.revoked` (`staff-access-restricted`, `access-window-ended`).
- A person who asks again straight after a denial is shown the denial again for 10 minutes instead of starting a new request, so a refusal cannot become a stream of emails.

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
Three mechanisms, from fastest to slowest:
- **The hub's revocation channel (built, phase 3).** The heartbeat reply carries `ssoRevocations` (lines `{id, sub, before, reason}`, see 5.3). The worker (`apps/worker/src/hub-heartbeat.ts`, applied by `applySsoRevocations` in `packages/db/src/sso-revocations.ts`) applies them: for the identity with that `sub` on the hub provider, every sign-in that began **before** `before` is over. Two things make that immediate rather than "at the next refresh": the identity's `revoked_before` is set to `before`, which the request guard (`JwtAuthGuard`) checks on every call made with a provider session (an access token issued at or before that second stops working), and the refresh cookies of those sign-ins are revoked. What else a line does depends on its reason:
  - `grant_removed` (the person's access to this installation was taken away at the hub; audit reason `hub-grant-removed`): an account that exists **only through the hub** (it has no password) is **switched off**; a local account that an administrator **linked** to the hub identity (it has its own password) is **unlinked** and otherwise left alone. If the person has signed in again since the line's time (access was given back), only the sessions step applies, so a replayed old line cannot disable someone who is back.
  - `user_disabled` (`hub-user-disabled`), `sessions_revoked` (a password or authenticator reset, a password change, `hub-session-revoked`) and `role_changed` (a grant's role or an account's kind changed, `hub-role-changed`): sessions end and nothing else is touched. The hub will not vouch for a disabled person, and after a role change the next sign-in simply gets the new role.
  - Nothing happens for a `sub` this installation has never seen, break-glass accounts are never touched (they are never federated), and local password sessions of a linked account are not hub sign-ins and are not ended.
- Any provider: a user whose role would now exceed the ceiling, whose identity row is removed, whose approved staff window has ended, or who is disabled, is signed out at the next token refresh (access tokens last 15 minutes). A removed identity or an ended window now also stops the access token at once (the guard checks the identity on every call).
- Optional later: OIDC back-channel logout endpoint for generic providers (not built).

### 4.8 Audit and logging
Audit events (platform audit): `sso.login.success`, `sso.login.refused` (reason code, never the token), `sso.user.created`, `sso.user.linked`,
`sso.provider.changed`, `sso.revoked`, and (4.3a) `sso.access.requested`, `sso.access.approved`, `sso.access.denied`, `sso.access.expired`, `sso.access.ended`. Each carries provider, subject, email and the hub's session id where available.

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
**Built (phase 3).** When a person loses access the hub writes one line per installation they could be signed in to (`sso_revocations` in the hub's database): the installations they hold a grant for, plus any they completed a sign-in to in the last week. What queues a line: a grant removed (`grant_removed`, only that installation), a person switched off (`user_disabled`), a password or authenticator reset or the person changing their own password (`sessions_revoked`), a grant's role changed or an account's kind changed (`role_changed`). A hub sign-out by the person themselves does not.

The heartbeat reply gains `ssoRevocations: [{ id, sub, before, reason }]`: `sub` is the hub user id (the ID token's `sub`), `before` an ISO time on the hub's clock, `id` increasing, `reason` one of `grant_removed`, `user_disabled`, `sessions_revoked`, `role_changed` (an unknown reason is read as `sessions_revoked`). The request carries `ssoRevocationsAck` (the highest id applied; `0` before any). Lines are kept for 7 days and sent oldest first, at most 200 a reply, repeated until acknowledged. This works whether or not remote access (the tunnel) is on: it rides on the heartbeat every installation already sends, so a removal at the hub reaches the installation within about a minute.

Compatibility, both ways:
- The field is **optional on both sides** (the hub's strict `heartbeatSchema` allows `ssoRevocationsAck`; `buildHubHeartbeat` leaves it out when unknown). The hub only adds `ssoRevocations` to the reply when the request had `ssoRevocationsAck`, so an older installation gets exactly the reply it always did.
- An older **hub** refuses a heartbeat with a field it does not know (400). The worker then sends the same report again at once without the field, and leaves it out for an hour before trying again, so nobody has to deploy the hub first (still advisable).
- An acknowledgement the hub never issued (restored from an older copy; another hub) is treated as "nothing acknowledged" by the hub, so lines are never missed; applying a line twice does no harm. The installation forgets its acknowledgement when it is pointed at a different hub address, and never sends one when it has no hub sign-in provider record.
- A `before` further than a minute ahead of the installation's clock is cut back to that (a cut-off in the future would keep someone out of every sign-in until then); keep the server clocks right (NTP) in any case.

## 6. Security analysis

| Threat | Control |
|---|---|
| Hub compromised or hub admin abuse | Instance has its own switch (off until enabled), role ceilings the customer can lower, break-glass local admin, audit and administrator-sign-in notification on both sides; tokens are 5 minutes, audience-bound, single use. A compromised hub could sign in to instances that trust it, up to their ceiling (administrator for staff accounts by default), which is why trusting it is the customer's explicit choice and why the customer can lower the staff ceiling. Customer-approved, time-limited staff access (4.3a) lets the customer require approval for every staff sign-in, for a time they choose, or switch staff off. |
| Token or code replay / theft | PKCE, `nonce`, single-use code and `jti`, TLS, exact redirect URI, back-channel code exchange. |
| Open redirect / redirect URI abuse | Exact-match registered URIs derived from the instance record. |
| Account takeover via matching email | No automatic linking; explicit administrator link. |
| Role escalation | Ceilings applied on the instance and editable by the customer; hub staff may reach `SUPER_ADMIN` by default (they do the setup), customer hub users and generic providers are capped lower; every provider sign-in as administrator is audited and notified; role re-evaluated each sign-in. |
| Stale access after removal | The hub's revocation channel (4.7, 5.3): a removal, a switch-off, a reset or a role change at the hub ends the person's sessions here within about a minute, access tokens included. Backstops: new hub sign-ins are refused at once at the hub; an administrator here can disable the user (immediate) or unlink them (immediate); a lowered ceiling or provider switched off ends sessions at the next 15-minute refresh; the federated session ends by itself at its absolute cap (12 hours by default), and an approved staff window at its end. |
| Algorithm confusion / key substitution | Algorithm allow-list, key by `kid` from the pinned issuer's JWKS only, never accept `none`/HS256. |
| Hub outage | Local sign-in unaffected; federated sessions already open continue until their cap (removals at the hub cannot reach the installation while it cannot hear the hub, and are applied, from the hub's week-long record, when it can). |
| Hub staff approving themselves, or turning the approval off | The people who decide are administrators who did not come in through the hub; the setting can be tightened by any administrator but loosened only by one who did not come in through the hub (4.3a). |
| Credential exposure | No password or secret crosses the boundary; provider client secrets are encrypted at rest. |

## 7. Phases and acceptance

1. **Instance relying party (this repository)** - built 2026-10-18: sections 4.1-4.6 and 4.8 for generic OIDC providers, including the hub provider record and the
   login-page buttons, with tests (a fake provider with a JWKS in the test suite: success, wrong `aud`/`iss`/`nonce`/expired/`alg=none`, replay,
   unlinked email, ceiling, break glass, disabled user). Meant to work with Microsoft Entra ID; it has been tested against a stand-in provider and the Voxshift Hub, not yet against a live Entra tenant.
2. **Hub as provider (private repository)** - built and deployed 2026-10-18/19: section 5.1-5.2 and the Open button flow, with tests (PKCE, redirect URI exact match, single use,
   grant checks, key rotation).
3. **Lifecycle** - built 2026-10-19: 4.7 and 5.3 (revocation through the heartbeat reply) and 4.3a (customer-approved, time-limited access for Voxshift staff accounts), with tests on both sides (a removal reaches the installation and ends the session, the acknowledgement advances, older hubs and older installations keep working; approval, denial, expiry, ending early, break-glass untouched). Back-channel logout was not built. (The session cap, hub-side customer users and invitations from this item were built in phases 1 and 2.)
4. Later: SAML, SCIM, delegated customer administration, tenant claim mapping.

Done means: a hub account assigned to an installation clicks Open and lands signed in (no second prompt), a Voxshift staff account with the
administrator grant gets `SUPER_ADMIN` on a freshly connected installation and a customer account does not, a removed account is out within about
a minute, a customer can lower the staff ceiling or turn the hub provider off and local sign-in still works, a customer can add Entra ID and sign in with it, and
`docs/SECURITY.md`, the on-premises guide and the hub documentation describe it.

## 8. As built (phases 1 and 2, 2026-10-18 and 2026-10-19; phase 3 below)

Everything in sections 4.1-4.6 and 4.8 works for the Voxshift Hub and for generic OpenID Connect providers, with tests, and the hub side (section 5.1 and 5.2) is built and deployed in the private `voxshift-hub` repository (see its `docs/ARCHITECTURE.md`). A live test on 2026-10-19 signed a hub **customer** account in to an installation with no second prompt (role Engineer, the customer ceiling) and an administrator's **Test sign-in** worked; the staff-account sign-in as Administrator with a non-conflicting email, and a live Microsoft Entra ID tenant, have not yet been exercised. Phase 3 (the hub's revocation channel and customer-approved, time-limited staff access) is described at the end of this section. Before it, and still true for a customer's own provider: **a lowered ceiling, a provider switched off, an identity removed or a disabled user signs the person out at their next token refresh** (`sso.revoked`, reasons `ceiling-lowered`, `provider-off`, `identity-removed`, `user-disabled`; a disabled user is also refused on the very next request).

### What changed since the design

The decisions below were taken while building and are all reflected in the text that follows.

- **Customer ceilings.** The hub provider has two ceilings chosen by the ID token's `vx_kind`: `role_ceiling_staff` (default `SUPER_ADMIN`) and `role_ceiling_customer` (default `ENGINEER`), both editable by the installation's administrator; generic providers have one (`PROJECT_MANAGER`). If `vx_kind` is missing the lower applies.
- **The `sso` heartbeat field.** The heartbeat carries an optional boolean `sso` (hub provider exists and is on). The hub's Open button goes to the installation's hub sign-in only when it is true.
- **Smart Open.** The hub's Open chooses between the installation's own address and the hub tunnel itself (same network, or a browser test of `<base URL>/version.json`); manual items exist. `/version.json` therefore stays public and uncached.
- **Customers on the tunnel.** The remote-access switch ("People with a hub account can open this installation through the hub") covers every hub account, customers included; the ceiling is chosen by `vx_kind`, identically on the base URL and on the gate address.
- **Backfill of the hub provider.** An installation connected to a hub before single sign-on existed gets its (switched off) hub provider record created from the saved connection, at API start and when the settings or login list are read.
- **Roles are provider-managed, break-glass accounts are never federated, `default_role` is `CUSTOMER`** (details below).
- **Hub side:** grants carry a role; accounts have a kind; invitations by email; signing key rotation; kill switches (hub-wide and per installation); the retired signing key stays published for 10 minutes. The hub always sends `vx_role`, `vx_kind` and `sid`.

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
- **How break-glass is given (decided 2026-10-19).** A Super Admin **created under Users** is break-glass. An account that is **created by a provider** (just-in-time) is never break-glass: it has no password, and a provider must not be able to mint an account that bypasses the provider. A **local account that becomes Super Admin later** (a promotion, or a role the provider sends for a linked account) is not changed silently: a Super Admin gives or removes break-glass on purpose with **Users > ... > Make break-glass / Remove break-glass** (`POST /api/users/:id/break-glass {enabled}`, `sso:manage`, audited as `user.break_glass_changed`). It is refused for a non-Super-Admin, for an account with no local password, and for an account linked to a provider (break-glass accounts are never federated); removing it is refused for the last break-glass administrator while local passwords are off. The "no password path" case (only provider-created administrators exist) cannot arise while local passwords are off, because switching them off needs an active break-glass administrator with a password, and the last one is protected.
- **Local passwords:** `allow_local_passwords = false` on an **enabled** provider hides the form for everyone except break-glass accounts; with several providers it is off if any enabled provider says so. Saving it with the provider on is refused unless an active break-glass administrator with a password exists. A password sign-in for a non-break-glass account is refused only after the password is right (so it does not reveal who is break-glass).
- **Resend invitation never touches a provider-only account.** Users > Resend invitation issues a new temporary password. For an account whose stored hash is the `!federated` marker (it signs in only through a provider) it is refused (400) and changes nothing, so a person with `user:create` (an Engineer, for customer-role users) cannot give such an account a local password and so turn it into a local one that bypasses the provider's MFA and role limits. The Users list returns `has_password`, and the screen hides the action for those accounts.
- **`GET /api/auth/providers`** returns `{ providers: [{ id, name, kind }], localPasswords }`: the list is exactly id, name and kind as agreed; `localPasswords` is what the login page needs to hide the form.
- **Extra columns and tables** beyond 4.1 and 4.4: `external_identities.account_kind` (the hub's `vx_kind` at the last sign-in, so a lowered staff or customer ceiling applies at the next refresh); `sso_providers.last_test_at/ok/detail`; `platform.sso_link_requests` (sign-ins refused because the email exists, offered to the administrator, so nobody has to look up a provider's subject by hand; manual entry by subject is also possible); `platform.sso_replay_guard` (single use of codes and `jti`); `app_settings.sso_session_max_hours` (default 12) and `sso_notify_admin_signin` (default on).
- **Hub provider lifecycle.** Created by connecting to a hub, **disabled**. A new token for the same hub keeps its switch and ceilings. Connecting to a different hub address disables it, deletes its identities and waiting sign-ins and revokes its sessions (a `sub` from one hub must never be taken for the same person at another). Disconnecting disables it. It cannot be enabled without a hub connection, and its name, issuer, client id and secret cannot be edited on the SSO screen.
- **The heartbeat reports hub sign-in.** The heartbeat body gains an optional boolean `sso` (`packages/shared/src/hub-connection.ts`, `buildHubHeartbeat`; `apps/worker/src/hub-heartbeat.ts`): `true` exactly when the `hub` provider row exists and is enabled, `false` otherwise, omitted when the installation cannot tell (table missing or query failed). The hub uses it to show the Open button's one-click sign-in only for installations that have it (otherwise `/api/auth/oidc/login` would not exist, or the provider would be off). Every other field is unchanged. **(hub)** the heartbeat schema must allow `sso`; deploy the hub before the instance.
- **Opening through the hub tunnel is for every hub account, not only staff.** The installation's remote-access switch reads "People with a hub account can open this installation through the hub". Nothing on the instance side assumes the person is staff: the role ceiling is chosen by the ID token's `vx_kind` (`role_ceiling_staff` or `role_ceiling_customer`), identically whether the browser came in on the base URL or on the gate address (`https://<slug>.<hub domain>`), which only changes the redirect URI. A test covers a customer-kind identity on the gate address (`tests/db/src/sso/roles-and-hub.db.test.ts`).
- **`GET /version.json`** (served by the web nginx, `apps/web/nginx.conf`) is public, outside the API's sign-in, and sent `Cache-Control: no-store`; the hub's browser reachability probe relies on that, so it must stay unauthenticated and uncached.
- **Connections made before this release.** An installation that was connected to a hub before single sign-on existed has no hub provider record, and its stored token is masked so it cannot simply reconnect. `ensureHubProvider` (`apps/api/src/sso/hub-provider.ts`) creates the record, switched off, from the saved connection (hub address, the instance id inside the token, the decrypted token as secret) when the API starts and whenever the SSO settings, the login-page list or `?provider=hub` are read; it only ever creates, never touches an existing record, so an administrator's switch and ceilings are safe.
- **Hub gate address.** When the request arrived on `<slug>.<hub domain>` (the host is one DNS label under the host of the hub address), the hub provider's redirect URI is `https://<that host>/api/auth/oidc/callback`; every other provider, and every other host, uses the base URL. The state cookie belongs to the host the sign-in started on, so the whole round trip stays on one host. Leave `COOKIE_DOMAIN` empty if people reach the installation through the gate (as for password sign-in today).
- **Test sign-in.** The Test button asks for a two-minute ticket (`POST /api/sso/providers/:id/test`, `sso:manage`). The call returns only the address to open (`/api/auth/oidc/login?provider=<id>&returnTo=...`); the ticket itself is set as an HttpOnly, `SameSite=Lax` cookie `tvmf_oidc_test` scoped to `/api/auth/oidc` with a two-minute life, so it is **never in an address** (browser history, proxy and access logs, `Referer`). The login route reads it, clears it at once (single use), and checks it names the same provider; a missing, forged, expired or other-provider ticket simply makes this an ordinary sign-in. It then does a real sign-in at the provider. At the callback it verifies everything, creates no user and no session, and stores what it found on the provider (`last_test_*`); the screen shows it. A disabled provider can be tested.
- **Email claim.** `email` is used; if absent, `preferred_username` when it looks like an email (Entra ID often sends the sign-in name). `email_verified: false` refuses the sign-in; absent is accepted. Domain allow-list applies to every sign-in.
- **Session marker.** The access token carries `idp` (provider id) and `amr`; the guard skips the local-TOTP-enrolment check only for a token that carries `idp`. `GET /api/auth/me` returns `signInMethod` (`local` | `sso`) and `ssoProviderName`.
- **Audit extras:** `sso.user.unlinked`; a test sign-in is recorded as `sso.provider.changed` with `change: "test sign-in"`; `sso.revoked` is written when a refresh signs someone out (reason code in the detail). The hub's session id is taken from the optional `sid` claim and shown in the notice email and in `sso.login.success`. **(hub)** sending `sid` is optional but useful.
- **What the hub must serve exactly** (the instance follows **no redirects** on discovery, JWKS or token requests, and allows only `https`, or `http` on a loopback address for tests): `GET <issuer>/.well-known/openid-configuration` whose `issuer` equals the configured hub address (a trailing slash is ignored), with `authorization_endpoint`, `token_endpoint` and `jwks_uri`; the token endpoint authenticates the client with `client_secret_basic` (used unless the document lists only `client_secret_post`) and answers JSON with `id_token`; the ID token is signed RS256, ES256 or EdDSA with a `kid` that is in the JWKS, has `iss`, `aud` (the instance id), `sub`, `iat`, `exp` (the instance allows 60 seconds of skew), `nonce`, and, because the hub provider requires it by default, `amr` containing `mfa`, `otp` or `hwk`. Scopes requested: `openid email profile`.
- **Entra ID needs the tenant-specific issuer** (`https://login.microsoftonline.com/<directory ID>/v2.0`), not `common` or `organizations`: the issuer in the discovery document must match what is configured.

- **Content-Security-Policy is unchanged** (`apps/web/security-headers.conf`): the flow is full-page redirects (the login button is a link, the callback is a redirect), so it needs no new `connect-src`, `form-action` or `frame-ancestors` entry; the browser only ever talks to this installation's own address and to the provider's page it is redirected to. The web build and the flow were checked with the policy as it is.

### Setting up Microsoft Entra ID, and the rest of the administrator's tasks

The step-by-step instructions (Entra ID, the ceilings, linking, break-glass accounts, sessions, removing access, remote access, audit and a table of every refusal message and audit reason code) are in **[SSO-ADMIN-GUIDE.md](SSO-ADMIN-GUIDE.md)**. That page is the one canonical copy; do not repeat the steps here.

### Phase 3 as built (2026-10-19)

Both repositories, with tests. Instance side: migrations `0032_sso_revocation.sql` and `0033_sso_staff_access.sql`; hub side: `0007_sso_revocations.sql`.

| What | Where (instance) |
|---|---|
| Heartbeat acknowledgement, reply parsing, the older-hub fallback | `packages/shared/src/hub-connection.ts` (`buildHubHeartbeat`, `parseHubRevocations`), `apps/worker/src/hub-heartbeat.ts` |
| Applying revocation lines, audit reasons `hub-*` | `packages/db/src/sso-revocations.ts` |
| Cut-off and window checks on every request; refresh-time check | `apps/api/src/auth/jwt-auth.guard.ts`, `auth.service.ts` (`federatedSessionProblem`) |
| Staff access: setting, requests, approve / deny / end, waiting page, sweep | `apps/api/src/sso/sso-staff-access.service.ts`, `sso-signin.service.ts` (`claimApproved`), `sso-auth.controller.ts` (`/auth/staff-access/status`, `/continue`), `sso-admin.controller.ts` (`/sso/access`), `packages/db/src/sso-staff-access.ts` (sweep, setting changes), `apps/web/src/pages/StaffAccessWait.tsx`, `pages/admin/Sso.tsx` |
| Tests | `tests/db/src/sso/hub-revocation.db.test.ts`, `staff-access.db.test.ts`; hub: `apps/server/test/revocations.test.ts` |

Decisions taken while building (all reflected in 4.3a, 4.7 and 5.3):

- **The revocation lines carry `id` and `reason` as well as `sub` and `before`** (the contract listed `sub` and `before`): `id` is what is acknowledged, `reason` tells the installation whether to also switch an account off. Unknown reasons are read the safe way (sessions end, nothing else).
- **Access tokens are cut off too, not only refresh cookies.** The access token is a self-contained 15-minute JWT; ending the refresh cookie alone would have left a removed person working for up to 15 minutes. The identity's `revoked_before` and `access_until` are checked on every call a provider session makes (one indexed query), so a removal is felt within the heartbeat interval. A side effect, intended: **unlinking a person now ends their access token at once** (before, within 15 minutes). The cut-off treats a token issued in the very second of the cut-off as ended (whole-second `iat`): a person who signs in again in that same second must do it once more.
- **What "grant removed" does to the account.** An account that exists only through the hub is **switched off** (so it shows as disabled under Users, not as a live administrator); a local account an administrator linked (it has a password) is **unlinked** only. Giving access back at the hub therefore needs one step here: a Super Admin switches the account on again (provider-created accounts), or links the person again (linked local accounts); the person is refused with the plain "This account is switched off" / "already exists but is not linked" message meanwhile. This is deliberate: access removed at the hub should not come back here without the customer noticing. `user_disabled`, `sessions_revoked` and `role_changed` change nothing except ending the sessions, so a person switched off and on again at the hub (a lost laptop, a password reset) simply signs in again.
- **A removal after the person signed in again is not repeated destructively.** If the identity's last sign-in is later than the line's `before`, only the session step runs. This is what makes it safe for the hub to replay a week of lines.
- **Role or kind changes at the hub also end sessions** (reason `role_changed`) so a lowered role at the hub applies at once instead of at the next sign-in.
- **The staff rule applies to every hub sign-in that is not marked `customer`**, a missing `vx_kind` included. It gates every staff sign-in, not only those that would become Administrator; the customer who wants approval only for administrator work sets the staff ceiling to Engineer and leaves approval off.
- **The account is created (just in time) when the request is made**, before approval; it has no password and no session, and a denial leaves it as it is (disable it under Users if that person should never come back). Refusals that need no approval (unlinked email, disabled, break-glass, domain) happen before any request is made. In `off` mode nothing is created.
- **Who decides is "not through the hub"** (4.3a), a simplification of "a local Super Admin": it also lets Super Admins who sign in through the customer's own provider decide. A hub *customer-kind* administrator therefore cannot; give them a local or own-provider account for this.
- **The guard and the sweep share the work.** Window ends are exact because the guard checks `access_until`; the worker's one-minute sweep (and every look at the requests) only does the bookkeeping: marking windows expired, ending refresh cookies and writing `sso.access.expired`.
- **Not done:** back-channel logout (skipped as agreed: the hub's channel covers the hub, and a customer's own provider is covered at each token refresh); showing the staff rule on the hub's Instances list (the heartbeat does not carry it; a staff member who opens such an installation sees the waiting page); the hub does not queue revocations for a deleted person or instance because the hub has no delete for people (instances cascade their lines away). Both repositories are covered by tests; nothing here has been exercised against the live hub yet.

### Still to do

SAML, SCIM, delegated administration and tenant claim mapping (the later list), and OIDC back-channel logout. Also not done: signing out of the provider when signing out here (local logout only), per-provider tenant (customer) membership mapping (a `CUSTOMER`, or any person below Administrator, signs in with no customer memberships and an administrator adds them, as for any user), WebAuthn/passkeys as a sign-in method here (the second factor is the provider's), and a live test against a real Microsoft Entra ID tenant.
