# Incident intake: alerts, email, knowledge, Teams

How incidents get into Voxshift from places other than the "Raise an incident" form, and how the MSP team is told. Chunk 8 of
[INCIDENT-MANAGEMENT.md](INCIDENT-MANAGEMENT.md). Everything here is **off until someone sets it up** (an alert source, a forwarder
and two environment values, a Teams webhook); nothing changes for a customer who does not use it.

## 1. Monitoring alerts (`/api/intake/v1`)

A Super Admin (`intake:manage`) creates **alert sources** per customer under Incidents -> Settings -> Alert sources. Each source has a
kind (Generic, SBC, Teams health, Call quality, Microsoft 365 service health), a token shown once (`vxs_intake_<id>_<secret>`; only a hash
is stored; rotate or switch off at any time), an optional IP allow-list and these options: site code (when alerts do not say), category
override, severity map (severity -> impact and urgency, so the customer's matrix decides the priority), "alerts below this severity are
ignored" and "move the incident to Restored when the alert clears".

```bash
# Check the token works (no incident is created)
curl -s https://VOXSHIFT/api/intake/v1/ping -H "Authorization: Bearer vxs_intake_..."

# Raise or update an alert
curl -s https://VOXSHIFT/api/intake/v1/alerts \
  -H "Authorization: Bearer vxs_intake_..." -H "Content-Type: application/json" \
  -d '{"dedupKey":"sbc1-link-down","title":"SBC trunk to carrier is down","severity":"critical","siteCode":"LON","description":"SIP OPTIONS failing for 3 minutes"}'

# Clear it
curl -s https://VOXSHIFT/api/intake/v1/alerts ... -d '{"dedupKey":"sbc1-link-down","title":"SBC trunk to carrier is down","state":"resolved"}'
```

Payload (strict; unknown fields are refused): `dedupKey` (1-200 chars, required), `title`, `description?`, `severity`
(`critical`/`major`/`minor`/`info`, default `major`), `state` (`firing`/`resolved`, default `firing`), `siteCode?`, `category?`,
`link?`, `details?`. Rate limit 120 requests a minute per source.

What happens (the API, `incident-intake.service.ts`):

- **New key**: an incident is raised by "(monitoring)" (source = the alert source name), with priority from the severity map. One open
  incident per `<sourceId>:<dedupKey>`, so a storm of repeats is one incident.
- **Fires again while open**: a "still firing" note (at most one every 10 minutes); a **worse** severity raises the priority unless staff
  overrode it.
- **Resolved**: a note; with "move to Restored" on, an incident that is In progress or On hold moves to Restored (never straight to
  Resolved or Closed; a person confirms the fix). Resolved or closed incidents re-open if the same alert fires again.
- Everything is on the timeline as the system actor, never as a person, and a re-fired alert never overwrites a person's edits.

**Microsoft 365 service health.** A source of kind *Microsoft 365 service health* (or *Teams health*) accepts the Graph
`serviceHealthIssue` shape as sent by Power Automate's Service Health connector or any Graph poller you run: the issue `id` becomes the
dedup key (`ms:<id>`), classification *incident* is Major and *advisory* is Minor, and `isResolved` / `status` decides firing or resolved.
Voxshift does **not** poll Graph itself for service health (that needs tenant-wide consent for every customer); the flow pushes to the
endpoint. Call quality (CQD) and SBC alerts arrive the same way as canonical alerts from whatever sends them.

## 2. Email

### Replies become comments

Customer-side incident emails carry `Reply-To: incidents+<token>@<your mail domain>`. The token is 26 lower-case base32 characters,
one per incident per person, valid 90 days. A reply from a customer is added to the incident as a comment (cleaned of quoted text; it ends "waiting on customer").
A reply from a staff member is added as an **internal note**, never a public message, so replying to a notification can never publish to the
customer by accident.

### Mail to the incidents address can raise an incident

If a customer has **Raise incidents by email** on (Incidents -> Settings, off by default), mail from a known customer user to
`incidents@<domain>` raises an incident (subject = title, body = description). `incidents+<customer-tag>@` can name the customer when the
sender belongs to several. Unknown senders, senders in several customers with no tag, and customers with the switch off are logged and
ignored (no auto-reply is ever sent, so nothing can be used to probe who is a customer).

### Setting up the mailbox (once, per environment)

Voxshift does not log in to a mailbox (no IMAP polling). A forwarder that you already trust posts each message:

1. Create the mailbox/alias `incidents@<domain>` that accepts `+tag` addresses (Microsoft 365: shared mailbox; plus-addressing is on by
   default).
2. Set the API's environment: `INBOUND_EMAIL_ADDRESS=incidents@<domain>` and `INBOUND_EMAIL_SECRET=<long random string>` (and the same
   address is used for the Reply-To). Until both are set, `POST /api/public/inbound-email` answers 404 and emails carry no Reply-To.
