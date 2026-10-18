# Single sign-on (OpenID Connect) - design

Status: **decided 2026-10-18**, not built yet. Owner decision: hub accounts (staff AND customers) can sign in to Voxshift installations without a second
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
`DATA_ENCRYPTION_KEY`, like the SMTP password), `scopes`, `enabled`, `jit_create` (bool), `require_mfa_claim` (bool, default true), `role_ceiling`
(see 4.3), `default_role`, `role_claim` (optional claim name) and `role_map` (json: claim value to role), `email_domains` (optional allow-list),
`allow_local_passwords` (bool, default true), `created_at`/`updated_at`.
- The `hub` provider is created automatically when the instance is connected to a hub: issuer = the hub address from the hub connection,
  `client_id` = the instance id, client secret = the instance token. **It starts disabled** (customer switches it on in Platform settings >
  Single sign-on). Changing the hub address or token updates it.
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
claim, or an `oidc` provider's `role_claim`/`role_map`/`default_role`). **Effective role = the lower of the requested role and the provider's
`role_ceiling`.** The default ceiling for the `hub` provider is `ENGINEER`, for generic `oidc` providers `PROJECT_MANAGER`; `SUPER_ADMIN` is never
reachable through a provider unless an existing SUPER_ADMIN explicitly sets the ceiling to it. The ceiling exists so a mistake or compromise at a
provider cannot hand out the installation's top role. The role is re-evaluated at every sign-in and a lowered ceiling applies at the next sign-in
(and revokes sessions above it, see 4.7).

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
SUPER_ADMIN users created locally (including the bootstrap administrator) keep local password + TOTP sign-in even when
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
| Hub compromised or hub admin abuse | Instance has its own switch (off by default), role ceiling, break-glass local admin, audit on both sides; tokens are 5 minutes, audience-bound, single use. A compromised hub could sign in to instances that trust it, up to their ceiling, which is why trusting it is the customer's explicit choice. |
| Token or code replay / theft | PKCE, `nonce`, single-use code and `jti`, TLS, exact redirect URI, back-channel code exchange. |
| Open redirect / redirect URI abuse | Exact-match registered URIs derived from the instance record. |
| Account takeover via matching email | No automatic linking; explicit administrator link. |
| Role escalation | Ceiling applied on the instance; `SUPER_ADMIN` unreachable by default; role re-evaluated each sign-in. |
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
3. **Lifecycle**: 4.7 and 5.3 (revocation), session cap, hub-side customer users and invitations, access windows (optional, time-limited grants).
4. Later: SAML, SCIM, delegated customer administration, tenant claim mapping.

Done means: a hub account assigned to an installation clicks Open and lands signed in (no second prompt), a removed account is out within about a
minute, a customer can turn the hub provider off and local sign-in still works, a customer can add Entra ID and sign in with it, and
`docs/SECURITY.md`, the on-premises guide and the hub documentation describe it.
