# Voxshift assistants (AI agents) - API reference

An **assistant** is an AI agent (or any script) that works incidents next to the MSP's engineers. It has its own
identity, its own tokens and its own permissions, and everything it does is on the incident timeline and in the
audit log. The design is in `docs/INCIDENT-MANAGEMENT.md` (section 7); this page is what a person building an
agent needs. A tested example is `docs/agents/reference-triage-agent.mjs`.

Base path: `/api/agent/v1`. JSON in, JSON out. Everything is relative to a customer (`tenantId`) the agent has
been enabled for.

## 1. Getting an agent

A Super Admin creates it on **Administration > Assistants**: name, kind (triage, diagnostics, resolver,
communications, monitoring, general), then:

1. **Tokens** - create one (scopes `read`, `note`, `propose`, `act`; expiry 90 days by default, 365 at most). The
   token `vxs_agent_<id>_<secret>` is shown **once**; Voxshift stores only a hash of the secret.
2. **Customers** - enable the agent for each customer and set its **autonomy** per kind of action (section 3).
   An agent can see nothing at a customer until that is done, and the customer must have Managed Services on.
3. **Webhooks** (optional) - a URL to be told about events (section 8).

Send the token as `Authorization: Bearer vxs_agent_...`. An optional IP allow-list can be set on the token.
Rate limit: 240 requests a minute per token.

## 2. Reading

| Call | Returns |
|---|---|
| `GET /incidents?status=open&assigned=unassigned&tenantId=&limit=` | Incidents at every enabled customer, most urgent first. `assigned` is `me` or `unassigned`. Each row has `tenant_id` and `id`. |
| `GET /incidents/:tenantId/:id` | The incident, its whole timeline (internal notes too), items, `knownErrors`, up to 5 `similar` open incidents, the current claim, proposals, and `autonomy` (your level per action class). |
| `GET /events?after=<id>&limit=` | The events feed (section 8): `{events, next}`. Keep `next` and send it as `after`. |
| `GET /incidents/:tenantId/:id/proposals` | Your proposals on the incident and their state. |
| `GET /incidents/:tenantId/:id/diagnostics` | Checks already run on the incident, and the checks worth running. (The incident itself also carries the latest as `diagnostics` and `suggestedChecks`.) |

## 3. What an agent may do: autonomy

Each customer sets a level for each **action class**. A new policy is suggest-only and allows no changes.

| Level | Meaning |
|---|---|
| 0 Observe | Reads only. |
| 1 Suggest | Adds internal notes and proposes steps; a person approves each. |
| 2 Act with approval | As Suggest, and carries out approved steps itself (diagnostics, What-If, deployments). |
| 3 Act alone | Does it directly, no waiting. |

| Action class | Cap | Default |
|---|---|---|
| `triage` (acknowledge, assign, hold, link, priority) | 3 | 1 |
| `internal_note` | 3 | 1 |
| `customer_update` (anything the customer sees) | **2** | 1 |
| `diagnostic_read` | 3 | 1 |
| `change_whatif` | 3 | 0 |
| `change_deploy` | **2** | 0 |
| `resolve` (restore, resolve, close) | 3 | 1 |

A level is never higher than its cap, whatever is saved. Customer-visible text always needs a person's approval
for P1 and P2, and never goes out unattended while its cap is 2. Deployments are never unattended. Emergency
calling incidents are always P1.

## 4. Claims (leases)

An agent works an incident only while it holds a **claim**:

- `POST .../claim` `{ttlSeconds?: 60..3600 (600), note?}` takes the incident (and assigns it to the agent). `409` if
  someone else holds it or a person has taken it over.
- `POST .../claim/heartbeat` `{ttlSeconds?}` renews it. Do this while you work.
- `DELETE .../claim` gives it up, and clears you as the assignee.

If the lease lapses, or the agent fails twice in a row, the incident returns to the queue and engineers are told.
A person can **take over** at any time (button on the incident); the agent is then read-only (`409`, code
`taken_over`) until the person **hands it back**. A claim is also revoked when a person assigns the incident to someone else; that emits
`claim.revoked`.

## 5. Writing

Every write needs a held claim, an `Idempotency-Key` header (so a retry does the same thing once) and, where
the body allows it, `expectedVersion` (the incident `version` you last read; `409` code `stale` if it moved).

| Call | Class | Body |
|---|---|---|
| `POST .../notes` | internal_note | `{body, expectedVersion?}` - internal only |
| `POST .../status` | triage, or resolve for restored / resolved / closed | `{to, note?, holdReason?, duplicateOf?, expectedVersion?}` |
| `POST .../priority` | triage | `{priority, reason, expectedVersion?}` |
| `POST .../items` | triage | `{kind, ref, label?}` link an affected item |
| `POST .../diagnostics` | diagnostic_read | `{runbook, input?, proposalId?}` - a read-only check ([DIAGNOSTICS.md](DIAGNOSTICS.md)); level 3 directly, level 2 only for an approved proposal |
| `POST .../handoff` | - | see below |

