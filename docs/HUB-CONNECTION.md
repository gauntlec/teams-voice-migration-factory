# Connecting an installation to a Voxshift Hub

A **Voxshift Hub** (`https://hub.voxshift.io`, a separate private application) lists every Voxshift installation (the hosted service and each
customer-premises one), shows whether each is up and which version it runs, and lets staff open them from one place. This installation's side
of that is small: it reports in once a minute.

## What is sent

A version and a health word. Nothing else. Concretely, the worker (`apps/worker/src/hub-heartbeat.ts`) posts

```json
{ "version": "2026.10.3", "health": "ok", "uptimeSeconds": 86400, "remoteAccess": false }
```

to `<hub>/api/v1/heartbeat` with `Authorization: Bearer <instance token>`. The hub refuses any other field. No customer, tenant, user or
incident data is ever included. The heartbeat itself signs nobody in, in either direction. Signing in through the hub is a separate, opt-in feature
(see [Single sign-on](#single-sign-on-through-the-hub) below): passwords, password hashes and authenticator secrets never leave the system that owns them either way.

## Connecting (Super Admin)

1. In the hub, an administrator registers this installation (name, customer, address) and copies the **instance token** it shows once (`vxh_...`).
2. Here: **Administration > Platform settings > Voxshift hub**: enter the hub address (`https://hub.voxshift.io`) and the token, then **Connect**.
3. Within a minute the card shows **Reporting** and the hub shows the instance **Online**.

The token is stored encrypted (`DATA_ENCRYPTION_KEY`) and is never shown again, only its last four characters. If the hub rejects it (rotated, removed or switched off
there) the card says so in words; copy a fresh token from the hub and connect again. **Disconnect** stops reporting at once.

## Details

- Stored in `platform.app_settings` (`hub_url`, `hub_token_enc`, `hub_token_hint`, last attempt / last success / last error); migration `0027_hub_connection.sql`.
- The worker reads the setting fresh every minute, so connecting and disconnecting need no restart.
- The version is the release number (`APP_VERSION`, set by CI in the image) as `yyyy.mm.N` (see [VERSIONING.md](VERSIONING.md)); `dev` for a hand-built image.
- Connecting and disconnecting are in the platform audit log (the hub address, never the token).
- Only outbound HTTPS from the worker to the hub is needed. No inbound firewall rules.

## Remote access through the hub (the customer's switch)

Beyond being listed, an installation can let staff open it **from the hub, with no VPN and no inbound firewall rule**. The customer controls this:

- **Administration > Platform settings > Voxshift hub > "Staff can open this installation through the hub"**: off until someone here turns it on. Switch it off at any time; it takes effect within seconds.
- While it is on, the worker (`apps/worker/src/hub-tunnel.ts`) holds **one outbound WebSocket** to `<hub>/api/v1/tunnel`, authenticated with the same instance token. The hub sends each browser request of a person it has authorised down that connection, and the worker answers from this installation's own web server.
- **Who can open it** is decided by the hub (people assigned to this customer, signed in with MFA, checked on every request). **Signing in here is unchanged unless single sign-on is switched on** (below): without it they still need a user name and password for this installation; with it, a person with a hub account and a grant for this installation is signed in by the hub's Open button without a second prompt.
- **What passes through the hub:** the signed-in person's traffic, decrypted at the hub in transit and relayed, not stored or logged there. Tell the customer this when switching it on.
- **What the worker will and will not do:** it talks only to the installation's own web server (`HUB_TUNNEL_TARGET`, default `http://web:80`, which matches the compose files), never to an address the hub names; it refuses unusual methods and any path that does not start with a single `/`.
- Stored in `platform.app_settings` (`hub_remote_access`, `hub_tunnel_state`, `hub_tunnel_error`, `hub_tunnel_at`; migration `0028_hub_remote_access.sql`). The heartbeat also reports the switch, so the hub can say "switched off by the customer".
- The connector reconnects by itself (2 s, doubling to a minute) if the connection drops, and says in words on this card why it is not connected (for example "the hub does not accept this installation's token").

## Mail through the hub

If the hub has its mail service switched on, this installation can send its email through it instead of needing a mail server of its own: Platform settings > Email > "Through the Voxshift Hub".
See [EMAIL.md](EMAIL.md#through-the-voxshift-hub). The hub's heartbeat reply says whether the service is ready for this installation (`mailRelay`), which the Email card shows.


## Single sign-on through the hub

Connecting to a hub also creates a **Voxshift Hub** sign-in provider on this installation (Administration > Platform settings > Single sign-on). It is created **switched off**: an administrator
of this installation turns it on, normally the Voxshift person doing the setup, with the customer's agreement. The design and the exact contract with the hub are in [SSO.md](SSO.md); the short version:

- The installation is an OpenID Connect client of the hub: client id = this installation's id at the hub (inside the instance token), client secret = the instance token, issuer = the hub address.
  Changing the token keeps the switch and the role limits; connecting to a **different** hub address switches it off, forgets the people it knew and ends their sessions. Disconnecting switches it off.
- The person signs in at the hub (password + authenticator code); this installation receives a short-lived signed token and checks it itself (signature, issuer, audience, expiry, nonce, one-time use). Nothing secret crosses.
- **What the person may do is capped on this installation**: Voxshift/MSP staff accounts can sign in as at most the "staff" role (starts at Administrator, because staff normally install and look after an installation), the customer's own people with hub accounts as at most the
  "customer" role (starts at Engineer). The customer can lower either at any time; people above the new limit are signed out at their next token refresh (within 15 minutes).
- Every sign-in as Administrator through the hub is recorded in the audit log and emailed to the administrators here.
- If the hub is unreachable the hub button fails and **local sign-in still works**. Local administrators (break-glass accounts) always can sign in with a password and authenticator.
- Revocation by the hub itself (removing someone at the hub takes effect at the next heartbeat) is phase 3 of the plan and is **not built yet**. Until then a person removed at the hub keeps an open session here until it ends (12 hours at most by default, a setting), unless an administrator here acts: disabling the user, unlinking the person, switching the provider off or lowering its role limit each end the session at the next token refresh (within 15 minutes).
