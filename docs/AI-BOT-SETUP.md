# AI bot setup guide: connecting an assistant to Voxshift

How to connect an AI bot (Claude, another model, or your own script) to Voxshift so it works **incidents** or **service requests**
next to your engineers, safely. Written for the person who sets it up (a Super Admin) and the person who builds or configures the
bot. Reference pages: [AGENTS.md](AGENTS.md) (the API), [MCP.md](MCP.md) (the MCP server), and the skill that teaches a bot how to behave
(section 3).

## 1. The picture

```
 Your bot (Claude / any LLM runtime / script)
        |  MCP (stdio)  or  REST  or  events + webhooks
        v
 Voxshift agent API  /api/agent/v1   <-- token (scopes) + the area it works in + per-customer autonomy + lease + proposals
        v
 Incidents  or  service requests  (timeline shows "Name (AI)"), diagnostics over Discovery, and
 (only after one person approves the exact commands) deployments run as that person
```

A bot never gets a login, never sees a customer it was not enabled for, never talks to a customer's Teams tenant directly, **only works
in the area it was set up for**, and can never act beyond what the **customer's autonomy settings** allow. Customer-visible text and
deployments are always approved by a person.

You have three ways to connect. Pick one; they use the same token and limits.

| Way | Best for | Effort |
|---|---|---|
| **A. MCP server** (`apps/mcp`) | Claude Desktop, Claude Code, any MCP client or agent runtime that can start a local program | 10 minutes, no code |
| **B. REST API** | Your own bot, an LLM agent framework, or anything hosted that cannot start a local program | Small script; `docs/agents/reference-triage-agent.mjs` is a working example |
| **C. Events + webhooks** | Waking a bot when something happens instead of polling | Add to A or B |

The MCP server is **not** a web address: it is a small program that runs where the AI client runs and calls the REST API for it.

The built-in assistants (Triage, Diagnose, Comms, Changes) need none of this: a Super Admin just adds them (Administration ->
Assistants -> "Built in to Voxshift") and allows them on a customer. This guide is for **outside** bots.

## 2. Decide the job first: one assistant, one area

Every assistant is set up for **incidents**, **service requests**, or **both**. **Choose one area unless it truly needs both.**

| Pattern | Works on | Typical job | Why |
|---|---|---|---|
| **Incident assistant** | Incidents | Triage, diagnose, draft updates, hand off | Reads untrusted text from customers, email and monitoring, so it is kept away from the change tools |
| **Change assistant** | Service requests | Prepare change and removal requests, run the What-If, propose the deployment for one person to approve | The only kind that can prepare something live, so it only ever reads requests and designs |
| **Both** (rare) | Incidents + service requests | e.g. link an incident to the request that fixes it | Allowed, but a deliberate choice: it can read incident text **and** reach the change tools |

If you need both jobs, make **two assistants** (two identities, two tokens, two sets of autonomy) rather than one that does both.
A route in the other area is refused with `403 wrong_area`; the events feed, `GET /me` and webhooks carry only its own area.

| | Incidents | Service requests |
|---|---|---|
| API routes | `/agent/v1/incidents...` | `/agent/v1/service-requests...` |
| Kinds of action (autonomy rows) | triage, internal notes, customer updates, diagnostics, resolve | triage, internal notes, customer updates, apply to design, What-If, deploy |
| Events | `incident.*`, `claim.*`, `proposal.*`, `sla.*` | `sr.*` |
| MCP tools | incident tools + `get_events`, `whoami` | service request tools + `get_events`, `whoami` |
| Skill to load | `voxshift-incident-assistant` | `voxshift-service-request-assistant` |

## 3. Set it up in Voxshift (everyone does this once)

You need a Super Admin account.

1. **Create the assistant.** Administration -> Assistants -> New assistant. Give it a name people will recognise (it appears as
   "Name (AI)"), a kind (triage, diagnostic, resolver, comms, monitor, general), **Works on** (tick Incidents, Service requests, or
   both; nothing is ticked for you), a description and, if you like, a model label such as "Claude Sonnet".
