# Email communication module

One reusable path for every email the platform sends — invitations today,
workflow / approval / review notifications later. All mail is **queued** and sent
by the worker, and every message is logged.

> **Links in emails** are built from the base URL: the address saved on Administration > Platform settings, else `WEB_ORIGIN` (see [BASE-URL.md](BASE-URL.md)). Where this page writes `WEB_ORIGIN/...`, read "the base URL".

## Where email is set up

**In the app: Administration > Platform settings > Email** (Super Admin). Choose how this installation sends mail:

| | |
|---|---|
| **This installation's own mail server** | server, port, STARTTLS or implicit TLS, user name and password, the From address and sender name. The password is stored encrypted and never shown again. |
| **Through the Voxshift Hub** | the hub's mail service sends it (see below). Needs the installation to be connected to a hub; the card shows whether the hub's service is ready. |
| **Not set up** | nothing is sent; messages show as failed in the Email log. |

**Send a test email** on the same card sends a real message the way it is set up and shows the outcome (sent, or the mail server's own error).
The master on/off switch above it stops all email whatever is chosen.

**The environment still works as a fallback.** Until something is saved on that card, the `SMTP_*` / `MAIL_FROM` values in the installation's `.env` apply exactly as before
(so existing installations keep sending without any change). Saving on the card replaces them; the old values are carried over (including the password) unless a new one is typed.
The worker re-reads the setting for every message, so a change needs no restart or redeploy.

Every connection to a mail server is encrypted: STARTTLS is required unless the connection is encrypted from the start (port 465). A server that offers no encryption is refused rather than sent to in plain text.

### Through the Voxshift Hub

An installation connected to a hub (see [HUB-CONNECTION.md](HUB-CONNECTION.md)) can send its email through the hub's mail service, so a customer-premises installation needs no mail server of its own.
The worker hands each rendered message to `POST <hub>/api/v1/mail` with the instance token; the hub sends it from **its own From address** (only the sender *name* and reply address come from the installation)
and records the instance, the recipient's domain, the size and the outcome, never a subject, an address or a body. The hub limits how much each instance may send per hour and per day, and an administrator
can switch one instance off. The hub's reply to each heartbeat says whether its mail service is ready for this installation.
Messages still pass through the hub in transit, so tell customers who require otherwise to use their own mail server.

## The master switch

A Super Admin can switch **all** email off on **Administration > Platform settings** (permission `platform:operate`; stored as
`platform.app_settings.email_enabled`, default on). While it is off:

- nothing is generated: `MailService.enqueue` (API) and the worker's enqueuer write no `email_messages` row and queue no job, so there is
  no record of what would have been sent;
- a message already queued is marked `skipped` (error "Email is switched off for the platform") by the worker instead of being sent;
- "Resend" is refused with a clear message.

Super Admins see a banner on every page while it is off. A failed read of the setting counts as "on". The worker caches the setting for
30 seconds (the sender re-reads it fresh before each message), so a switch is felt within seconds. Sign-in, MFA and everything else that
does not email carry on as normal.

## Flow

```
API (MailService.enqueue)
  ├─ INSERT platform.email_messages  (status 'queued', template + context)
  └─ BullMQ 'mail' queue  ──►  worker (handleMail)
                                 ├─ renderEmail(template, context)  → subject/html/text
                                 ├─ SMTP send  (nodemailer)
                                 └─ UPDATE email_messages  (status 'sent' | 'failed', attempts, error)
```

- **Enqueue side** — the API's `apps/api/src/mail/mail.service.ts` `enqueue()`
  writes the row and adds a `send` job (`attempts: 5`, exponential backoff from
  15 s); `resend(id)` re-queues an existing row. The **worker** can also enqueue,
  for emails it originates (the discovery-run and deployment-run completion
  emails): same contract in `apps/worker/src/mail/enqueue.ts`
  (`makeMailEnqueuer(db, connection)`).
- **Send side** — `apps/worker/src/mail/`:
  - `mailer.ts` — nodemailer transport from `SMTP_*`; `mailerConfigured` is
    `false` when `SMTP_HOST` is unset.
  - `layout.ts` — the branded, inline-CSS shell. Voxshift brand system: equalizer
    mark + `vox·shift` wordmark on a `#4657D2` header with a `#5B5FC7` accent
    strip, primary button `#4657D2`, callout `#EEEFFD` / `#C3C7F6`, Segoe UI /
    Consolas. `renderHtml` + `renderText`, plus an optional `eyebrow` kicker.
  - `templates.ts` — `renderEmail(template, context)` switch; one function per
    template (`user_invitation`, `discovery_completed`, `deployment_completed`).
  - `apps/worker/src/main.ts` — the `mail` BullMQ `Worker`, the shared
    `enqueueMail` producer passed into the discovery runner, and
    `notifyDeploymentRunComplete()` called at the end of `handleDeploymentRun`.

## Test customers

A customer marked **Test customer** (Customers page, SUPER_ADMIN only;
`platform.tenants.sandbox`, `PATCH /api/tenants/:id/sandbox`, audited as
`tenant.sandbox_changed`) never emails its real recipients. The decision is
made by the **worker at send time** (`planDelivery` in
`apps/worker/src/mail/sandbox.ts`, called by `handleMail`), so it covers every
template, both producers (API and worker) and every resend:

- An email whose `email_messages.tenant_id` is a test customer goes to the
  person who **triggered** it (`created_by`), with the subject prefixed
  `[TEST - would have gone to <real recipient>]`.
- An email nobody triggered (port-document and service-request reminders,
  target emails from the worker's sweeps) goes to the customer's optional
  **fallback address** (`sandbox_email`); with none set it is not sent and is
  logged `skipped`.
- The row's `to_email` becomes where it actually went, and
  `original_to_email` keeps the real recipient. The Email log shows a
  **Test customer** badge with "would have gone to …". A resend starts again
  from `original_to_email`, so after switching the flag off a resend reaches
  the real recipient.
- Mail with no `tenant_id` (feature/bug board updates, invitations of staff or
  multi-customer users) is not affected. A CUSTOMER user invited to one test
  customer *is* redirected - the inviter still sees the temporary password on
  the Users screen.

Rule and wording: `sandboxRedirect` in `packages/shared/src/release-safety.ts`
(unit-tested); the database path is covered by
`tests/db/src/mail/test-customer.db.test.ts`.

## `platform.email_messages`

The auditable comms log. Key columns: `to_email`, `template`, `context` (jsonb),
`subject` (filled on render), `status` (`queued` / `sent` / `failed` / `skipped`),
`error`, `attempts`, `related_type` + `related_id` (e.g. `user` + the user id),
`created_by`, `created_at`, `sent_at`, `original_to_email` (test customers -
see above).

### Email log page

`Administration -> Email log` (`/admin/email`, `audit:read:platform` -> SUPER_ADMIN)
shows the current SMTP relay config and every message with its status, last SMTP
error and retry count, and a **Resend** button for failed/queued rows. Backed by
`GET /email-messages` (which never returns `context` - it can hold an invitation
password) and `POST /email-messages/:id/resend`. Lower-level SMTP conversation
logs are only in the worker container's stdout (`docker logs`).

## SMTP configuration

Set in the deploy `.env` (see `.env.example`). Works with any provider (a mail
relay, Microsoft 365 / Google SMTP, SES / SendGrid / Postmark SMTP, …):

```
SMTP_HOST=          # empty = delivery disabled (worker logs the message instead)
SMTP_PORT=587
SMTP_SECURE=false   # true only for implicit-TLS ports (usually 465)
SMTP_USER=
SMTP_PASS=
MAIL_FROM=no-reply@voxshift.io
MAIL_FROM_NAME=Teams Voice Migration Factory
```

**When `SMTP_HOST` is empty** the worker logs the full rendered message (subject +
text body, including the invitation's temporary password) to its container log
and marks the row `failed` with `error = 'SMTP not configured'`. Inviting still
works: the admin copies the temporary password from the Users screen (shown once)
and shares it securely. Add real SMTP values and click **Resend invite** to
deliver for real.

### Office 365

Production uses Microsoft 365 SMTP AUTH client submission:

```
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false          # STARTTLS; the worker sets requireTLS
SMTP_USER=no-reply@voxshift.io
SMTP_PASS=<app password>
MAIL_FROM=no-reply@voxshift.io
```

Tenant-side prerequisites (one-time):
1. `no-reply@voxshift.io` is a mailbox with an Exchange Online licence (a shared
   mailbox needs a licence + a set password to authenticate).
2. **Authenticated SMTP** is enabled for it — M365 admin center → the user →
   Mail → *Manage email apps* → tick *Authenticated SMTP*, or
   `Set-CASMailbox no-reply@voxshift.io -SmtpClientAuthenticationDisabled $false`.
   The org-wide switch (`Get-TransportConfig`) must not be blocking it.
3. If that account has MFA / Security Defaults, `SMTP_PASS` must be an **app
   password** (basic-auth SMTP can't do interactive MFA).
4. SPF for `voxshift.io` includes `include:spf.protection.outlook.com`; enable
   DKIM for the domain in the Defender portal so invitations don't get filtered.

## Invitations & first sign-in

1. A super admin / project manager / engineer creates a user (Users admin). No
   password field — the system generates a one-time password
   (`apps/api/src/users/password.util.ts`), stores it hashed with
   `must_change_password = true`, and enqueues a `user_invitation` email. The
   temp password is also returned to the admin once.
2. The user signs in with the temp password. `AuthService.login` sees
   `must_change_password` and returns a limited **`pwreset`** token
   (`passwordResetRequired: true`) — no session yet.
3. The web app shows **Set your password** (`apps/web/src/pages/SetPassword.tsx`).
   `POST /auth/password/change` (only reachable with a `pwreset` token) clears the
   flag and returns an **`enrol`** token.
4. The user then goes through the normal **MFA QR enrolment** and lands in the app.

`Resend invite` (`POST /users/:id/resend-invitation`) issues a fresh temp
password, re-sets `must_change_password`, revokes any sessions, and re-sends —
also usable as an admin "reset & re-invite".

## Adding a new email

1. Add the name to `EMAIL_TEMPLATES` in `packages/shared/src/email.ts` and a
   `<Name>Context` interface.
2. Add a `case` in `renderEmail` (`apps/worker/src/mail/templates.ts`) that builds
   a `LayoutInput` and returns `renderHtml` / `renderText`.
3. Call `mailService.enqueue({ template, to, context, related, createdBy })` from
   the API where the event happens, or the worker's `enqueueMail({...})` for an
   event the worker owns.
   Always pass `tenantId` for customer mail and `createdBy` when a person
   caused it - test customers redirect by them (see *Test customers*).

## `discovery_completed`

Sent by the worker when a tenant-discovery run reaches a terminal state
(`completed`, completed-with-errors, or `failed`/lost sign-in), to the person in
`tenant_discovery_runs.started_by`. Off per customer via
`tenant_discovery_config.notify_on_complete` (toggle on the Discovery page).
Carries the outcome, scope, duration, change counts (`added`/`updated`/`removed`/
`readded`), the per-type breakdown, the skipped-not-licensed count and step-error
count, and a link to `WEB_ORIGIN/discovery`. Built in
`notifyRunComplete()` in `apps/worker/src/discovery/run.ts`.

## `deployment_completed`

Sent by the worker when a deployment run (What-If or Execute) finishes, to
the operator who ran it (`deployments.started_by` / the job's
`operatorUserId`). Always sent - no per-customer opt-out yet, since a
deployment is a deliberate action the operator is already watching, not a
background sync. `outcome` is derived from the run's own change counts
(`completed_with_errors` when `failed > 0`) rather than trusted from
`deployments.status`, which only tracks whether the pwsh session finished -
not whether the cmdlets inside it succeeded (the same gap the Deployment
page's own run-history badges had before they were fixed to check
`summary.failed` too). Carries the mode, duration, `applied`/`whatif`/
`skipped`/`failed` counts, and - the reason this template exists - one line
per failed cmdlet with its own live error text (`object`, `cmdlet`,
`message`), so the recipient sees what broke without opening the app. Links
to `WEB_ORIGIN/deployment/sites/:siteId`. Built in
`notifyDeploymentRunComplete()` in `apps/worker/src/main.ts`.

## `service_request_created` / `service_request_status_changed`

Managed Services emails. `service_request_created` goes to the customer's
engineers and every Super Admin when a request is raised; `service_request_status_changed`
goes to the requester when their request is planned, designed & built, deployed
or cancelled. Both use the customer's branding. See [SERVICE-REQUESTS.md](SERVICE-REQUESTS.md).

## Service request emails from assistants

`service_request_activity` has four more kinds for assistants working a request: `agent_proposal`, `agent_lapsed`, `agent_handoff` and
`agent_deploy_check` (see [SERVICE-REQUESTS.md](SERVICE-REQUESTS.md#emails) and [SERVICE-REQUEST-AGENTS.md](SERVICE-REQUEST-AGENTS.md)).
An assistant is never the sender of an email.

## `sso_admin_signin`

Sent to every active Super Admin when someone signs in as Administrator through a single sign-on provider (the Voxshift Hub or the customer's own): who, which provider, the provider's own session reference when it sent one, the time and the address. It can be switched off on **Platform settings > Single sign-on** ("Email the administrators when someone signs in as Administrator..."); the master email switch also stops it. The sign-in itself is always recorded in the audit log (`sso.login.success`). See [SSO.md](SSO.md).

## Incident emails

Five templates, all with the customer's branding and a link to `/incidents/:id`
(built by `IncidentNotifier` in the API and by the incident sweep in the worker; see
[INCIDENT-MANAGEMENT.md](INCIDENT-MANAGEMENT.md)). **Customer side** means the
reporter and anyone following the incident, never the person who just did the thing.
**Team** means the assignee, or every engineer and Super Admin on the customer when
nobody is assigned.

| When | Template (`kind`) | To |
|---|---|---|
| A customer raises an incident | `incident_created` (`audience: reporter`, with "we aim to respond within ...") | The reporter |
| Any incident is raised | `incident_created` (`audience: team`, with the answers to the category's questions) | The team, except whoever raised it |
| An engineer acknowledges it | `incident_status_changed` (`acknowledge`) | Customer side |
| It goes on hold on a carrier, Microsoft or a vendor | `incident_status_changed` (`hold`) | Customer side (a hold on the customer is announced by the question that caused it) |
| Service is restored | `incident_status_changed` (`restore`, with the note) | Customer side |
| Staff close, cancel, merge as a duplicate, or reopen it | `incident_status_changed` (`close` / `cancel` / `duplicate` / `reopen`) | Customer side |
| It closes itself after 5 days resolved | `incident_status_changed` (`auto_close`) | Customer side |
| Staff change the priority | `incident_status_changed` (`priority`; never says why) | Customer side |
| The team posts a public update or asks a question | `incident_message` (`comment` / `question`) | Customer side |
| A question is still unanswered after 3 days (up to 3 reminders) | `incident_message` (`reminder`) | The reporter |
| It is resolved | `incident_resolved` - **Yes, it's fixed** and **No, it's still broken** links | Each person, with their own signed links |
| The customer comments or replies | `incident_activity` (`comment` / `replied`) | The team |
| The customer says it is still broken, cancels, or confirms it fixed | `incident_activity` (`reopened` / `cancelled` / `confirmed`) | The team |
| An internal note | `incident_activity` (`internal_note`) | The assignee only |
| It is assigned to someone else | `incident_activity` (`assigned`) | The new assignee |
| A target is at risk (20% left) or missed | `incident_activity` (`sla_warning` / `sla_breached`) | The team; once per target |
| A major incident is declared | `incident_major` (`declared`, customer version: "we're aware", next update time) | Customer side, the customer's named contacts, reporters of child incidents |
| ... and the team | `incident_major` (`declared`, team version) | The team, except whoever declared it |
| You are made lead or comms owner | `incident_activity` (`major_assigned`) | That person |
| A customer update on a major incident | `incident_major` (`update`) | Customer side, named contacts, child reporters |
| A major incident is resolved | `incident_major` (`resolved`, with what fixed it) | Customer side, named contacts, child reporters (plus the usual "is it fixed?") |
| A major incident's update is due / 15 minutes late | `incident_activity` (`update_due` / `update_overdue`) | The comms owner; then the lead and the whole team |
| A post-incident review is shared | `incident_review` (summary, cause, actions) | Customer side and named contacts |
| An assistant proposes a step that needs a decision | `incident_activity` (`agent_proposal`) | The assignee, or the team when nobody is assigned |
| An assistant's lease lapses or it keeps failing and the incident returns to the queue | `incident_activity` (`agent_lapsed`) | The team |
| An assistant hands an incident over | `incident_activity` (`agent_handoff`, with what it tried, found and recommends) | The person it is handed to, else the team |

Assistants are never the sender of an email, and customer-visible text from one goes out only after a person approves it (or, where the customer allows it, a template). A problem queueing mail is logged and never fails the change that caused it.

### "Is it fixed?" links

The resolved email carries two links, `WEB_ORIGIN/incident-response?t=<token>&a=fixed|broken`.
The token is an HMAC over the customer, incident, recipient and an expiry of 14 days
(`apps/api/src/modules/incidents/incident-links.ts`, keyed from `JWT_REFRESH_SECRET`);
it cannot be forged or aimed at another incident. The page it opens needs no sign-in and
**changes nothing until a button is pressed**, so an email scanner opening the link is
harmless. The answer goes through the normal rules (only the reporter or a follower; only
while resolved, or within 7 days of resolving for "still broken"), answering twice is
harmless, and the action is recorded as the person it was sent to. The two public routes are
`GET|POST /api/public/incident-response`.

### Replying by email, and raising by email

Customer-side incident emails carry `Reply-To: incidents+<token>@<INBOUND_EMAIL_ADDRESS domain>` once inbound email is configured, so a
reply becomes a comment on the incident. Mail to the incidents address can raise an incident for customers that switch it on. The
mailbox, forwarder, header and payload are in [INTAKE.md](INTAKE.md); the log of what happened to each inbound message is
`platform.inbound_email_log`.
