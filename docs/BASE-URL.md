# Base URL: where the application is reached

The **base URL** is the one address people and assistants use to reach this installation. The hosted service is
`https://www.voxshift.io`; an installation on a customer's own premises (or anywhere else) has its own, for example
`https://voice.contoso.com`.

## Where it is set

A Super Admin sets it on **Administration > Web address** (permission `platform:operate`). It is stored in
`platform.app_settings.base_url` and takes effect straight away: no redeploy, no restart.

Until someone saves one, the `WEB_ORIGIN` environment value is used (`.env`, or the Dockge stack's `.env`). That is the
**installation default**, and the page shows which of the two is in force. "Use the installation default" removes the
saved setting.

Rules: `http://` or `https://`, a host name (and port if not standard), nothing else: no path, query, `#`, user name
or trailing slash. Plain `http://` on a public name is allowed but warned about; on a private network or a local name it is
a normal choice for a test install.

## What uses it

| Thing | How |
|---|---|
| Links in every email (invitations, notices, incident, service request, discovery, deployment and number-port mails, incident reply links) | API: `cfg.WEB_ORIGIN`, kept current by `BaseUrlService`. Worker: `webOrigin(db)` from `@tvmf/db` (cached 30 s). |
| Branded logo URLs in emails | worker, same resolver |
| The cross-origin (CORS) allow-list | `main.ts`, read per request |
| "Connect an assistant" details (`VOXSHIFT_URL`, REST base, alert intake, inbound email forwarder) | Administration > Web address and the intake sources panel |

Examples in the docs and the reference agent use `https://www.voxshift.io`. On another installation, substitute its address.

## Moving to a new address (customer premises)

1. Point DNS and a TLS certificate at the new host and make the reverse proxy forward `/` to the web container (it proxies
   `/api` to the API itself).
2. Open the installation by its new address, sign in as a Super Admin, and set **Administration > Web address**. The page
   offers "Fill in this address" when you are browsing at an address that is not the saved one.
3. Check one email link, then update anything outside Voxshift that holds the old address: assistants' `VOXSHIFT_URL`,
   monitoring tools posting alerts, the inbound-email forwarder, and webhooks' receivers if they allow-list it.

Changing it does **not** move the application. It changes the address written into emails and shown to assistants, and the
CORS allow-list. Sign-in cookies are host-only, so staff sign in again when they start using a different address.

## Not covered

The setting is for the one address of one installation. It does not make one installation answer on several names; a
second name works for browsing (same-origin) but emails and assistants use the base URL.