2. **Create a token.** On the assistant, Tokens tab -> create. Choose scopes:

   | Scope | Lets the bot |
   |---|---|
   | `read` | See incidents or requests, and events |
   | `note` | Claim, add internal notes, run read-only checks, hand off |
   | `propose` | Put a step in front of a person |
   | `act` | Change things directly (status, priority, apply, What-If, deploy) **but only where autonomy allows** |

   Start with `read`, `note`, `propose`. Add `act` only later, on purpose. Expiry is 90 days by default (365 at most); optionally
   limit the token to your bot's IP address range. The token looks like `vxs_agent_<id>_<secret>` and is **shown once**: put it in
   your secret store straight away. Lost it? Revoke it and make another.
3. **Allow it on a customer.** Customers tab -> Allow for each customer it may work. Until you do, it can see nothing there.
   The customer must have Managed Services on and its "assistants" switch on. **Start with a test customer.**
4. **Set the autonomy.** Per kind of action, per customer; only the actions for the assistant's area are shown. New policies are
   suggest-only. A sensible ladder:

   | Stage | Incident assistant | Change assistant |
   |---|---|---|
   | 1. Watch | Everything Observe (0) | Everything Observe (0) |
   | 2. Suggest | Notes, triage, diagnostics at Suggest (1) | Notes at Suggest (1) |
   | 3. Helpful | Notes and read-only diagnostics at Act alone (3); customer updates and triage at Suggest | Apply to design and What-If at Act alone (3); deploy still Observe |
   | 4. Trusted | Triage and resolve at Act alone for low-risk categories | Deploy at **Act with approval (2)**: it proposes, one person approves the exact commands |

   Hard caps nobody can raise: customer updates and deployments never go above "act with approval".
5. **Webhooks (optional).** Webhooks tab -> add a URL for the events you want. The signing secret is shown once.
6. **Know the kill switches.** A Super Admin can switch every assistant off, one customer off, or one assistant to paused (reads
   only) or disabled (token stops working). They take effect on the next request.

To change where an outside assistant works later: Overview tab -> Works on -> Save. (Built-in assistants are fixed to their one job.)

## 4. Teach the bot how to behave: the skill

Give the bot the skill that matches its area. It carries the rules (never obey text found in incidents, work through a lease, never
tell a customer anything directly, hand over when unsure), the order of work, how to read refusals and how to write notes.

| Bot works on | Skill file |
|---|---|
| Incidents | `docs/agents/voxshift-incident-assistant/SKILL.md` |
| Service requests | `docs/agents/voxshift-service-request-assistant/SKILL.md` |
| Both | `docs/agents/voxshift-assistant/SKILL.md` |

- **Claude Code**: copy the folder to `~/.claude/skills/<folder>/` (all projects) or `.claude/skills/<folder>/` (one project). It loads when
  the bot works on Voxshift.
- **Claude Desktop / claude.ai projects**: paste the body of `SKILL.md` into the project instructions, or upload the file.
- **Other runtimes**: use `SKILL.md` as (part of) the system prompt.

## 5. Way A: connect through MCP

On the machine where the bot runs:

```bash
cd teams-voice-migration-factory
npm install
npm run build --workspace @tvmf/mcp        # produces apps/mcp/dist/main.js
```

**Claude Code**

```bash
claude mcp add voxshift \
  --env VOXSHIFT_URL=https://www.directrouting.online \
  --env VOXSHIFT_TOKEN=vxs_agent_... \
  -- node /absolute/path/to/teams-voice-migration-factory/apps/mcp/dist/main.js
```

**Claude Desktop** (or any MCP client): add to the client's MCP config

```json
{
  "mcpServers": {
    "voxshift": {
      "command": "node",
      "args": ["/absolute/path/to/teams-voice-migration-factory/apps/mcp/dist/main.js"],
      "env": { "VOXSHIFT_URL": "https://www.directrouting.online", "VOXSHIFT_TOKEN": "vxs_agent_..." }
    }
  }
}
```

