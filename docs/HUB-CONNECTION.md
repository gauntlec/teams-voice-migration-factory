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
incident data is ever included, and nothing here signs anyone in to the hub (or the hub in to this installation): users and passwords stay at each installation.

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
- **Who can open it** is decided by the hub (people assigned to this customer, signed in with MFA, checked on every request). **Signing in here is unchanged**: they still need a user name and password for this installation.
- **What passes through the hub:** the signed-in person's traffic, decrypted at the hub in transit and relayed, not stored or logged there. Tell the customer this when switching it on.
- **What the worker will and will not do:** it talks only to the installation's own web server (`HUB_TUNNEL_TARGET`, default `http://web:80`, which matches the compose files), never to an address the hub names; it refuses unusual methods and any path that does not start with a single `/`.
- Stored in `platform.app_settings` (`hub_remote_access`, `hub_tunnel_state`, `hub_tunnel_error`, `hub_tunnel_at`; migration `0028_hub_remote_access.sql`). The heartbeat also reports the switch, so the hub can say "switched off by the customer".
- The connector reconnects by itself (2 s, doubling to a minute) if the connection drops, and says in words on this card why it is not connected (for example "the hub does not accept this installation's token").

