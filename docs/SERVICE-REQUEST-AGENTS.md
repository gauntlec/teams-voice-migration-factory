# Assistants completing service requests

An assistant can carry a **change or removal request** from "Planned" to "Deployed" with **one human approval**:
where every step is mechanical and can be checked. This page is the design, the guardrails and the API. The agent
platform itself is [AGENTS.md](AGENTS.md); the assistant Voxshift ships for this is **Voxshift Changes**
([BUILTIN-AGENTS.md](BUILTIN-AGENTS.md)); the MCP tools are in [MCP.md](MCP.md).

## Who may do this: assistants set up for service requests

Only an assistant whose **Works on** includes **Service requests** can use these routes; an incident-only assistant is refused with `403 wrong_area`
([AGENTS.md](AGENTS.md), "Where an assistant works"). The recommended pattern is a **change assistant that works on service requests only**:
it never reads incident text, so nothing a customer or a monitoring tool wrote in an incident can steer it towards a change. The built-in
**Voxshift Changes** is exactly that. The skill to give a bot is `docs/agents/voxshift-service-request-assistant/SKILL.md`.

## Which requests qualify (automation profile)

Only a request whose type is a **change or removal of something that already exists in Design & Build**, and where
**nothing is left for a person to decide** (`srAutomation` in `packages/shared/src/service-request-agents.ts`):

| Type | Applied automatically | Not automatable (a person decides) |
|---|---|---|
| Change a user | new number (if still free), voicemail on/off | call forwarding, calling permissions, "something else" |
| Change a call queue | agents added / removed, routing method | timeout / overflow, "something else" |
| Change an auto attendant | greeting, a holiday closure | opening hours, menu, "something else" |
| Remove a user / common area phone | revoke Enterprise Voice (remove the number and calling) | - |

It is the same mapping an engineer's **Apply the request** uses (`srChangePlan`). A request also needs: no free-text
notes, no "when" instruction, no future last-working-day (those are timing and meaning a person has to judge), and
nothing the apply could not map. Clearing a leaver's number afterwards, and checking a holiday closure's default
message, are **follow-ups for a person after the deploy**, not decisions before it. New things (users, queues,
attendants, sites, numbers) and "something else" are never automated. `GET` on a request says `automation.eligible`,
the reasons if not, and what it would apply.

## The steps and the autonomy each needs

New action class **`change_design`** (applying a request to the design: reversible, not live; cap 3, default 0).

| Step | Endpoint | Class | Needs |
|---|---|---|---|
| Take it, add notes, hand over | `claim`, `notes`, `handoff` | triage / internal_note | policy on, lease |
| New to **Planned** | `status {to:'planned'}` | triage | "act alone", lease, eligible |
| **Apply the request** to the design | `apply` | change_design | "act alone", or an approved proposal at "act with approval"; Planned; lease |
| Design done: **Designed & built** | `status {to:'built'}` | change_design | "act alone", no design blockers |
| **What-If** (the exact commands, clean or not) | `what-if` | change_whatif | as apply; recorded on the request |
| **Deploy** | `deploy {proposalId}` | change_deploy | **an approved proposal**, at "act with approval" (the cap; a deploy is never unattended) |

A reply to the customer is a `comment` proposal (customer-visible text: a person always approves it). An assistant can
never decline, cancel or send back a request: if it is stuck it hands over.

## The deploy: one approval, command for command

1. The assistant proposes `external` / `change_deploy`. The **server** computes the plan now (rows, the exact rendered
   commands) and refuses unless the What-If is **clean** (something to do, **zero warnings**). It stores the commands
   and a SHA-256 **fingerprint** of them on the proposal; whatever the assistant sent in `args` is ignored.
2. A person sees the commands on the request page and approves **onto one of their own signed-in tenant sessions**
   (`connectionId`; they need `deployment:execute`; a session belonging to someone else, or not active, is refused).
   At approval the plan is recomputed: if it no longer matches (or is no longer clean) the proposal is **failed**, not
   approved.