3. Build the forwarder (a Power Automate flow on the mailbox, an Azure Logic App, a Cloudflare Email Worker, or any SMTP-to-HTTP gateway)
   to `POST https://VOXSHIFT/api/public/inbound-email` with header `x-inbound-secret: <the secret>` and JSON:

```json
{
  "messageId": "<unique Message-ID>",
  "from": { "email": "sam@customer.com", "name": "Sam" },
  "to": ["incidents+abcdefghijklmnopqrstuvwxyz@domain"],
  "cc": [],
  "subject": "Re: INC-0042 ...",
  "text": "plain text body",
  "headers": { "Auto-Submitted": "no" },
  "authenticated": true,
  "attachments": 0
}
```

`authenticated` must be `true` only when your mail system verified the sender (SPF/DKIM/DMARC passed); **without it nothing is acted
on**, because a From address alone can be forged. `messageId` makes redelivery safe (a repeat is `duplicate`).

Every message gets an outcome in the Email log area of the database (`platform.inbound_email_log`: `replied`, `noted`, `raised`,
`duplicate`, `auto_reply`, `unauthenticated`, `not_ours`, `bad_token`, `sender_mismatch`, `user_inactive`, `not_member`,
`incident_gone`, `incident_closed`, `empty`, `disabled`, `ambiguous_customer`, `unknown_sender`, `site_ambiguous`, `error`), so a message
that "did nothing" can be explained. Out-of-office and bulk mail (`Auto-Submitted`, `Precedence`, `X-Auto-Response-Suppress`, no-reply
senders) is dropped as `auto_reply`.

## 3. Knowledge

Staff can save the fix from a resolved incident as a **knowledge snippet** (Incidents -> Knowledge, or "Save as knowledge" on the
incident): title, category, symptoms, the fix and optional text for customers. Snippets are per customer (tenant table
`incident_knowledge`), matched to new incidents by category, subcategory and words (`knowledgeScore`), shown to engineers on the
incident ("Seen before") and, where a snippet has customer text, to customers as a tip while they raise a matching incident. Staff mark
a suggestion helpful or not; ones that keep missing are easy to archive. Assistants see matches in `get_incident` (`knowledge`).

## 4. Past notices

Incidents -> Past notices lists a customer's major-incident notices (declared, updates, resolved) in one place, for status pages, QBRs
and "what did we tell them last time".

## 5. Teams channel for the MSP

Administration -> MSPs -> Teams channel: paste a **Workflows** (Power Automate "Post to a channel when a webhook request is received")
or Teams incoming-webhook URL. Only HTTPS URLs on Microsoft hosts are accepted (`*.webhook.office.com`, `*.logic.azure.com`,
`*.powerplatform.com`, `*.api.powerplatform.com`, `outlook.office.com`); the URL is encrypted at rest and never shown again (the page
shows the host and the last characters). Use **Send test card** to check it. Choose what is posted: new P1/P2 incidents, major incident
declared/resolved, and SLA breaches. Cards are Adaptive Cards with a link to the incident.

Delivery is through an outbox (`platform.msp_notifications`) worked by the worker every 15 seconds: failures retry with back-off
(30 s doubling, capped at 1 hour, 6 attempts) and then stay `failed` with the error. A dead webhook never slows or fails the incident.

## 6. Demo incidents

On a **sandbox** (test) customer a Super Admin can click **Add demo incidents** on the Incidents page: six realistic incidents (a P1
no-calls outage at the main site, a queue that is not ringing, choppy audio from home, a desk phone that will not provision, a resolved
one-way-audio incident that also becomes a knowledge snippet, and a voicemail greeting problem) once per customer, so there is
something to show. The button is not offered on real customers and the API refuses it there.

## Environment

| Variable | Used by | Meaning |
|---|---|---|
| `INBOUND_EMAIL_ADDRESS` | api | The incidents address, e.g. `incidents@mail.voxshift.io`. Empty = inbound email off. |
| `INBOUND_EMAIL_SECRET` | api | Shared secret the forwarder sends as `x-inbound-secret`. Empty = inbound email off. |

## Permissions

`intake:manage` (Super Admin) creates, edits, rotates and deletes alert sources and adds demo incidents. Setting up an MSP's Teams
channel is `msp:update`. Knowledge is part of `inc:manage` (staff) and `inc:read` (customers see customer text only).
