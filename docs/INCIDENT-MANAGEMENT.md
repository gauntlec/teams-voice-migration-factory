# Incident management (design and build plan)

Status: **design approved for build in chunks** - see the [build log](#build-log) at the
bottom for what has shipped. Each chunk below is sized for one usage window, is
shippable on its own, and ends with a deploy and a live check.

Incident management is for a **Teams Voice managed service**: something that worked
has stopped working, or is working badly (calls failing, poor audio, an auto attendant
playing the wrong greeting). It sits beside Service Requests, which are planned
changes. It is built for three kinds of worker: customers raising incidents, MSP
engineers working them, and **AI agents** working them alone or alongside people.

## 1. What the market leaders do (and what we take)

| Product | What it does well | What Voxshift takes |
|---|---|---|
| **ServiceNow** | Priority is calculated from **impact x urgency** (P1-P4/5); SLA timers with pause conditions and breach escalation; a separate **major incident** track with a workbench (comms, bridge link, affected items, child incidents); incidents link to **problem** records so a fix removes the cause, not just the symptom. | Impact x urgency matrix; SLA clocks that pause on "waiting"; major incident with child incidents; problem records. |
| **Jira Service Management / Opsgenie** | Alerts map to **business services**; related alerts group into one incident; **severity** tiers (SEV1/SEV2 are "major"); stakeholders follow progress by notification or a status page; **post-incident review** with corrective actions tracked as work items. | Site/service as the affected "service"; alert grouping by dedup key; stakeholder subscriptions; post-incident review with follow-up actions. |
| **PagerDuty** | A tight lifecycle (**triggered -> acknowledged -> resolved**); a **dedup key** so repeated alerts append to one incident; responders added mid-incident; every lifecycle event is a hook that automation and AI agents subscribe to; agents ack when they start, resolve when a runbook succeeds. | Acknowledge as the "someone owns this" signal; dedup keys for monitoring intake; an events feed and webhooks; agents acknowledge, claim and resolve like people do. |
| **incident.io / Freshservice / Zendesk** | Roles on an incident (lead, comms); a clean public/internal timeline; configurable priority matrix; customer portal with plain status names; collaboration (swarming) on a ticket. | Incident lead and comms roles on major incidents; public vs internal notes (already in Service Requests); customer-friendly status labels; add-a-collaborator. |

Sources: ServiceNow incident management docs and community; Atlassian incident
management handbook and Opsgenie pages; PagerDuty Events API semantics; Freshservice
priority matrix docs; Microsoft Learn Teams voice troubleshooting modules and Direct
Routing monitoring docs.

**What we deliberately don't build:** paging/on-call rotas and phone alerting (the MSP
already has tools for this - we accept alerts in and notify by email/webhook), a full
CMDB, and a public status page for the whole internet. Customers see their own
incidents and customer-wide notices inside Voxshift.

## 2. How it fits Voxshift

Same shape as Service Requests so engineers already know it, and so we reuse rather
than rebuild:

- **Per customer switch**: incidents ride on the existing **Managed Services** switch
  (`platform.tenants.managed_services_enabled`). Settings live in a new
  `platform.tenants.inc_settings` jsonb (targets, matrix, contacts) like `sr_settings`.
- **Tenant schema tables** (per-customer Postgres schema): `incidents`,
  `incident_events` (timeline), `incident_items` (affected sites/users/numbers and
  linked service requests / deployments), `incident_watchers`, `incident_updates`
  (major incident customer updates), `problems`, `incident_actions` (agent proposals).
  Numbered `INC-0001` per customer, as `SR-0001`.
- **Operations-mode sites only**, and **site contacts** only see incidents on their
  own sites, exactly as for service requests.
- **MSP queue**: one queue across all customers of an MSP (`inc:msp`), built the same
  way as `/msp/service-requests`, plus a **Major incident board**.
- **Email**: the existing worker mail queue and branded templates; new `incident_*`
  templates (section 6).
- **Timeline actors** gain a type: `user`, `agent`, `system`. Everything an agent
  does is attributed, labelled "AI" in the UI, and audited.

### Permissions (new, in `packages/shared/src/rbac.ts`)

| Key | Meaning | Roles |
|---|---|---|
| `inc:read` | See this customer's incidents | SUPER_ADMIN, PROJECT_MANAGER, ENGINEER, CUSTOMER |
| `inc:create` | Raise an incident, comment, confirm or reopen your own | same |
| `inc:manage` | Triage, assign, change priority/status, internal notes, link, merge, declare major | SUPER_ADMIN, ENGINEER |
| `inc:msp` | MSP incident queue across an MSP's customers | SUPER_ADMIN, ENGINEER, PROJECT_MANAGER |
| `inc:agent` | Held only by agent principals (section 7), never by a role | agents |