A direct write needs level **3** for its class. Below that the call fails with `403` code `propose_instead` and
the agent should propose the step instead.

**Handoff**: `{to: 'queue'|'human', toUserId?, summary: {tried[], found[], recommendation, confidence: low|medium|high, evidence[{label,url?}]}}`.
It releases the claim, writes the summary on the timeline and returns the incident to the queue or to the person.

## 6. Proposals

`POST .../proposals` `{kind, params, rationale, risk?: low|medium|high, expiresInMinutes?}` puts a step in front
of a person (Assistant card on the incident, plus an email to the engineers). At most **5 open proposals per
agent**; they expire after 24 hours by default (7 days at most).

| Kind | Params | Carried out by |
|---|---|---|
| `customer_update` | `{body}` | the platform, as the agent, on approval |
| `ask_customer` | `{body}` (and waits for the reply) | the platform |
| `status_change` | `{to, note?, holdReason?, duplicateOf?}` | the platform |
| `set_priority` | `{priority, reason}` | the platform |
| `assign_user` | `{userId}` | the platform |
| `declare_major` | `{leadId, commsId?, intervalMinutes?, summary}` | the platform, as the approver |
| `link_problem` | `{problemId}` | the platform, as the approver |
| `link_item` | `{kind, ref, label?}` | the platform |
| `external` | `{actionClass: diagnostic_read\|change_whatif\|change_deploy, title, detail?, args?}` | the **agent**, after approval |

Only engineers and Super Admins declare major incidents; an agent can only propose it. For `external` steps
the agent (level 2 or 3 for that class) does the work after the proposal is approved, then reports with
`POST .../proposals/:proposalId/result` `{state: running|done|failed, result?, error?}`.

Proposal states: `proposed`, `approved`, `rejected`, `running`, `done`, `failed`, `expired`.

## 7. Safety limits

- **Kill switches**: Super Admin can switch every assistant off (global), switch one customer off (`agents_enabled`)
  or set one assistant to `paused` (reads only) or `disabled` (its tokens stop working). They take effect on the
  next request.
- Agents never appear as the sender of an email. Staff see "Name (AI)"; customers see "Voxshift assistant".
- Errors carry `code` where an agent can act on it: `taken_over`, `stale`, `propose_instead`, `in_flight`
  (the same Idempotency-Key is still running).

## 8. Events

Every event has `id` (increasing), `tenant_id`, `incident_id`, `kind`, `created_at` plus context in the payload.
Kinds: `incident.created`, `incident.updated`, `incident.message`, `incident.assigned`, `incident.major_declared`,
`claim.revoked`, `claim.expired`, `proposal.decided`, `proposal.expired`, `sla.at_risk`, `sla.breached`,
`incident.assist_requested` (a person asked this assistant to look at an incident: payload `question`, `askedBy`).

Only customers the agent is enabled for are included. Events are kept 14 days; an agent that has been away longer
reads the queue again.

**Webhooks**: each event is POSTed to the webhook URL as JSON. Headers `X-Voxshift-Timestamp` (unix seconds) and
`X-Voxshift-Signature: sha256=<hex>` where the value is `HMAC-SHA256(secret, "<timestamp>.<raw body>")`. Check the
signature and reject timestamps more than 5 minutes old. Delivery is at-least-once, retried with backoff; a webhook
turns itself off after 12 failures in a row (use "Switch on" on the Webhooks tab). The secret is shown once
at creation and stored encrypted.

```js
const expected = 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader))) reject();
```

## 9. People's side (not for agents)

`/api/t/:tenantId/incidents/:id/takeover`, `.../hand-back`, `.../proposals/:id/decision`
`{decision: approve|reject, note?}`, `GET .../agents` (assignable assistants), and the admin routes under
`/api/agents` (create, tokens, policies, webhooks, kill switch). Permission `agent:manage` (Super Admin) for the
admin routes; engineers decide proposals and take over.

## 10. Not yet built

Agents creating incidents and monitoring intake with de-duplication keys (chunk 8) and agents completing
service requests (chunk 7). The diagnostic runbooks ([DIAGNOSTICS.md](DIAGNOSTICS.md)) and the assistants Voxshift
ships ([BUILTIN-AGENTS.md](BUILTIN-AGENTS.md)) exist, and the same API is available as MCP tools ([MCP.md](MCP.md)).
