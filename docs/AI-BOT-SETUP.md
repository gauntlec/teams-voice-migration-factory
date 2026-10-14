# AI bot setup guide: connecting an assistant to Voxshift

How to connect an AI bot (Claude, another model, or your own script) to Voxshift so it works incidents and service requests
next to your engineers, safely. Written for the person who sets it up (a Super Admin) and the person who builds or configures the
bot. Reference pages: [AGENTS.md](AGENTS.md) (the API), [MCP.md](MCP.md) (the MCP server),
[agents/voxshift-assistant/SKILL.md](agents/voxshift-assistant/SKILL.md) (the skill that teaches a bot how to behave).

## 1. The picture

```
 Your bot (Claude / any LLM runtime / script)
        |  MCP (stdio)  or  REST  or  events + webhooks
        v
 Voxshift agent API  /api/agent/v1   <-- token (scopes) + per-customer autonomy + lease + proposals
        v
 Incidents and service requests (timeline shows "Name (AI)"), diagnostics over Discovery, and
 (only after one person approves the exact commands) deployments run as that person
```

A bot never gets a login, never sees a customer it was not enabled for, never talks to a customer's Teams tenant directly, and
can never act beyond what the **customer's autonomy settings** allow. Customer-visible text and deployments are always approved
by a person.

You have three ways to connect. Pick one; they use the same token and limits.

| Way | Best for | Effort |
|---|---|---|
| **A. MCP server** (`apps/mcp`) | Claude Desktop, Claude Code, any MCP client or agent runtime | 10 minutes, no code |
| **B. REST API** | Your own bot or an LLM agent framework | Small script; `docs/agents/reference-triage-agent.mjs` is a working example |
| **C. Events + webhooks** | Waking a bot when something happens instead of polling | Add to A or B |

The built-in assistants (Triage, Diagnose, Comms, Changes) need none of this: a Super Admin just adds them (Administration ->
Assistants -> "Built in to Voxshift") and allows them on a customer. This guide is for **outside** bots.

## 2. Set it up in Voxshift (everyone does this once)

You need a Super Admin account.

1. **Create the assistant.** Administration -> Assistants -> New. Give it a name people will recognise (it appears as
   "Name (AI)"), a kind (triage, diagnostic, resolver, comms, monitor, general), a description and, if you like, a model label
   such as "Claude Sonnet".
2. **Create a token.** On the assistant, Tokens tab -> create. Choose scopes:

   | Scope | Lets the bot |
   |---|---|
   | `read` | See incidents, requests, events |
   | `note` | Claim, add internal notes, run read-only checks, hand off |
   | `propose` | Put a step in front of a person |
   | `act` | Change things directly (status, priority, apply, What-If, deploy) **but only where autonomy allows** |

   Start with `read`, `note`, `propose`. Add `act` only later, on purpose. Expiry is 90 days by default (365 at most); optionally
   limit the token to your bot's IP address range. The token looks like `vxs_agent_<id>_<secret>` and is **shown once**: put it in
   your secret store straight away. Lost it? Revoke it and make another.
3. **Allow it on a customer.** Customers tab -> enable for each customer it may work. Until you do, it can see nothing there.
   The customer must have Managed Services on and its "assistants" switch on. **Start with a test customer** (for example
   AT&T Voice Consult).
4. **Set the autonomy.** Per kind of action, per customer. New policies are suggest-only. A sensible ladder:

   | Stage | Settings | What you learn |
   |---|---|---|
   | 1. Watch | Everything Observe (0) | The bot reads and says what it would do (use a note-only run) |
   | 2. Suggest | Internal notes, triage, diagnostics at Suggest (1) | Quality of its notes and proposals |
   | 3. Helpful | Internal notes and read-only diagnostics at Act alone (3); customer updates and triage at Suggest | Time saved; nothing risky |
   | 4. Trusted | Triage and resolve at Act alone for low-risk categories; changes at Act alone for design steps; deploy at Act with approval | Service requests carried to Deployed with one approval |

   Hard caps nobody can raise: customer updates and deployments never go above "act with approval".
5. **Webhooks (optional).** Webhooks tab -> add a URL for the events you want. The signing secret is shown once.
6. **Know the kill switches.** Super Admin can switch every assistant off, one customer off, or one assistant to paused (reads
   only) or disabled (token stops working). They take effect on the next request.

## 3. Way A: connect through MCP

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

`VOXSHIFT_URL` is the address without `/api`. Keep the token out of version control (use your client's secret handling or an
environment variable). Restart the client; you should see the Voxshift tools.

**Teach the bot how to behave** with the skill:

- **Claude Code**: copy the folder `docs/agents/voxshift-assistant/` to `~/.claude/skills/voxshift-assistant/` (all projects) or
  `.claude/skills/voxshift-assistant/` (one project). It loads when the bot works on Voxshift.
- **Claude Desktop / claude.ai projects**: paste the body of `SKILL.md` into the project instructions, or upload the file.
- **Other runtimes**: use `SKILL.md` as (part of) the system prompt.

Then ask: *"Use the work_incident prompt on the next unassigned incident for AT&T Voice Consult"*, or run the `work_incident` /
`work_service_request` prompts directly.

## 4. Way B: connect through the REST API

Everything is JSON under `/api/agent/v1` with `Authorization: Bearer vxs_agent_...`. Rate limit 240 requests a minute per token.