3. The assistant calls `deploy {proposalId}`. The platform re-checks **everything** and refuses (failing the proposal)
   if any of these is false:
   - the request has an automation profile and is still eligible;
   - the proposal is approved, by an active person, with a session;
   - the request is Designed & built, and any customer approval is given (not pending or rejected);
   - the **customer's change window is open** (an assistant never uses the "outside the window, and here is why" path:
     a person decides that);
   - the What-If is still clean and its **fingerprint equals the approved one**;
   - the tenant is not read-only and there is no maintenance freeze (the normal deployment path), one live run per session;
   - a person has not taken the request over; the assistant holds the lease.
   The scope is fixed by the request (its own rows plus what they depend on), never chosen by the caller.
4. It runs **as the approver, on their session** (the run, the worker and the audit log show who authorised it), tagged
   with the assistant and the proposal; the assistant releases its lease because the result reports back by itself.
5. **The request is not "Deployed" when the run finishes.** The worker re-reads the live tenant
   (`deployment-verify`) and only a **clean re-check** (every account matches the design) moves it to Deployed, credited
   to the assistant "as approved by <person>". Differences, a failed or skipped re-check, or a run with failed changes
   leave it **Designed & built**, stop the assistant, tell the team (`agent_deploy_check`) and add a note to any incident
   the request is linked to.

## Data

Tenant migration `0052_sr_agents.sql`: `service_requests.assigned_agent_id`, `agent_hold`, `incident_id`;
`service_request_events.actor_type` + `meta` and the kinds `claim_started`, `claim_released`, `handoff`, `proposal`,
`proposal_decided`, `whatif`; `service_request_claims` (one live lease per request); `service_request_actions`
(proposals: kind, class, params, rationale, risk, state, decision, `connection_id`, `fingerprint`, result).
Platform `0019`: `agent_events.request_id`; `0020`: the `changes` built-in.

## Agent API

`/api/agent/v1/service-requests` (same token, `Idempotency-Key` and autonomy rules as incidents):

| Call | |
|---|---|
| `GET ?status&type&assigned&automatable&tenantId&limit` | requests across the customers it may work; `automatable` says which it could carry through |
| `GET /:tenantId/:id` | request, timeline, design, `automation`, `whatIf` (verdict, commands, fingerprint), runs, claim, proposals, `autonomy` |
| `POST /:t/:id/claim`, `.../claim/heartbeat`, `DELETE .../claim` | the lease (600 s default); releasing clears the assignee |
| `POST .../notes` `{body}` | internal note |
| `POST .../status` `{to: planned\|built, note?}` | see the table |
| `POST .../apply` `{proposalId?}` | apply the request to the design |
| `POST .../what-if` `{proposalId?}` | the exact commands, clean or not |
| `POST .../deploy` `{proposalId}` | deploy as approved (`409` with a `code`: `not_automatable`, `not_built`, `not_approved`, `outside_window`, `whatif_not_clean`, `plan_changed`, `no_session`, `approver_gone`, `taken_over`, `propose_instead`) |
| `POST .../proposals`, `GET .../proposals`, `POST .../proposals/:id/result` | `comment`, `status`, `external` (change_design / change_whatif / change_deploy); a deploy reports its own outcome |
| `POST .../handoff` | what it tried, found, recommends |

Events (`GET /events`): `sr.created`, `sr.updated`, `sr.assigned`, `sr.message`, `sr.proposal.decided`,
`sr.claim.revoked`, `sr.claim.expired`, each with `request_id`.

## People's side

On the request page, engineers see an **Assistant** card: whether an assistant could carry it through, who holds it,
**Take over** (the assistant is locked out until you hand it back), and its proposals. A deploy proposal shows the exact
commands and a picker for your own active session ("Approve and deploy"). The Assigned-to picker offers assistants. The
queue and lists show "Name (AI)". `POST /t/:id/service-requests/:id/incident` links a request to an incident (and the
incident lists the request among its items); `.../takeover`, `.../hand-back`, `.../proposals/:id/decision` and `GET
.../agents` are the human routes. The service request report shows how many completed requests an assistant got over the
line.

## Connection model

Chunk 7 ships model (a): an assistant deploys only on **a human engineer's own live session, after that person approved
the exact plan**. A dedicated service connection per customer (app-only certificate auth, for unattended work) is not
built; if it is, it is a Super Admin opt-in per customer and still sits behind these same guardrails (the cap on
`change_deploy` stays at "act with approval").
