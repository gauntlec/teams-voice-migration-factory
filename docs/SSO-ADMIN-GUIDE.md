# Single sign-on: guide for the administrator of an installation

For: a Super Admin (Administrator) of a Voxshift installation, for example the IT person at a customer who runs Voxshift on their own premises.
Status: built and deployed 2026-10-19 (phases 1 and 2). The design and the exact technical contract are in [SSO.md](SSO.md); the security view is in
[SECURITY.md](SECURITY.md) ("Single sign-on"); how the installation connects to a Voxshift Hub is in [HUB-CONNECTION.md](HUB-CONNECTION.md).
This page is the one to follow when you set it up or when something goes wrong.

## 1. What single sign-on is, in plain words

Without it, everyone who uses this installation has an account here with a password and an authenticator code, made and kept here.

With it, a person can instead be **vouched for by another system you trust** (a "provider") and walk in without typing a second password. The provider checks
the password and the second factor (authenticator code, or whatever it uses) and then tells this installation "this is Jane, she did two-step verification".
The installation checks that message itself (its signature, who it is for, that it is fresh and used only once) and signs Jane in.

Things that stay true whatever you choose:

- **Passwords and authenticator secrets never leave the system that owns them.** The provider never receives a password from this installation and this installation never receives one from the provider.
- **There is no account sync.** Accounts here are created the first time someone signs in ("just-in-time"), or you link an account that already exists.
- **Nothing is linked by email address.** If someone signs in through a provider with an email that already has an account here, they are refused until you link the two on purpose.
  (Otherwise anyone who can create an account at a provider with your administrator's email address could become your administrator.)
- **You decide.** Every provider is off until you switch it on, and each can be switched off again at any time. You also decide the highest role each one can give.
- **Local administrators (break-glass accounts) always keep password and authenticator sign-in**, so a provider outage or mistake can never lock you out.

## 2. The choices

| Choice | Who signs in | Where the password lives | Switched on by |
|---|---|---|---|
| **Local accounts only** (the default) | People you create under Administration > Users | Here, with an authenticator code | Nothing to do |
| **Voxshift Hub** | Voxshift staff, your MSP's engineers, and your own people who have been given a hub account **and** access to this installation | At the hub (password and authenticator code) | You, under Administration > Platform settings > Single sign-on (section 4). Needs the installation to be connected to a hub first |
| **Your own provider** (Microsoft Entra ID, Okta, Google Workspace, Keycloak, any OpenID Connect provider) | Your own staff, with the accounts they already use at work | At your provider | You, by adding the provider (section 6) |

You can use any mix. The login page shows one button per provider that is on ("Sign in with Voxshift Hub", "Sign in with Contoso Microsoft account") next to the password form.
You can also hide the password form for everyone except the local administrators (section 8).

Not available yet: SAML, SCIM (automatic provisioning and removal of accounts), and letting a customer's administrator create hub accounts themselves.

## 3. Before you start

1. You must be a **Super Admin** (permission `sso:manage`). Nobody else sees the Single sign-on screen.
2. **Check the web address** under Administration > Platform settings > Web address ([BASE-URL.md](BASE-URL.md)). Providers send the person back to
   `<web address>/api/auth/oidc/callback`, so it must be the address people really type, with the right scheme (`https://voxshift.contoso.com`).
3. **Have a local administrator you can sign in with** (the one made at installation is one). See section 8.
4. **Email** should be working (Administration > Platform settings > Email), because administrator sign-ins are emailed to the administrators (section 12).
5. **Network:** the installation's server needs outbound HTTPS to the provider (section 13). People's browsers need to reach this installation and the provider.

## 4. Turn on Voxshift Hub sign-in

Do this when the installation is (or is about to be) managed through a Voxshift Hub. Normally the Voxshift person doing the setup does it with your agreement, signed in with the local administrator account.

1. **Connect the installation to the hub** if it is not already: Administration > Platform settings > **Voxshift hub**, enter the hub address `https://hub.voxshift.io` and the instance token the hub shows once, **Connect**. This creates the "Voxshift Hub" sign-in provider **switched off**.
   (An installation connected before single sign-on existed gets its provider record automatically, also switched off, the next time the API starts or the Single sign-on screen is opened.)
2. At the hub, a hub administrator must register this installation with its **real own address** (the same address as your web address), and give each person access to it with a role (see [the note at the end of this page](#where-the-hub-side-is-described)).
3. Open Administration > Platform settings > **Single sign-on**. On the **Voxshift Hub** card:
   - Check the two role ceilings (section 5) and lower them if you want.
   - Keep "Create an account automatically the first time someone signs in" on (otherwise each person needs an account made first and then linked).
   - Keep "Only accept sign-ins where the hub confirms two-step verification" on.
   - Press **Test sign-in**. You are sent to the hub, sign in there, and come back to a result that says who you would have been signed in as and with which role, without anything being created. (The test needs a hub account of yours that has been given access to this installation.)
   - Switch **"People can sign in with the Voxshift Hub"** on.
4. The hub learns within a minute (the installation reports it in its heartbeat) that hub sign-in is on, and from then on its **Open** button signs people in without a prompt. Until then Open takes them to the normal login page.

What people get:

| Person | How they sign in | First time |
|---|---|---|
| Voxshift staff or an MSP engineer with a hub account and access to this installation | Hub **Open** button, or "Sign in with Voxshift Hub" on this installation's login page | An account is created with the role the hub grants them, capped by the **staff ceiling** (starts at Administrator) |
| Your own person with a hub account and access to this installation | The same | An account is created with the role the hub grants them, capped by the **customer ceiling** (starts at Engineer) |

A person who is created this way can sign in but **sees no customers until you add them**: roles below Administrator only see customers they are assigned to (Administration > Users, add the person to the customer). Super Admins see everything.

Every sign-in as Administrator through any provider is recorded in the audit log and emailed to the administrators (section 12).

## 5. Roles and ceilings

The installation has four roles: **Administrator** (`SUPER_ADMIN`), **Project manager**, **Engineer** and **Customer** (see [RBAC.md](RBAC.md)). The provider says which role a person should have. **The role they actually get is the lower of what the provider asks for and the ceiling you set for that provider.**
The order is Administrator > Project manager > Engineer > Customer. A ceiling of Engineer therefore also holds a Project manager down to Engineer.

| Provider | Ceiling setting | Starts at | Where the provider's request comes from |
|---|---|---|---|
| Voxshift Hub, staff accounts | "Voxshift Hub staff can sign in as" | **Administrator** (Voxshift staff normally install and look after an installation) | The role the hub administrator gave that person for this installation |
| Voxshift Hub, your own people | "People from your own organisation with Voxshift Hub accounts can sign in as" | **Engineer** | The same |
| Your own provider (Entra ID and so on) | "Highest role this provider can give" | **Project manager** | A claim you name (a group or app role) and a map of values to roles; anyone it does not match gets the "Role when the provider does not say" (starts at **Customer**) |

How to change a ceiling: Administration > Platform settings > Single sign-on, the provider's card, choose the role. It is saved straight away and recorded in the audit log.
The effect:

- **At the next sign-in** the person gets the lower role.
- **A person already signed in above the new ceiling is signed out at their next token refresh** (within 15 minutes) and has to sign in again, at the lower role.
- The role is **managed by the provider**: it is set at every sign-in, for accounts the provider created and for accounts you linked. A role you set by hand under Users is replaced at that person's next provider sign-in.

If you want Voxshift staff to need your help for administrator tasks, lower the staff ceiling to Engineer. The Single sign-on screen reminds you when it is at Administrator and the hub provider is on.

Edge cases:

- If the hub does not say whether a person is staff or a customer, the **lower** of the two ceilings applies.
- If the hub sends no valid role, the provider's default role (Customer) applies.
- A person created as Customer through a provider has no customer memberships until you add them.

## 6. Add your own provider

Any OpenID Connect provider works if it supports the authorization code flow, publishes the standard discovery document, and signs ID tokens with RS256, ES256 or EdDSA.
Steps in this installation are the same for all of them; the provider-side steps differ. Microsoft Entra ID is described in full below. Okta, Google Workspace and Keycloak work the same way (register a web application, give it the redirect address, copy the client id and secret); their exact menu names are not repeated here.

### 6.1 Microsoft Entra ID

(This is the one canonical copy of these steps.)

1. In the Entra admin center: **App registrations > New registration**. Name it for example "Voxshift". Supported account types: **this directory only**. Redirect URI: platform **Web**, value = the "Redirect address to register at the provider" shown in the Add dialog (it is `<web address>/api/auth/oidc/callback`, for example `https://voxshift.contoso.com/api/auth/oidc/callback`).
2. **Certificates & secrets > New client secret.** Copy the **value** now; it is shown once. Note its expiry date: when it expires, sign-in with this provider stops until you replace it (Edit the provider here and paste the new secret).
3. **Token configuration > Add optional claim > ID > `email`**, so the address arrives as `email`. (If it is missing, the installation falls back to `preferred_username` when that looks like an email address.) Optional: add a **groups** claim, or define **App roles** (for example "Voxshift Admins") and assign people, to use the role map.
4. In Voxshift: Administration > Platform settings > Single sign-on > **Add a provider**:
   - Name: shown on the button, for example "Contoso Microsoft account".
   - Provider address (issuer): `https://login.microsoftonline.com/<Directory (tenant) ID>/v2.0`. It must be the tenant-specific address, **not** `common` or `organizations`: the issuer in Microsoft's reply has to match what you typed exactly (a trailing slash is ignored).
   - Client ID: the Application (client) ID. Client secret: the value from step 2.
   - Highest role: the ceiling. Role when the provider does not say: Customer is the safe choice. Role claim (optional): `roles` for app roles, or `groups`. Which values mean which role: one per line, for example `Voxshift Admins = Administrator`. If several values match, the most powerful wins, then the ceiling is applied.
   - Only these email domains (optional): for example `contoso.com`. Empty means any address the provider vouches for.
5. Press **Test sign-in** on the new card. Sign in with a work account. The result says who you would be and with which role, and whether the provider reported two-step verification. Entra reports `mfa` when the sign-in used MFA. If your tenant does not enforce MFA the test (and real sign-ins) will be refused with "did not confirm two-step verification" until you either enforce MFA in Entra (recommended) or switch off "Only accept sign-ins where the provider confirms two-step verification (MFA)" for this provider.
6. Switch the provider **on** only when the test works.

A new provider is always added **switched off**. Removing a provider signs out everyone who came in through it and forgets who they were at the provider; the accounts stay (disable them under Users if they must not get back in).

### 6.2 The settings on a provider, explained

| Setting | Meaning |
|---|---|
| Provider address (issuer) | The provider's own address. This installation reads `<address>/.well-known/openid-configuration`, follows no redirects, and accepts https only. |
| Create an account automatically the first time someone signs in | On: the first sign-in makes the account (with no password). Off: the person is refused with "You do not have an account on this installation yet" until you create and link an account. |
| Only accept sign-ins where the provider confirms two-step verification | On (default): the provider's token must say the person used MFA (`amr` contains `mfa`, `otp` or `hwk`). Some providers never send that claim; if people are refused although MFA is on at the provider, either enforce MFA at the provider and switch this off for that provider, or ask the provider to send it. |
| Only these email domains | A sign-in whose email is from another domain is refused. |
| Keep the password sign-in form for everyone | Off hides the password form for everyone except break-glass administrators (section 8). Cannot be saved with the provider on unless a break-glass administrator with a password exists. |
| Scopes | Leave as `openid email profile` unless your provider needs something else; `openid` must be there. |

### 6.3 Test sign-in

The Test button signs you in at the provider for real but **creates no account and no session**. It shows what it found on the card ("Last test worked ..."). A provider that is switched off can be tested. Always test before switching a provider on or after changing its address, secret or role settings.

## 7. Linking an existing account

Use this when a person already has a local account here and should now sign in through a provider.

1. Ask the person to sign in through the provider once. They are refused with "An account with your email address already exists here but is not linked to this sign-in." That refusal is recorded as a **waiting sign-in**.
2. Administration > Users, the row menu of their account > **Link to provider identity**. The waiting sign-in is listed ("Waiting to be linked"); check that it really is that person, and link it. Or choose the provider and type the provider's identifier for the person (the `sub`) if you know it.
3. The person signs in through the provider again and gets the role the provider asks for, capped by the ceiling. Their local password still works unless you have switched local passwords off.

Unlinking (the same dialog) removes the connection and signs that person out of any session they have through that provider.

A break-glass administrator cannot be linked (section 8).

## 8. Break-glass accounts

A **break-glass administrator** is a Super Admin created **locally** (the one made when the installation was set up, and any Super Admin you create under Users). It keeps password + authenticator sign-in whatever any provider says, and it is never signed in through a provider.

Why: if the hub or your identity provider is down, misconfigured or compromised, you can still get in and fix it.

Protections built in:

- You cannot save "Keep the password sign-in form for everyone" as off, with the provider on, unless at least one active break-glass administrator with a usable password exists.
- While local passwords are switched off you cannot disable or delete the last break-glass administrator.
- A break-glass account cannot be linked to a provider, and a provider sign-in whose identity points at one is refused.

When local passwords are switched off, the login page shows the provider buttons and a small **Administrator sign-in** link that reveals the password form for these accounts only. Everyone else who types a correct password is told "Signing in with a password is switched off on this installation. Use single sign-on instead."

Good practice: keep at least two break-glass administrators, with passwords in your password manager, and sign in with one now and then.
Note: the flag is set when a Super Admin is **created**. Changing someone else's role to Administrator afterwards does not make them break-glass, and an administrator who was created through a provider is not one either.

## 9. Sessions, sign-out and the 12-hour limit

- A sign-in through a provider gives the same kind of session as a password sign-in: an access token that lasts **15 minutes** and is renewed in the background.
- A provider session also has an **absolute limit**, 12 hours by default, that renewing never extends. After that the person signs in again at the provider. Change it under Single sign-on > **Sign-in sessions** ("Sign in again at the provider after (hours)", 1 to 720).
- At every renewal (every 15 minutes) the installation checks: is the provider still on, does the person's link still exist, is the account still active, and is their role still within the ceiling? If not, they are signed out ("You have been signed out. Sign in again.").
- **Signing out here signs the person out of this installation only**, not out of the provider or the hub.

## 10. How access is removed today (read this)

| What you do | Effect |
|---|---|
| Disable the user (Users > Disable account) | Effective at once: every request from that person is refused ("Account unavailable") and their sessions are ended. They cannot sign in again |
| Unlink the person (Link to provider identity > Unlink) | Their provider sessions are ended at once; the access they already hold works for at most 15 more minutes |
| Switch the provider off | Nobody can start a new sign-in with it; people already in are signed out at their next renewal (within 15 minutes) |
| Lower the ceiling | Anyone above it is signed out at their next renewal (within 15 minutes) |
| Remove the provider | Everyone who came in through it is signed out; the accounts stay |
| Switch hub sign-in off for the whole installation | Same as switching the provider off |

**What does not happen yet:** if a person is removed or switched off **at the hub** (or at your own identity provider), the installation is **not told**. Their new sign-ins are refused immediately (the hub or provider will not vouch for them), but a session they already have here continues until it ends by itself: **at most the 12-hour limit** (a setting), unless you act here as in the table above. This "push revocation" is phase 3 of the plan and is not built. If someone leaves in a hurry, disable their account here as well.

## 11. Remote access through the hub

Separate from sign-in, the installation can let people reach it **through the hub's tunnel** without a VPN or inbound firewall rule.

- The switch is on this installation: Administration > Platform settings > Voxshift hub > **"People with a hub account can open this installation through the hub"**. It is off until someone here turns it on, and takes effect within seconds either way.
- It covers **every kind of hub account**: Voxshift staff, your MSP, and your own people. Each still needs access to this installation at the hub; the hub checks that on every request.
- While it is on, this installation holds one **outbound** connection to the hub. Traffic from the person's browser passes through the hub in memory (it is decrypted there to check who is asking) and is not stored or logged. Tell your security team.
- The address through the hub is `https://<short-name>.hub.voxshift.io`. Single sign-on works there too.

**The hub's Open button chooses the route itself:**

1. If the person's browser has the same public address as this installation (same network), it opens this installation's own address directly, then shows "Did not load? Open through the hub".
2. Otherwise, if the tunnel is available and the installation's own address is https, the person's browser tests whether that address answers (a tiny request to `<web address>/version.json`, two seconds). If it does, they go direct; if not, through the hub.
3. A plain `http` address cannot be tested from the hub's https page, so it is used when the tunnel is not available, and otherwise the hub route is used.
4. People can also pick **Open at its own address**, **Open through the hub**, or **Open without single sign-on** from the row menu.

A hub administrator can switch the browser test off (hub Settings). Chrome may ask people once for permission to "access devices on your local network" when the installation has a private address; if they decline, Open goes through the hub.

## 12. Audit and the administrator-sign-in email

Everything is in Administration > Observability > **Platform Audit**.

| Event | When |
|---|---|
| `sso.login.success` | A sign-in worked. Detail: provider, person, role given, role asked for, ceiling, the provider's session reference, how the person authenticated (`amr`), whether the account was just created |
| `sso.login.refused` | A sign-in was refused. Detail: a reason code (section 14), never a token |
| `sso.user.created` | An account was created by a first sign-in |
| `sso.user.linked`, `sso.user.unlinked` | You linked or unlinked someone |
| `sso.provider.changed` | A provider was added, changed, switched on or off, removed, tested, or the general settings changed. Old and new values, never a secret |
| `sso.revoked` | Someone was signed out at a renewal (reason `user-disabled`, `provider-off`, `identity-removed` or `ceiling-lowered`) |
| `auth.login.failed` with reason `local-passwords-off` or `federated-account` | A password was tried where passwords are off, or on an account that has no password |

**Administrator-sign-in email:** every time someone signs in as Administrator through a provider, every active Administrator receives an email saying who, through which provider, the provider's session reference, when and from which address. It can be switched off (Single sign-on > Sign-in sessions > "Email the administrators when someone signs in as Administrator through a provider"); the platform-wide email switch also stops it. The audit entry is written either way.

## 13. Network and firewall

| From | To | Why |
|---|---|---|
| The installation's server (API) | `https://hub.voxshift.io` on 443 | Once per sign-in, to exchange the one-time code for the signed token; also reads the hub's key set. The worker sends the heartbeat here every minute |
| The installation's server (API) | Your identity provider, for example `https://login.microsoftonline.com` | Same, for a provider you added: its configuration document, key set and token address |
| People's browsers | This installation | Normal use |
| People's browsers | `https://hub.voxshift.io` (hub sign-in) or the provider's sign-in page | They are sent there during sign-in |

If the server cannot reach the hub or provider, the button fails with "Single sign-on did not complete" and **local sign-in still works**. Redirects are not followed on these requests, so a proxy that rewrites them breaks sign-in: allow the addresses directly.

## 14. Troubleshooting

Start at Administration > Observability > Platform Audit, filter on `sso`, and find the `sso.login.refused` row: its **reason** tells you exactly what went wrong. The person only ever sees a short message (first table); the reason is for you (second table).

### 14.1 What the person sees

The message appears on the login page, or as a dismissible bar at the top of the application if they already had a session open.

| Message the person sees | Reasons behind it (audit) | What to do |
|---|---|---|
| "Single sign-on did not complete. Try again, or sign in another way." | Many; see 14.2 | Try again once. If it repeats, find the reason in the audit log |
| "Single sign-on with this provider is switched off for this installation." | `provider_off` | Switch the provider on (Single sign-on), or the person's link is stale (button from an old page) |
| "Your provider did not confirm two-step verification (MFA) for this sign-in, which this installation requires. Turn on MFA for your account at the provider and try again." | `mfa_not_proven` | Person: turn on MFA at the provider. Administrator: enforce MFA at the provider, or, if the provider never reports it, switch the requirement off for that provider |
| "Your provider did not give a verified email address, so you cannot be signed in. Ask your administrator." | `email_unverified`, `email_missing` | At the provider, make sure the account has a verified email and (Entra) that the `email` optional claim is added |
| "Your email address is not from a domain this installation accepts for this provider." | `domain_not_allowed` | Add the domain to "Only these email domains", or the person is using the wrong account |
| "You do not have an account on this installation yet, and automatic account creation is off. Ask an administrator to set one up." | `no_identity_jit_off` | Switch on "Create an account automatically ...", or create the account and link it (section 7) |
| "An account with your email address already exists here but is not linked to this sign-in. Ask an administrator to link it (Users > Link to provider identity)." | `email_exists_unlinked` | Link it (section 7) after checking it is the same person, or use the other account |
| "This account is switched off. Ask an administrator." | `user_disabled` | Enable the account under Users, if appropriate |
| "This account signs in with a password and authenticator on this installation, not through a provider." | `break_glass_local_only` | This is a break-glass administrator. Sign in with the password on the **Administrator sign-in** form. To use a provider, sign in as a different account |

### 14.2 Reason codes in the audit log

| Reason | Meaning | What to do |
|---|---|---|
| `provider_off` | Provider missing or switched off when the sign-in started or came back | Switch it on |
| `discovery_failed` | This installation could not read the provider's configuration document or it was incomplete | Check the provider address; the server must reach it over https; no proxy that redirects; answer within 10 seconds |
| `issuer_mismatch` | The document names a different issuer than the one configured | Use the exact issuer. For Entra use the tenant-specific address, not `common` |
| `insecure_endpoint` | The provider's address, or one it lists, is not https | Use https (plain http is accepted only for a test on the same machine) |
| `state_missing_or_expired` | The browser's short-lived sign-in cookie was missing or older than 10 minutes | Try again without delay. Check the browser accepts cookies, and that people start and finish on the same address as the Web address setting. Check `COOKIE_DOMAIN` |
| `state_mismatch` | The answer did not match the sign-in that was started (old tab, back button, or a forged link) | Start again from the login page |
| `provider_error:<code>` | The provider (or the hub) sent back an error instead of a code, for example `access_denied` (the person cancelled or was refused), `login_required`, `invalid_request`, `unsupported_response_type` | Look at the provider's own sign-in log. For the hub, ask the hub administrator to check the hub's activity log for the matching entry |
| `code_replayed` | The same return link was used twice (refresh or back button) | Start again from the login page. If it keeps happening, tell your security team |
| `token_endpoint_error` | Exchanging the code failed: the provider rejected it, or could not be reached | Check the client secret (expired?) and that the redirect address registered at the provider is exactly `<web address>/api/auth/oidc/callback`; check the firewall (section 13). For the hub, check the instance token has not been rotated and the hub has the right address for this installation |
| `no_id_token` | The provider answered without an ID token | Check the provider registration is for OpenID Connect and the scopes include `openid` |
| `token_malformed` | The ID token could not be read | Provider problem; try again; check for a proxy altering responses |
| `token_alg_not_allowed` | Signed with an algorithm not accepted (only RS256, ES256, EdDSA) | Change the provider's signing algorithm |
| `token_signature` | Signature did not verify | Provider problem or tampering; try again; if constant, tell Voxshift support |
| `unknown_key` | The signing key is not in the provider's key set, even after a refresh | Wait a minute and try again (keys were just rotated); if constant, check the provider |
| `jwks_unavailable` | The provider's key set could not be fetched | Check the firewall and the provider's status |
| `token_issuer` | The token's issuer is not the configured provider | Fix the provider address |
| `token_audience` | The token was issued for a different application | Check the Client ID. For the hub, the hub's record for this installation must be the same installation (token not mixed up between installations) |
| `token_authorized_party` | The token names a different authorised party | Check the Client ID |
| `token_expired` | The token had already expired | Check this server's clock (`timedatectl`, NTP). More than 60 seconds out causes this |
| `token_not_yet_valid` | The token is dated in the future | Same: clock |
| `token_missing_claim` | A required claim is missing (`sub`, `exp`, `iat`, ...) | Provider configuration |
| `token_nonce` | The token was for a different sign-in attempt | Start again; a stale tab |
| `token_replayed` | The token's identifier was seen before | Start again; if it keeps happening, tell your security team |
| `mfa_not_proven` | See 14.1 | |
| `email_unverified`, `email_missing`, `domain_not_allowed`, `no_identity_jit_off`, `email_exists_unlinked`, `user_disabled`, `break_glass_local_only` | See 14.1 | |

A sign-in that is refused before it starts for a malformed link, or with an invalid or expired Test ticket, shows the general message and is not given a reason (nothing was attempted).

### 14.3 Other messages

| Where | Message | What it means and what to do |
|---|---|---|
| Anywhere in the app, after a while | "You have been signed out. Sign in again." (audit `sso.revoked` with reason `user-disabled`, `provider-off`, `identity-removed` or `ceiling-lowered`) | Something changed for this person at their last renewal. Find the reason in the audit log; fix it if it was not intended |
| Anywhere, after the limit | "Session expired" | The 12-hour provider session limit (or the normal refresh expiry) was reached. Sign in again |
| Login page, password form | "Signing in with a password is switched off on this installation. Use single sign-on instead." | A provider has local passwords off. Use the provider button. Break-glass administrators use the **Administrator sign-in** link |
| Login page, password form | "Invalid credentials" for a person who was created through a provider | That account has no password at all; use the provider button |
| Any login or sign-in endpoint | "Too many login attempts - try again in a minute." | More than 20 requests a minute from one address (password and provider sign-ins share the limit). Many people behind one office address can hit it at a busy start of the day; wait a minute |
| Single sign-on screen, adding a provider | "We could not read <address>/.well-known/openid-configuration: the provider did not answer with a valid configuration document / answered with a different issuer than the one you entered / uses an address that is not https." | Fix the address (see `discovery_failed`, `issuer_mismatch`, `insecure_endpoint`) |
| Single sign-on screen | "A provider with that name already exists." | Names must be unique |
| Single sign-on screen | "Connect this installation to the Voxshift Hub first (Platform settings > Voxshift hub)." | The hub provider cannot be switched on without a hub connection |
| Single sign-on screen | "The Voxshift Hub's name, address and credentials come from the hub connection ..." | They cannot be edited on this screen; change the hub connection instead |
| Single sign-on screen | "Switching off local passwords needs at least one active local administrator (break-glass) who can still sign in with a password and authenticator. Create one first." | Create a local Super Admin under Users first |
| Single sign-on screen | "The Voxshift Hub provider follows the hub connection. Switch it off here, or disconnect the hub." | The hub provider cannot be removed |
| Users > Link to provider identity | "This is a break-glass administrator ... so it is not linked to a provider." | Link a different account |
| Users > Link to provider identity | "That person at the provider is already linked to a different user. Remove that link first." / "That person is already linked to this user." | Unlink the other account first |
| Users > Link to provider identity | "That waiting sign-in is no longer there (it may already be linked)." | Refresh |
| Users > Disable or delete | "You cannot disable/delete the last local (break-glass) administrator while single sign-on has local passwords switched off ..." | Create another local administrator first, or switch local passwords back on |
| The hub (before the person reaches this installation) | "This sign-in link is not valid" (unknown installation) or "The return address does not match the one registered for this installation." | The address the hub has for this installation is not the real one, or differs from this installation's Web address. Ask the hub administrator to correct it |
| The hub | "You do not have access to this installation" | The person has no access to this installation at the hub. Ask the hub administrator |
| The hub | "Single sign-on is switched off" / "Single sign-on is not available here" | Switched off hub-wide / for this installation at the hub |
| A browser error 404 on `/api/auth/oidc/login` | | The installation runs a release without single sign-on. Update it |

## Where the hub side is described

The hub's own documentation (people, grants, invitations, mail, key rotation, kill switches, troubleshooting) is private to the Voxshift team (the hub is a separate private application). If you need something changed at the hub, ask your Voxshift contact.
For the customer security team, the on-premises installation and security guide describes the whole arrangement.

## Quick reference

| Task | Where |
|---|---|
| Providers, ceilings, test, session length, administrator email | Administration > Platform settings > Single sign-on (`/admin/settings/sso`) |
| Hub connection and the remote-access switch | Administration > Platform settings > Voxshift hub |
| Link a local account to a provider identity | Administration > Users > row menu > Link to provider identity |
| Create a break-glass administrator | Administration > Users > add a user with the Super Admin role |
| Audit | Administration > Observability > Platform Audit |
| Web address | Administration > Platform settings > Web address |