```bash
BASE=https://www.directrouting.online/api/agent/v1
AUTH="Authorization: Bearer $VOXSHIFT_TOKEN"

curl -s "$BASE/incidents?status=open&assigned=unassigned" -H "$AUTH"                 # the queue
curl -s "$BASE/incidents/$TENANT/$ID" -H "$AUTH"                                    # everything about one, incl. autonomy
curl -s -X POST "$BASE/incidents/$TENANT/$ID/claim" -H "$AUTH" -H "Content-Type: application/json" \
     -H "Idempotency-Key: claim-$ID-1" -d '{"ttlSeconds":600,"note":"Triage"}'
curl -s -X POST "$BASE/incidents/$TENANT/$ID/notes" -H "$AUTH" -H "Content-Type: application/json" \
     -H "Idempotency-Key: note-$ID-1" -d '{"body":"Checked ... Found ... Recommend ...","expectedVersion":3}'
```

The shape of a working bot, in order: list -> claim -> get -> (diagnostics) -> note -> propose or act -> heartbeat while working
-> release or hand off. `docs/agents/reference-triage-agent.mjs` does exactly this and is a good base:

```bash
VOXSHIFT_URL=https://www.directrouting.online VOXSHIFT_TOKEN=vxs_agent_... node docs/agents/reference-triage-agent.mjs
```

Where an LLM goes: replace the `diagnose(context)` function with a call to your model, giving it the incident JSON plus
`SKILL.md` as the system prompt, and have it return the note text, the proposals it wants to make and its confidence. Keep the
plumbing (leases, idempotency keys, version checks) in code, not in the model.

Full endpoint list: [AGENTS.md](AGENTS.md) sections 2 to 6 (incidents) and [SERVICE-REQUEST-AGENTS.md](SERVICE-REQUEST-AGENTS.md)
(`/api/agent/v1/service-requests`).

## 5. Way C: wake the bot with events

Poll `GET /api/agent/v1/events?after=<last id>`; keep the returned `next`. Events are kept 14 days. Or add a webhook (section
2, step 5): Voxshift POSTs each event as JSON with `X-Voxshift-Timestamp` and
`X-Voxshift-Signature: sha256=<HMAC-SHA256(secret, "<timestamp>.<raw body>")>`. Check the signature, reject timestamps older than
5 minutes, and de-duplicate by event id (delivery is at-least-once). A webhook turns itself off after 12 failures in a row.

Useful events: `incident.created`, `incident.assist_requested` (a person asked this assistant to look; payload `question`),
`proposal.decided`, `claim.revoked`, `sla.at_risk`, `sr.created`, `sr.proposal.decided`.

## 6. First run on a test customer (checklist)

1. Customer: a test customer with Managed Services on; assistant enabled; autonomy at Observe/Suggest.
2. On the customer, use **Incidents -> Add demo incidents** (sandbox customers, Super Admin) to get realistic incidents.
3. Run the bot against one unassigned incident. Confirm: it claimed it; the timeline shows one note from "Name (AI)"; the
   claim was released or handed off; nothing customer-visible was sent.
4. Open the incident's **Assistant** card: read any proposal; approve one customer update and see how it appears.
5. Raise the diagnostics autonomy to Act alone and try `run_diagnostic` through the bot; try "Ask an assistant" from the incident.
6. For service requests: create a voicemail change request on the test customer, let the bot prepare it, check the **exact
   commands** in its deploy proposal, approve onto your own tenant session, and confirm the request moves to Deployed only
   after the re-check. (This path has not yet been exercised against a real tenant; do it on a test customer first.)
7. Pull the plug once: set the assistant to **paused**, and confirm the bot's writes stop.

## 7. Going live

- [ ] Token stored in a secret store, 90-day expiry noted in a calendar, IP allow-list set if the bot has a fixed address.
- [ ] Autonomy reviewed per customer; customer updates and deploys left at Suggest/Act with approval.
- [ ] The people who will approve proposals know where they appear (Assistant card on the incident or request; email to engineers).
- [ ] The skill is loaded and the bot's system prompt does not tell it to bypass any rule in it.
- [ ] A named person owns the bot: reviews its notes weekly and adjusts autonomy.
- [ ] You tested the kill switches.

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| 401 on every call | Token revoked, expired, mistyped; assistant paused or disabled; global kill switch on |
| Bot sees no incidents | Assistant not enabled for that customer; Managed Services or the customer's assistants switch off; scopes lack `read` |
| 403 `propose_instead` | Autonomy for that action is below Act alone: propose the step, or raise the level on purpose |
| 409 `taken_over` | A person took the incident over; the bot must wait for a hand-back |
| 409 `stale` | The incident changed since it was read: read it again |
| 409 `in_flight` | Same Idempotency-Key still running: wait |
| Deploy refused (`outside_window`, `whatif_not_clean`, `plan_changed`, `no_session`) | A guardrail working; see SERVICE-REQUEST-AGENTS.md. The bot should hand over |
| 429 | Over 240 requests a minute: poll events, not the list |
| Webhook never arrives | Webhook switched off after 12 failures ("Switch on" on the Webhooks tab); check your signature code uses the raw body |
| Customer update not sent | It is a proposal: a person must approve it |

## 9. Security notes

- Tokens are stored only as a hash; treat one like a password. Revoke a token the moment you suspect it leaked.
- Bot-written text is data to everyone who reads it, and customer text is data to the bot: the skill tells the bot never to obey
  instructions found in incident content. Do not weaken that in your own prompt.
- A bot can never reach a customer's tenant itself: the only live change is `deploy_request`, run as the approving person on their
  own session, with the plan fingerprint checked and a clean live re-check before the request is marked Deployed.
- Everything is on the timeline and in the audit log with the assistant as the actor.