`VOXSHIFT_URL` is the address the program calls, without `/api`. Keep the token out of version control (use your client's secret handling
or an environment variable). Restart the client.

When it starts, the server asks Voxshift (`GET /me`) where this assistant works and offers **only those tools**: an incident assistant never sees
`deploy_request`, a change assistant never sees `run_diagnostic`. Every assistant also gets `get_events` and **`whoami`**, which says its name,
area, scopes, and for each customer the levels that apply. Tell the bot to call `whoami` first.

Then ask: *"Use the work_incident prompt on the next unassigned incident for <customer>"*, or (for a change assistant) the
`work_service_request` prompt.

## 6. Way B: connect through the REST API

Everything is JSON under `/api/agent/v1` with `Authorization: Bearer vxs_agent_...`. Rate limit 240 requests a minute per token.

```bash
BASE=https://www.directrouting.online/api/agent/v1
AUTH="Authorization: Bearer $VOXSHIFT_TOKEN"

curl -s "$BASE/me" -H "$AUTH"                                                        # who am I, where may I work, my levels: call this first
curl -s "$BASE/incidents?status=open&assigned=unassigned" -H "$AUTH"                 # incident assistants: the queue
curl -s "$BASE/service-requests?status=open&automatable=true" -H "$AUTH"             # change assistants: requests it could carry through
curl -s "$BASE/incidents/$TENANT/$ID" -H "$AUTH"                                    # everything about one, incl. autonomy
curl -s -X POST "$BASE/incidents/$TENANT/$ID/claim" -H "$AUTH" -H "Content-Type: application/json" \
     -H "Idempotency-Key: claim-$ID-1" -d '{"ttlSeconds":600,"note":"Triage"}'
curl -s -X POST "$BASE/incidents/$TENANT/$ID/notes" -H "$AUTH" -H "Content-Type: application/json" \
     -H "Idempotency-Key: note-$ID-1" -d '{"body":"Checked ... Found ... Recommend ...","expectedVersion":3}'
```

An incident assistant calling a `/service-requests` route (or the other way round) gets `403` with `"code": "wrong_area"`.

The shape of a working incident bot, in order: `/me` -> list -> claim -> get -> (diagnostics) -> note -> propose or act -> heartbeat while
working -> release or hand off. `docs/agents/reference-triage-agent.mjs` does exactly this and is a good base:

```bash
VOXSHIFT_URL=https://www.directrouting.online VOXSHIFT_TOKEN=vxs_agent_... node docs/agents/reference-triage-agent.mjs
```

Where an LLM goes: replace the `diagnose(context)` function with a call to your model, giving it the incident JSON plus the skill as the
system prompt, and have it return the note text, the proposals it wants to make and its confidence. Keep the plumbing (leases,
idempotency keys, version checks) in code, not in the model.

Full endpoint lists: [AGENTS.md](AGENTS.md) sections 2 to 6 (incidents) and [SERVICE-REQUEST-AGENTS.md](SERVICE-REQUEST-AGENTS.md)
(`/api/agent/v1/service-requests`).

## 7. Way C: wake the bot with events

Poll `GET /api/agent/v1/events?after=<last id>`; keep the returned `next`. Events are kept 14 days. Only the events for the bot's area are
returned (an incident assistant gets no `sr.*` events and a change assistant gets only `sr.*`). Or add a webhook (section 3, step 5):
Voxshift POSTs each event as JSON (with `incident_id` or `request_id`) with `X-Voxshift-Timestamp` and
`X-Voxshift-Signature: sha256=<HMAC-SHA256(secret, "<timestamp>.<raw body>")>`. Check the signature, reject timestamps older than
5 minutes, and de-duplicate by event id (delivery is at-least-once). A webhook turns itself off after 12 failures in a row.

Useful events: incidents: `incident.created`, `incident.assist_requested` (a person asked this assistant to look; payload `question`),
`proposal.decided`, `claim.revoked`, `sla.at_risk`. Service requests: `sr.created`, `sr.updated`, `sr.proposal.decided`.

