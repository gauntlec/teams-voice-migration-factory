# Connecting an installation to a Voxshift Hub

A **Voxshift Hub** (`https://hub.voxshift.io`, a separate private application) lists every Voxshift installation (the hosted service and each
customer-premises one), shows whether each is up and which version it runs, and lets staff open them from one place. This installation's side
of that is small: it reports in once a minute.

## What is sent

A version and a health word. Nothing else. Concretely, the worker (`apps/worker/src/hub-heartbeat.ts`) posts

```json
{ "version": "0.1.0+4e89435", "health": "ok", "uptimeSeconds": 86400 }
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
- The version is the build's commit (`APP_VERSION`, set from `GIT_SHA` by CI in the worker image) as `0.1.0+<7 characters>`; `0.1.0+dev` for a hand-built image.
- Connecting and disconnecting are in the platform audit log (the hub address, never the token).
- Only outbound HTTPS from the worker to the hub is needed. No inbound firewall rules.