## 3. The incident

### Status

```
New ──▶ In progress ──▶ Restored ──▶ Resolved ──▶ Closed
 │         │  ▲            │  ▲ (customer: "still broken")
 │         ▼  │            ▼  │
 │      On hold ◀──────────┘  │
 └─ Cancelled / Duplicate ◀───┘ reopen (7 days) from Resolved
```

- **New**: raised, nobody has acknowledged it. First-response clock runs.
- **In progress**: acknowledged by an owner (person or agent). Acknowledging stops the
  response clock.
- **On hold** with a required reason: **Waiting on customer**, **Waiting on carrier**,
  **Waiting on Microsoft**, **Waiting on vendor** (SBC/handset). Pauses the resolution
  clock, like Service Requests' "waiting".
- **Restored**: service is working again (workaround or fix) but the cause isn't
  closed. Stops the **restoration** clock; keeps the incident open for monitoring.
- **Resolved**: cause understood and fixed; customer is asked to confirm. Auto-closes
  after 5 days with no reply. The customer can say "still broken" -> back to In progress.
- **Closed**, **Cancelled** (raised in error), **Duplicate** (merged into another).

Customers see plain names: Received, Being worked on, Waiting on you / Waiting on
others, Service restored, Resolved, Closed (`INC_STATUS_CUSTOMER_LABELS`).

### Priority = impact x urgency

The customer picks **impact** and **urgency** in plain words; priority is calculated
(`incidentPriority(impact, urgency)`, pure and unit tested) and staff can override it
with a reason.

| Impact (who is affected) | Urgency (what can't they do) |
|---|---|
| Just me / one person | Cannot make or receive calls |
| A team or several people | Calls work but badly (quality, wrong routing) |
| A whole site | A feature is broken (voicemail, forwarding, menus) |
| The whole company | A question or cosmetic problem |

Rules layered on top: anything in **Emergency calling** is raised as **P1** regardless
of the matrix; a whole-company impact with "cannot make or receive calls" is P1.
Default matrix (editable in settings):

| | Cannot call | Badly | Feature broken | Question |
|---|---|---|---|---|
| Whole company | P1 | P2 | P3 | P4 |
| Whole site | P1 | P2 | P3 | P4 |
| Team | P2 | P3 | P3 | P4 |
| One person | P3 | P3 | P4 | P4 |

### Targets (defaults, calendar hours; editable per customer)

| Priority | Respond | Restore | Resolve | Cover |
|---|---|---|---|---|
| P1 | 15 min | 4 h | 8 h | 24x7 |
| P2 | 1 h | 8 h | 24 h | 24x7 or business hours per customer |
| P3 | 4 h | 24 h | 72 h | business hours |
| P4 | 8 h | - | 120 h | business hours |

Business-hours coverage needs a per-customer working calendar (timezone, hours,
holidays) - part of chunk 3. Clocks pause while on hold (except P1 "waiting on
Microsoft/carrier", which keeps running because the customer can't act on it - a
setting).

### Categories (Teams Voice)

Two levels, defined once in `packages/shared/src/incidents.ts` (`INC_CATEGORIES`) like
`SR_TYPE_DEFS`, so the form, validation, routing and bot runbooks all read one list.
Each category carries: label, plain-language help, the diagnostic questions the form
asks, a default priority floor, the skill it routes to, and which agent runbooks may
help.

| Category | Sub-categories | Notes |
|---|---|---|
| **Call failure & routing** | Can't make outbound calls · Can't receive inbound calls · Calls go to the wrong place · Busy / fast-busy / "number not in service" · International or premium blocked · Calls drop mid-call | Asks: direction, calling and called number, time (with timezone), error heard or shown, one or all users. SIP / Microsoft diagnostic codes captured as a field. |
| **Call quality** | Choppy or robotic audio · One-way or no audio · Echo or feedback · High latency · Quality bad on wifi / remote only | Asks: network type, location (site / home / VPN), device, example calls. Links to Call Analytics / CQD. |
| **Emergency calling** | Emergency call failed · Wrong location delivered · Callback number wrong · Notification not received · Location-based routing | Always P1. Form shows "If a life is at risk, use another phone to call emergency services now." |
| **Direct Routing / SBC / carrier** | SBC offline or OPTIONS failing · Certificate expired / expiring · Carrier trunk down · Channel capacity · Media bypass / TLS · SBC firmware or config | Staff-raised or monitoring-raised mostly; customers can still report "all calls failing". |
| **Numbers & porting** | Number not working · Caller ID wrong · Port delayed or failed · Number assigned to the wrong person · Number range / DID issue | Links to the number inventory and number-port records. |
| **Users, licences & policies** | No dial pad / no calling · Licence (Phone System) missing · Calling policy or voice routing policy · Voicemail not working · Call forwarding / simultaneous ring · Delegation / boss-admin | Reads the discovered user. |
| **Call queues & auto attendants** | Queue not ringing agents · Wrong agents or routing · Greeting / menu wrong · Hours or holiday schedule wrong · Overflow / timeout wrong · Resource account problem | Links to the queue / AA and its resource account. |
| **Devices & Teams client** | Desk phone won't sign in or provision · Common area phone issue · Teams client problem · Headset / audio device · Teams Rooms · Firmware | Links to CAP records. |
| **Voicemail & recording** | Voicemail not delivered · Greeting problem · Transcription · Call recording / compliance recording · Analytics | |
| **Microsoft service / platform** | Suspected Microsoft outage · Admin centre issue · Licensing / tenant setting | Staff check the Microsoft service health before working. |
| **Voxshift** | A deployment failed · Tenant connection problem · Wrong data in Voxshift | Routed to the platform team, not the customer's engineers. |
| **Something else** | | Free text. |

## 4. Customer view

Route `/incidents` (shown only when Managed Services is on, like Service Requests).

- **Raise an incident**: a guided form, not a blank box. Pick what's wrong
  (category, then sub-category, in plain words) -> pick the **site** (operations-mode
  sites only) -> who is affected and what they can't do (impact and urgency, with the
  resulting priority shown in words, e.g. "We'll treat this as high priority") ->
  the category's own questions -> **example calls** (repeatable: date/time, from, to,
  what happened) -> description -> attachments -> best contact number. Pickers use
  discovered data (people, queues, auto attendants, numbers) as in Service Requests.