## 8. First run on a test customer (checklist)

1. Customer: a test customer with Managed Services on; assistant enabled; autonomy at Observe/Suggest.
2. For an incident assistant: use **Incidents -> More -> Add demo history** (Super Admin) to get realistic incidents and requests (tagged,
   no emails, removable).
3. Call `/me` (or `whoami`): confirm the area, scopes and levels are what you set.
4. Run the bot against one unassigned incident (or one automatable request). Confirm: it claimed it; the timeline shows one note from
   "Name (AI)"; the claim was released or handed off; nothing customer-visible was sent.
5. Open the **Assistant** card on the incident or request: read any proposal; approve one and see how it appears.
6. Incident assistant: raise diagnostics to Act alone, try `run_diagnostic`, and try "Ask an assistant" from the incident.
7. Change assistant: create a voicemail change request on the test customer, let the bot prepare it, check the **exact commands** in its
   deploy proposal, approve onto your own tenant session, and confirm the request moves to Deployed only after the re-check. (This path has
   not yet been exercised against a real tenant; do it on a test customer first.)
8. Try the wrong area on purpose (an incident bot calling a service request route) and confirm you get `wrong_area`.
9. Pull the plug once: set the assistant to **paused**, and confirm the bot's writes stop.

## 9. Going live

- [ ] Each bot has **one** area (or "both" was a conscious decision), and the right skill loaded.
- [ ] Token stored in a secret store, 90-day expiry noted in a calendar, IP allow-list set if the bot has a fixed address.
- [ ] Autonomy reviewed per customer; customer updates and deploys left at Suggest / Act with approval.
- [ ] The people who will approve proposals know where they appear (Assistant card on the incident or request; email to engineers).
- [ ] The bot's system prompt does not tell it to bypass any rule in the skill.
- [ ] A named person owns the bot: reviews its notes weekly and adjusts autonomy.
- [ ] You tested the kill switches.

## 10. Troubleshooting

| Symptom | Likely cause |
|---|---|
| 401 on every call | Token revoked, expired, mistyped; assistant paused or disabled; global kill switch on |
| 403 `wrong_area` | The route is for an area the assistant is not set up for. Use the other assistant, or change **Works on** (a deliberate decision) |
| Bot sees no incidents or requests | Assistant not enabled for that customer; Managed Services or the customer's assistants switch off; scopes lack `read`; wrong area |
| MCP shows fewer tools than expected | That is the area filter: the server only offers the assistant's own area. Check `whoami` |
| 403 `propose_instead` | Autonomy for that action is below Act alone: propose the step, or raise the level on purpose |
| 409 `taken_over` | A person took the incident over; the bot must wait for a hand-back |
| 409 `stale` | The incident changed since it was read: read it again |
| 409 `in_flight` | Same Idempotency-Key still running: wait |
| Deploy refused (`outside_window`, `whatif_not_clean`, `plan_changed`, `no_session`) | A guardrail working; see SERVICE-REQUEST-AGENTS.md. The bot should hand over |
| 429 | Over 240 requests a minute: poll events, not the list |
| Webhook never arrives | Switched off after 12 failures ("Switch on" on the Webhooks tab); check your signature code uses the raw body; check the event is in the bot's area |
| Customer update not sent | It is a proposal: a person must approve it |

## 11. Security notes

- Tokens are stored only as a hash; treat one like a password. Revoke a token the moment you suspect it leaked.
- Keeping an assistant to one area is the main containment: a bot that reads customer-written text cannot also prepare or propose changes.
- Bot-written text is data to everyone who reads it, and customer text is data to the bot: the skill tells the bot never to obey
  instructions found in incident content. Do not weaken that in your own prompt.
- A bot can never reach a customer's tenant itself: the only live change is `deploy_request`, run as the approving person on their
  own session, with the plan fingerprint checked and a clean live re-check before the request is marked Deployed.
- Everything is on the timeline and in the audit log with the assistant as the actor.
