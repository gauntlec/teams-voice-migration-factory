# Voxshift incident tools over MCP

`apps/mcp` is an [MCP](https://modelcontextprotocol.io) server that exposes the agent API
([AGENTS.md](AGENTS.md)) as tools, so Claude (Desktop, Code, or any MCP client or agent runtime) can work
incidents natively, as an assistant, with the same limits as any other agent: the token's scopes, the
customer's autonomy for that agent, a held lease for changes, proposals for what it may not do alone, and
everything on the timeline as "Name (AI)". It adds nothing the REST API cannot do.

## Set it up

1. A Super Admin creates an assistant on **Administration -> Assistants**, adds a **token** (scopes `read`,
   `note`, `propose`; add `act` only if it may change incidents directly), and **allows it on a customer**
   with the autonomy you want. New customers start at suggest-only.
2. Build the server once (`npm run build --workspace @tvmf/mcp`, output `apps/mcp/dist/main.js`).
3. Tell your MCP client to run it over stdio with two environment variables:

```json
{
  "mcpServers": {
    "voxshift": {
      "command": "node",
      "args": ["/path/to/teams-voice-migration-factory/apps/mcp/dist/main.js"],
      "env": { "VOXSHIFT_URL": "https://www.directrouting.online", "VOXSHIFT_TOKEN": "vxs_agent_..." }
    }
  }
}
```

`VOXSHIFT_URL` is the Voxshift address (no `/api`); the token is shown once when created. Keep it out of
version control. A token that is revoked, expired or paused stops working at once (the tools say so).

## Tools

| Tool | What it does | Needs |
|---|---|---|
| `list_incidents` | the queue across the customers it may work; `assigned` = `unassigned` or `me` | `read` |
| `get_incident` | record, full timeline, items, known errors, similar incidents, checks run and worth running, claim, proposals, and **your autonomy** | `read` |
| `claim_incident` / `renew_claim` / `release_incident` | take, keep and give up the lease on an incident | `note`; triage >= Suggest |
| `add_internal_note` | a note only the MSP team sees | `note`; internal notes >= Suggest |
| `change_status` / `set_priority` / `link_item` | change the incident directly | `act`, a held lease, and "act alone" for that class; otherwise `propose_action` |
| `list_runbooks` / `run_diagnostic` / `list_diagnostics` | the read-only checks ([DIAGNOSTICS.md](DIAGNOSTICS.md)) | `note`, a held lease; diagnostics at "act alone", or an approved proposal |
| `propose_action` / `list_proposals` / `report_proposal_result` | put a step in front of a person; after approval of an `external` step, report on it | `propose` |
| `hand_off` | release the lease and give the team what you tried, found, recommend and how sure you are | `note` |
| `get_events` | what happened since the last event you saw (includes `incident.assist_requested`, a person asking you to look at an incident) | `read` |

Every write sends an `Idempotency-Key` (the one you pass as `idempotencyKey`, or a fresh one), and the
`expectedVersion` options stop a change landing on an incident that has moved. When the API refuses, the
tool result says why and what to do: `propose_instead` (use `propose_action`), `taken_over` (a person has
it: stop), `stale` (read it again).

There is one prompt, `work_incident` (arguments: `tenantId`, `incidentId`): a safe order of work for one
incident (read, claim, check, note, propose, hand off; never tell the customer anything directly).

## Asking an assistant from the incident page

On an incident, engineers can **Ask an assistant** and give it a question. For the built-in assistants
([BUILTIN-AGENTS.md](BUILTIN-AGENTS.md)) it is done straight away within their autonomy. For any other
assistant, including one connected through this server, the request arrives as an `incident.assist_requested`
event (`question`, `askedBy`), through the events feed or its webhook, and a note "Asked Name (AI): ..." is left
on the timeline. The assistant answers with an internal note or a proposal.

## Not included

Live tenant actions (nothing here touches the customer's Teams tenant), service-request tools (chunk 7), and an
HTTP transport (stdio only for now; a remote MCP endpoint would sit behind the same token).