- **Similar incidents banner**: before submitting, "We're already working on a
  problem at your Reading site - subscribe to it instead?" (matches open incidents and
  major incidents on the same site/category; subscribing adds you as a watcher).
- **My incidents / My site's incidents**: list with plain status, priority and "next
  update by" time. Open one: summary, updates from the team, conversation, attach more,
  **Confirm fixed** / **Still broken**, **Add people to keep informed**.
- **Customer-wide notices**: a banner for declared major incidents ("We're aware of a
  problem affecting calls at Reading - next update 14:30").
- Customers never see: internal notes, agent reasoning, linked deployments, other
  customers, who internally is assigned beyond a display name, raw diagnostics.

## 5. Admin / engineer view (aligned to the MSP, as Service Requests)

- **Per customer** `/incidents`: same page, staff mode - summary tiles (Open, New and
  unacknowledged, At risk, Overdue, Major, Waiting, Assigned to an agent), filter by
  category, priority, site, assignee (people **and** agents), SLA state.
- **Incident page**: header with priority/status/SLA clocks; Overview (details, example
  calls, affected items); Timeline (public + internal, filter by actor type); Actions
  tab (agent proposals awaiting approval, run results); Linked items (service requests,
  deployments, number ports, problem, parent/child incidents); Diagnostics (chunk 6).
- **MSP queue** `/msp/incidents` (`inc:msp`): every customer of the MSP, most urgent
  first (priority, then SLA), "Assigned to me", assign / reply / note from the queue
  without opening the customer, same scoping rules as `/msp/service-requests`.
- **Major incident board** `/msp/incidents/major`: declared major incidents with
  status, lead, comms owner, next-update clock, child incidents, bridge link, latest
  customer update.
- **Reports**: raised / restored / resolved per month, MTTA (time to acknowledge), MTTR,
  SLA met by priority, by category and by site, repeat incidents, top problems, how
  many were fixed by an agent alone / with a person / by a person.

### Major incidents and problems

- **Declare major** (P1, or engineer's call): sets an incident lead and a comms owner,
  creates a **customer notice**, starts the update cadence (P1: every 30 minutes;
  reminders to the comms owner, escalation if missed). Related incidents are linked as
  **children**; closing the parent offers to resolve the children with the same note.
- **Problem record**: an incident that needs root cause ("SBC certificate renewal
  process keeps slipping") links to a `problems` row with owner, root cause,
  workaround, status (Investigating / Known error / Fix planned / Resolved), and the
  incidents under it. Known errors show on matching new incidents so engineers and
  agents can apply the known workaround.
- **Post-incident review** for major incidents: template (what happened, timeline
  pulled from the incident, cause, what worked, what didn't, corrective actions with
  owners and dates). Actions can be raised as Service Requests. Reviews can be shared
  to the customer once approved.

## 6. Email workflows

All use the customer's branding and link to `/incidents/:id`, through the existing
worker mail queue and `apps/worker/src/mail/templates.ts` (new templates, each with a
text version). Recipient rules mirror Service Requests: customer-side mail goes to the
reporter and watchers; team-side mail goes to the assignee or the whole team when
unassigned. Agents are never emailed; they get events (section 7).

| When | Template | To |
|---|---|---|
| Raised | `incident_created` | Reporter ("we've got it, INC-0042, priority High, we'll update you by 14:30"); team: engineers + Super Admins (+ MSP on-call list) |
| Acknowledged / assigned | `incident_status_changed` / `incident_activity` (`assigned`) | Reporter, new assignee |
| Public update from the team | `incident_message` (`update` / `question` / `reminder`) | Reporter + watchers; question = waiting on customer, reminded every 3 days, max 3 |
| Customer replies | `incident_activity` (`replied`) | Assignee or team |
| Priority changed | `incident_status_changed` (`priority`) | Reporter + watchers (with the reason if public) |
| Service restored | `incident_message` (`restored`) | Reporter + watchers |
| Resolved | `incident_resolved` | Reporter: **Confirm fixed** / **Still broken** (signed links, no login needed to answer, then lands in the app) |
| Auto-closed / reopened | `incident_status_changed` | Reporter / team |
| Major declared | `incident_major` | Customer stakeholders list (setting), watchers, team |
| Major update due / missed | `incident_activity` (`update_due`) | Comms owner, then lead |
| Target at risk / missed | `incident_activity` (`sla_warning` / `sla_breached`) | Assignee or team (P1 also the MSP escalation list) |
| Agent needs a decision | `incident_activity` (`agent_proposal`) | The human the proposal is routed to |
| Post-incident review shared | `incident_review` | Customer stakeholders |
| Customer-wide notice | `incident_notice` | Subscribed customer contacts |

Settings per customer: stakeholder distribution lists (by priority), whether watchers
get internal-priority changes, quiet hours for P3/P4 team mail. Later (chunk 8):
**inbound email** - replying to a notification adds a comment (reply token in the
address), and a dedicated mailbox raises incidents.

## 7. AI agents and engineers working together

### Principles

1. **Agents are first-class workers, not users in disguise.** They have their own
   identity, credentials, permissions and audit trail, and appear in assignee pickers,
   the timeline and reports labelled as agents.
2. **Autonomy is earned and scoped.** Every agent has an autonomy level per action class
   per customer. Default for everything is *suggest*.
3. **Humans can always take over.** One click revokes the agent's claim and pauses its
   automation on that incident.
4. **Nothing an agent does is invisible or irreversible-by-default.** Customer-facing
   words and any change to a live tenant need either approval or a pre-approved
   template/runbook with guardrails.
5. **Same API for all agents.** First-party agents we build and a customer's or the
   MSP's own agents use the same interface.

### Agent principals

New platform table `agents`: id, name, kind (`triage` / `diagnostic` / `resolver` /
`comms` / `monitor` / `general`), owning MSP (or one customer), status (active /
paused / disabled), model/vendor label, created by. `agent_tokens`: hashed secrets
shown once, expiry, last used, scopes (`inc:read`, `inc:note`, `inc:update`,
`inc:propose`, `inc:act`, `sr:read`, `sr:propose`, `sr:act`, `diag:run`), customer
allow-list, IP allow-list (optional). Tokens are sent as `Authorization: Bearer
vxs_agent_...` and handled by a new guard alongside `JwtAuthGuard`; they can never
reach user, tenant or billing endpoints. A Super Admin **kill switch** disables one
agent, all agents on a customer, or all agents.

### Autonomy levels

| Level | Meaning |
|---|---|
| 0 Observe | Reads incidents and the events feed; writes nothing |
| 1 Suggest | Adds internal notes and **proposals** (a structured next action); a human accepts or rejects |
| 2 Act with approval | Performs an approved proposal itself (e.g. runs a read-only diagnostic, sends a drafted update, runs a What-If) |
| 3 Act alone within guardrails | Performs allow-listed runbook actions without waiting (acknowledge, categorise, link duplicates, set on-hold, post a templated update, run read-only diagnostics, close confirmed-fixed incidents) |

Levels are configured per agent, per customer, per **action class**: `triage`,
`internal_note`, `customer_update`, `diagnostic_read`, `change_whatif`, `change_deploy`,
`resolve`. `change_deploy` is capped at level 2 unless a Super Admin explicitly raises
it for a named runbook on a named customer. Customer-visible text from an agent is
level 2 until a template is allow-listed.

### Working an incident together

- **Intake and triage**: a *monitor* or *triage* agent can create or enrich an incident
  (category, impact guess, duplicate detection, known-error match, related deployments
  in the last 7 days, affected users/numbers pulled from discovery). It acknowledges and
  assigns to itself or to the right human skill group.
- **Claims (leases)**: whoever works an incident holds a **claim** (person or agent) with
  a short lease the worker must renew while active (`incident_claims`: holder, started,
  expires, note). A second worker sees "Worked by Resolver-bot, lease ends 14:12" and
  can *join as collaborator* (comment only) or *take over*. A person taking over
  revokes the agent's claim, the agent receives `claim.revoked`, and further writes
  from it are refused (409) until handed back.
- **Handoff packet**: when an agent hands to a human (or back) it writes a structured
  summary: what was tried, what was found, evidence links, confidence, recommended next
  step. Shown at the top of the Actions tab.
- **Proposals**: `incident_actions` rows - kind, parameters, rationale, risk, who must
  approve, state (proposed / approved / rejected / running / done / failed / expired),
  result. UI shows pending proposals with Approve / Reject / Edit; approving by a human
  records who. Two-person rule optional for `change_deploy`.
- **Collaboration**: humans can @-mention an agent in an internal note or assign to it;
  the agent gets the event and replies on the timeline. Agents can ask a human a question
  (internal note with a `question` flag and a notification), and the human answers in the
  same place.
- **Stuck detection**: if a claim lapses or an agent fails twice, the incident returns
  to the unassigned queue and the team is notified; if an agent's confidence is low it
  must hand off rather than guess.
- **Customer-facing guard**: agent-authored public updates are marked "Voxshift
  assistant" until approved; policy can force approval for P1/P2.

### Interfaces for agents

1. **REST** under `/api/agent/v1` (OpenAPI described): `GET /incidents`, `GET
   /incidents/:tenant/:id` (with timeline, linked items, known errors, similar
   incidents), `POST .../ack`, `.../claim` (+ heartbeat), `.../notes`, `.../updates`,
   `.../status`, `.../category`, `.../link`, `.../proposals`, `.../handoff`; plus
   `GET/POST /service-requests...` for chunk 7. Every write takes an **idempotency key**
   and the incident **version** (optimistic concurrency - stale writes get 409 with the
   current state).
2. **Events feed + webhooks**: an append-only `agent_events` outbox (`incident.created`,
   `.updated`, `.message`, `.claim_revoked`, `.proposal_decided`, `sla.at_risk`,
   `sr.created` ...). Agents poll `GET /events?after=<cursor>` or register a signed
   (HMAC) webhook; at-least-once delivery with retries.
3. **MCP server** (chunk 6): the same operations as tools (`list_incidents`,
   `get_incident`, `add_internal_note`, `propose_action`, `run_diagnostic`, `draft_update`,
   `handoff`, ...) so Claude and other agent runtimes can work incidents natively.
4. **Diagnostics runner** (chunk 6): read-only checks the worker already knows how to do
   (user's Enterprise Voice state, number assignment vs Data Collection, queue/AA live
   config vs designed, Discovery drift, last deployments touching the object, licence
   check, SBC/pairing health, certificate expiry from discovery) exposed as named
   **runbook steps** with typed inputs/outputs, so a bot can call them and humans see
   the same results.

### Bots completing service requests (chunk 7)

Enhancing the Service Request module so agents can finish changes:

- Request types get an **automation profile** (`SR_TYPE_DEFS`): which steps an agent
  may do (`build-draft`, apply change, What-If, deploy), required checks, and the
  maximum autonomy. Good first candidates: change/remove user (voicemail, number),
  call queue agent add/remove, auto attendant holiday closure and greeting, new user.
- Agents can be **assigned** a service request, claim it, run **Apply the request**,
  edit the design within the request's rows (the existing lock rules still apply),
  run **What-If**, and propose or run **Deploy**.
- **Guardrails**: What-If must have zero warnings/failures; only the request's rows are
  in scope; change window respected; read-only tenants refuse; approval (customer
  approver where the type needs it, and human sign-off for deploy unless allow-listed);
  automatic rollback plan recorded (`deployment-rollback` already exists) and a
  post-deploy **verification** pass (`deployment-verify`) whose failure returns the
  request to Planned and alerts a human.
- **Tenant access for agents** (the one real design decision): today a tenant
  connection is a pwsh session bound to its owner. Options: (a) agent runs deploys on a
  *human engineer's* live session after approval (simple, human stays in the loop);
  (b) a dedicated **service connection** per customer using app-only certificate auth
  for the Teams module, owned by an agent principal (needed for unattended work). Plan:
  ship (a) first, design (b) with a Super Admin opt-in per customer.
- Service requests created from incidents ("fix = change request") and incidents
  raised from a failed service-request deployment link both ways.

## 8. Data sketch

Tenant schema (new migrations 0047+; platform 0016+):

- `incidents`: id, number (INC-0001), title, description, category, subcategory, site_id,
  impact, urgency, priority, priority_override_reason, status, hold_reason, source
  (`customer` / `staff` / `agent` / `monitor` / `email`), dedup_key, reporter_id,
  assigned_user_id / assigned_agent_id, major (bool), lead_id, comms_id, parent_id,
  problem_id, details jsonb (category answers, example calls), contact_phone, version,
  and the clock stamps (acknowledged_at, restored_at, resolved_at, closed_at,
  waiting_*, sla_notified, next_update_due_at, reopened_at).
- `incident_events`: kind (`created`, `status_changed`, `priority_changed`, `assigned`,
  `comment`, `question`, `note`, `update`, `claim`, `proposal`, `deployment`, `link`,
  `merge`, `major_declared`, `handoff` ...), actor_type (`user`/`agent`/`system`),
  actor_id, body, `internal`, links jsonb, `idempotency_key`.
- `incident_items`: incident_id, kind (`site` / `user` / `number` / `call_queue` /
  `auto_attendant` / `cap` / `service_request` / `deployment` / `number_port`), ref.
- `incident_watchers`, `incident_claims`, `incident_actions`, `incident_updates`
  (major incident public updates with approval), `problems`, `incident_reviews`.
- Platform: `agents`, `agent_tokens`, `agent_customer_policy` (autonomy per action
  class), `agent_events` outbox, `agent_webhooks`; `tenants.inc_settings`.

Everything keeps the existing conventions: Kysely, zod DTOs in `packages/shared`, pure
rules in shared with unit tests, DB behaviour in `tests/db`, audit log entries, and
docs updated in the same change.

## 9. Build plan - chunks for separate usage windows

Each chunk: start a fresh session, say "Build chunk N of docs/INCIDENT-MANAGEMENT.md",
tick the build log when done. Order matters from 1 to 5; 6-8 can swap.

### Chunk 1 - Foundations (data, rules, API)
Migrations (tenant `incidents`, `incident_events`, `incident_items`, `incident_watchers`;
platform `inc_settings`), shared module `incidents.ts` (categories, impact/urgency,
priority matrix, status transitions, customer labels, targets, SLA calc with pauses),
DTOs, permissions in `rbac.ts` + docs, `IncidentsModule` in the API: create, list
(site-scope aware), get, status moves (with required reasons), assign, comments,
internal notes, acknowledge, restore/resolve/close/reopen, priority override,
attachments (reusing the files store), audit entries. Unit tests for the pure rules;
`tests/db` for numbering, transitions, scoping, customer visibility. No UI yet beyond
nothing; ship behind the Managed Services switch.
*Done when*: API works end to end via tests, deployed, nothing visible to users.

### Chunk 2 - Customer and engineer UI
`/incidents` list and "Raise an incident" guided form (categories, example calls,
similar-incident banner, plain status), incident page (Overview, timeline,
conversation, attachments, Confirm fixed / Still broken, watchers), staff mode (tiles,
filters, assign, hold with reason, priority override, internal notes), left-nav entry,
empty states and mobile layout. Service-request-style site-contact scoping.
*Done when*: a test customer can raise and a staff user can work an incident in the
browser, verified live.

### Chunk 3 - Email workflows and SLA engine
All `incident_*` email templates (HTML + text, customer branding), recipient rules,
worker sweep (every 5 minutes for incidents) for at-risk/missed targets, waiting
reminders, auto-close of Resolved after 5 days, update-due reminders; per-customer
settings page (targets, matrix, working calendar, stakeholder lists, quiet hours);
signed Confirm / Still-broken links; email docs.
*Done when*: every row of the email table fires in the sandbox and live.

### Chunk 4 - MSP console, major incidents, problems, reports
`/msp/incidents` queue (assign / reply / note in place), major incident declaration
(lead, comms, cadence, customer notice banner), parent/child linking and merge /
duplicate, known errors, `problems` records, post-incident review template, reports
page (MTTA/MTTR/SLA, by category/site, repeat incidents).
*Done when*: a P1 can be declared, communicated, resolved and reviewed end to end.

### Chunk 5 - Agent platform
Platform `agents`, tokens, per-customer autonomy policy, agent guard, `/api/agent/v1`
read + note + ack + claim/heartbeat + proposals + handoff, idempotency and version
checks, `agent_events` outbox + polling + signed webhooks, claims/leases and the
takeover rules, proposals UI (Actions tab, approve / reject), agents as assignees and
filters, "AI" labelling, admin page to create agents / tokens / policies / kill
switch, audit. Includes a tiny reference agent script in `tests` that exercises the
contract.
*Done when*: an external script can triage and annotate an incident, a human can take
over from it, and everything is audited.

### Chunk 6 - First-party agents, diagnostics and MCP
Read-only **diagnostic runbook steps** in the worker (user voice state, number
assignment vs inventory, queue / AA live vs design, drift, recent deployments, licence,
certificate expiry), results stored on the incident; **MCP server** exposing the agent
API as tools; first agents as configuration + prompts: Triage (categorise, dedupe,
known-error match), Diagnose (runs the steps, writes a handoff packet), Comms (drafts
updates for approval). "Ask the assistant" button on the incident page.
*Done when*: a new incident is triaged and diagnosed by an agent with a human only
approving the customer update.

### Chunk 7 - Bots completing service requests
`SR_TYPE_DEFS` automation profiles; agents as SR assignees with claims; agent-callable
SR endpoints (apply request, edit design rows, What-If, deploy proposal); guardrails
(zero-warning What-If, scope, change window, approvals, verification, rollback);
connection model (a) first - agent deploys on an approved engineer session; design
and, if agreed, build (b) service connection; incident <-> service request links both
ways; reporting of agent vs human completed changes.
*Done when*: a "remove voicemail / add queue agent" request is completed by an agent
with one human approval, verified live.

### Chunk 8 - Inbound email, integrations, polish
Inbound email replies (reply tokens) and a mailbox that raises incidents; monitoring
intake endpoint with dedup keys (SBC / Teams service health / CQD alerts); Microsoft
service health link-in; knowledge snippets from resolved incidents suggested on new
ones; Teams channel notification for the MSP; customer-wide notices history;
performance, accessibility, docs and demo data; add an incident segment to the
executive demo deck.

## 10. Decisions needed (recommended defaults in bold)

1. One switch or two? **Reuse Managed Services** so customers get both; add a per-module
   toggle later if needed.
2. Agent access to the customer's Teams tenant: **human-approved session first (a)**,
   service connection (b) later and opt-in.
3. P1/P2 cover: **24x7 for P1, business hours for the rest**, configurable per customer.
4. Emergency calling: **always P1** and the form tells users to use another phone for a
   life-threatening situation (we are not an emergency service).
5. Who may declare a major incident: **engineers and Super Admins; agents may only
   propose it**.
6. Customer-visible agent text: **approval required** for P1/P2 and for any text not
   from an allow-listed template.

## Chunk 1 as built

What exists after chunk 1 (API and rules only - no screens, no emails yet):

- **Rules** (`packages/shared/src/incidents.ts`, 29 unit tests): categories and their
  questions (`INC_CATEGORIES`, reusing the service-request field specs so the chunk 2
  form can reuse that renderer), impact/urgency/priority and the matrix
  (`incPriority`, `incEffectiveMatrix`), status moves (`incMoveKind`), pauses
  (`incHoldPauses`, `incPause`), the three clocks (`incSla`, `incNextClock`),
  settings and all request DTOs. Permissions `inc:read`, `inc:create`, `inc:manage`,
  `inc:msp` in `rbac.ts`.
- **Data**: tenant migration `0047_incidents.sql` (incidents, incident_events,
  incident_items, incident_watchers, `incident_attachment` file category) and platform
  `0016_tenant_inc_settings.sql`. Columns for agents (`assigned_agent_id`,
  `actor_type`, `idempotency_key`, `version`) are in place so chunk 5 needs no
  reshaping.
- **API** (`apps/api/src/modules/incidents/`), under `/t/:tenantId/incidents`:
  `GET /` (filters: status, category, priority, site, assigned, q), `GET /sites`,
  `GET /assignees`, `GET|PUT /settings` (PUT: Super Admin), `POST /`, `GET /:id`,
  `POST /:id/status|assign|priority|comments|watchers|items`,
  `DELETE /:id/watchers|items/:itemId`, `GET|POST /:id/attachments`,
  `GET /:id/attachments/:fileId`.
- **Behaviour worth knowing**
  - Priority is calculated; only staff can set it at raise time or later (customers see
    that it changed, never the reason). Emergency calling is always P1.
  - A staff move, or the first public staff reply, is the acknowledgement the response
    clock stops at (an internal note is not).
  - A question (`waitForReply`) puts the incident **on hold, waiting on the customer**;
    the customer's reply resumes it. Holds on the customer, and on a carrier / Microsoft
    / vendor for P2-P4, pause the clocks; a P1 held on a third party keeps running.
  - A reopen ("still broken", within 7 days) restarts the restoration and resolution
    clocks and resets the pause total.
  - Every change bumps `version` and writes with `WHERE version = :read`, so a racing
    write is refused with 409.
  - Only operations-mode sites take incidents; site contacts only see and raise their
    own sites' incidents and cannot raise customer-wide ones.
  - Nothing is emailed yet (chunk 3), and no page shows incidents yet (chunk 2).
- **Tests**: `tests/db/src/incidents/incidents.db.test.ts` (35 tests against real
  Postgres: numbering, priority, workflow and who may make each move, pauses,
  visibility, site scoping, watchers, items, settings, attachments).

## Chunk 2 as built

Screens for customers and engineers (no emails yet - chunk 3; no MSP queue yet - chunk 4):

- **Left nav**: **Incidents** (`inc:read`, only when Managed Services is on), above Service Requests.
- **`/incidents`** (`pages/Incidents.tsx`): the list. Filters (not closed yet / each status / all,
  category, priority, search by title or INC-number; staff also Assigned to me / Unassigned),
  refreshes every 30 s. Staff get summary tiles (Open, Not acknowledged, Unassigned, On hold,
  At risk, Overdue - click to filter) and a "next target" badge. Customers see plain status
  names and "high / medium" priority wording.
- **`/incidents/new`** (`pages/IncidentNew.tsx`): the guided form - choose what is wrong
  (12 category cards, then sub-category), site (operations-mode sites only), who is
  affected and what they cannot do (with "We'll treat this as high priority" worked out live),
  the category's own questions, title and description, **example calls** (repeatable), optional
  callback number and attachments. The emergency category shows the "use another phone if
  anyone is in danger" warning. Before sending, open incidents of the same category at the
  site (or customer-wide) are offered to **follow instead** (`GET /incidents/similar`). The
  "Still needed before you can send it" list comes from the same `createIncidentSchema`
  the API validates with, so the form cannot drift from the API. Staff can set the priority
  themselves.
- **`/incidents/:id`** (`pages/IncidentPage.tsx`): progress strip, banners (emergency, "the
  team needs your reply", "the team says this is fixed"), facts and the three clocks with their
  targets, what was reported, example calls, affected/linked items, then what you can do:
  - Customer: **Yes, it's fixed**, **Still broken** (with what is wrong), cancel their own New
    incident, follow / stop following, comment, attach files.
  - Engineer: Acknowledge, Put on hold (with reason), Service restored, Mark resolved, Close,
    Reopen, Mark as duplicate (of another incident), Cancel; change priority with a private
    reason; assign; link items; public update, a question that waits on the customer, or an
    internal note. The timeline labels AI actors "(AI)" ready for chunk 5.
- **API addition**: `GET /incidents/similar?category=&siteId=` (36 database tests now).
- **Checked** with the built app against a throwaway mock API (staff and customer roles, the
  full raise flow); and then live on AT&T Voice Consult (list loads, no errors).

## Build log

| Chunk | Status | Commit / notes |
|---|---|---|
| 0 Research and design | Done 2026-10-14 | this document |
| 1 Foundations | Built and deployed 2026-10-14 (073e661), verified live (migrations applied to all 5 customer schemas) | See "Chunk 1 as built" |
| 2 Customer and engineer UI | Built and deployed 2026-10-14 (1455aa6), verified live | See "Chunk 2 as built" |
| 3 Email workflows and SLA engine | Not started | |
| 4 MSP console, major incidents, problems, reports | Not started | |
| 5 Agent platform | Not started | |
| 6 First-party agents, diagnostics, MCP | Not started | |
| 7 Bots completing service requests | Not started | |
| 8 Inbound email, integrations, polish | Not started | |
